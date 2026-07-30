import type { MarketDataProvider } from './provider';
import type { DailyBar } from './types';

const BASE = 'https://api.twelvedata.com';
const FETCH_TIMEOUT_MS = 10_000;

function encodeSymbols(symbols: string[]): string {
  return symbols.map((s) => s.replace(/\//g, '%2F')).join(',');
}

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function normalizeBars(values: Array<Record<string, string>>): DailyBar[] {
  return values
    .map((v) => ({
      date: v.datetime.split(' ')[0],
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : undefined,
    }))
    .filter((b) => isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * For single-date requests, verify that returned bars include the target date.
 * Twelve Data may serve the previous day's close before the requested date's
 * official EOD data has been published — those bars are discarded here so the
 * snapshot validator catches the absence and the cron retries the next morning.
 */
function filterByDate(bars: DailyBar[], targetDate: string, sym: string): DailyBar[] {
  if (bars.length === 0) return bars;
  if (bars.some((b) => b.date === targetDate)) return bars;
  console.warn(
    `[twelve-data] ${sym}: returned bar date "${bars[0].date}" ≠ ` +
    `requested date "${targetDate}" — discarding (data not yet published?)`,
  );
  return [];
}

export class TwelveDataProvider implements MarketDataProvider {
  constructor(private readonly apiKey: string) {}

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};

    const url =
      `${BASE}/price?symbol=${encodeSymbols(symbols)}&apikey=${this.apiKey}`;

    const res = await fetchWithTimeout(url, {
      next: { revalidate: 1800 },
    } as RequestInit);

    if (res.status === 429) throw new Error('Twelve Data rate limit hit');
    if (!res.ok) throw new Error(`Twelve Data /price returned ${res.status}`);

    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Twelve Data /price: unexpected response shape');
    }

    const result: Record<string, number> = {};

    if (symbols.length === 1) {
      const single = raw as Record<string, string>;
      if (!single.price) throw new Error(`Twelve Data: no price for ${symbols[0]}`);
      const v = parseFloat(single.price);
      if (isFinite(v) && v > 0) result[symbols[0]] = v;
      return result;
    }

    const batch = raw as Record<string, { price?: string; status?: string; message?: string }>;
    for (const sym of symbols) {
      const entry = batch[sym];
      if (!entry || entry.status === 'error') continue;
      const v = entry.price ? parseFloat(entry.price) : NaN;
      if (isFinite(v) && v > 0) result[sym] = v;
    }
    return result;
  }

  async getDailyBars(symbol: string, startDate: string, endDate: string): Promise<DailyBar[]> {
    const batch = await this.getDailyBarsBatch([symbol], startDate, endDate);
    return batch[symbol] ?? [];
  }

  async getDailyBarsBatch(
    symbols: string[],
    startDate: string,
    endDate: string,
  ): Promise<Record<string, DailyBar[]>> {
    if (symbols.length === 0) return {};

    // Use `date=` for exact single-day queries; `start_date`/`end_date` for ranges.
    // Same-day start_date=end_date returns "No data is available on the specified dates"
    // on the Twelve Data Basic plan — the `date=` parameter is the correct approach.
    const isSingleDate = startDate === endDate;
    const dateParams = isSingleDate
      ? `&date=${startDate}`
      : `&start_date=${startDate}&end_date=${endDate}&outputsize=5000`;

    const url =
      `${BASE}/time_series?symbol=${encodeSymbols(symbols)}` +
      `&interval=1day${dateParams}` +
      `&apikey=${this.apiKey}`;

    // Log the exact URL (API key redacted) so production logs show the full request.
    const redactedUrl = url.replace(`apikey=${this.apiKey}`, 'apikey=[REDACTED]');
    console.log(
      `[twelve-data] getDailyBarsBatch: ${symbols.length} symbols [${symbols.join(', ')}] ` +
      (isSingleDate ? `date=${startDate}` : `${startDate}→${endDate}`),
    );
    console.log(`[twelve-data] GET ${redactedUrl}`);

    // cache: 'no-store' bypasses the Next.js data cache so every invocation hits
    // Twelve Data directly. A 6-hour cached error or stale empty response would
    // otherwise cause all symbols to silently return empty bars across every retry.
    const res = await fetchWithTimeout(url, { cache: 'no-store' });

    // Log rate-limit headers before reading the body so they appear even if parsing fails.
    const creditLimit     = res.headers.get('X-RateLimit-Limit-Minute');
    const creditRemaining = res.headers.get('X-RateLimit-Remaining-Minute');
    console.log(
      `[twelve-data] HTTP ${res.status} — ` +
      `credits: ${creditRemaining ?? '?'} remaining of ${creditLimit ?? '?'}/min`,
    );

    // Read the body as text first so we can include it in any error message.
    const bodyText = await res.text();

    if (res.status === 429) {
      console.error(`[twelve-data] rate-limit body: ${bodyText.slice(0, 500)}`);
      throw new Error('Twelve Data rate limit hit (history)');
    }
    if (!res.ok) {
      console.error(`[twelve-data] non-OK body (${res.status}): ${bodyText.slice(0, 500)}`);
      throw new Error(
        `Twelve Data /time_series returned HTTP ${res.status}: ${bodyText.slice(0, 300)}`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      console.error(`[twelve-data] non-JSON body: ${bodyText.slice(0, 500)}`);
      throw new Error(`Twelve Data /time_series: non-JSON response (HTTP ${res.status})`);
    }

    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Twelve Data /time_series: unexpected response shape');
    }

    // Twelve Data returns { "status": "error", "message": "...", "code": N } as HTTP 200
    // for invalid API keys, exhausted quotas, and malformed requests.
    // Without this check the batch parser sees batch['IREN'] === undefined for every symbol
    // and silently returns empty bars, which destroys the error trail entirely.
    const maybeTopErr = raw as { status?: string; message?: string; code?: number };
    if (maybeTopErr.status === 'error') {
      console.error(`[twelve-data] API-level error: ${bodyText.slice(0, 500)}`);
      throw new Error(
        `Twelve Data API error: ${maybeTopErr.message ?? 'unknown'} (code: ${maybeTopErr.code ?? 'n/a'})`,
      );
    }

    const result: Record<string, DailyBar[]> = {};

    if (symbols.length === 1) {
      const single = raw as { values?: Array<Record<string, string>>; status?: string; message?: string };
      if (single.status === 'error') {
        throw new Error(`Twelve Data error for ${symbols[0]}: ${single.message ?? 'no data'}`);
      }
      let bars = normalizeBars(single.values ?? []);
      if (bars.length === 0) {
        console.warn(
          `[twelve-data] ${symbols[0]}: status=ok but 0 bars ` +
          (isSingleDate ? `for date ${startDate}` : `for ${startDate}→${endDate}`) +
          ` (data not yet published?)`,
        );
      } else {
        console.log(`[twelve-data] ${symbols[0]}: ${bars.length} bar(s)`);
        if (isSingleDate) bars = filterByDate(bars, startDate, symbols[0]);
      }
      result[symbols[0]] = bars;
      return result;
    }

    // Batch path: collect all per-symbol errors before deciding to throw, so the
    // log shows every failing symbol in one message rather than stopping at the first.
    const batch = raw as Record<string, {
      values?: Array<Record<string, string>>;
      status?: string;
      message?: string;
    }>;
    const batchErrors: string[] = [];
    for (const sym of symbols) {
      const entry = batch[sym];
      if (!entry || entry.status === 'error') {
        const msg = entry?.message ?? 'no entry in batch response';
        console.error(
          `[twelve-data] ${sym}: status=${entry?.status ?? 'missing'} message="${msg}"`,
        );
        batchErrors.push(`${sym} (${msg})`);
        result[sym] = [];
        continue;
      }
      let bars = normalizeBars(entry.values ?? []);
      if (bars.length === 0) {
        console.warn(
          `[twelve-data] ${sym}: status=ok but 0 bars ` +
          (isSingleDate ? `for date ${startDate}` : `for ${startDate}→${endDate}`) +
          ` (data not yet published?)`,
        );
      } else {
        console.log(`[twelve-data] ${sym}: ${bars.length} bar(s)`);
        if (isSingleDate) bars = filterByDate(bars, startDate, sym);
      }
      result[sym] = bars;
    }

    if (batchErrors.length > 0) {
      throw new Error(
        `Twelve Data batch failure: ${batchErrors.length}/${symbols.length} symbol(s) errored — ` +
        batchErrors.join('; '),
      );
    }

    return result;
  }

  /** Fetch a single minute bar at `timestamp` for `symbol`. Used by capture-start-prices. */
  async getMinuteBar(symbol: string, timestamp: string): Promise<DailyBar | null> {
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().replace('T', ' ').slice(0, 16);

    const url =
      `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=1min&start_date=${encodeURIComponent(dateStr)}` +
      `&outputsize=1&apikey=${this.apiKey}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;

    const raw = await res.json() as { values?: Array<Record<string, string>>; status?: string };
    if (raw.status === 'error' || !raw.values?.length) return null;

    const bars = normalizeBars(raw.values);
    return bars[0] ?? null;
  }
}
