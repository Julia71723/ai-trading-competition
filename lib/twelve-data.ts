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
 * For a given ET calendar date, return the UTC milliseconds that represent 4:00 PM ET.
 * Accounts for EDT (UTC-4, summer) vs EST (UTC-5, winter).
 */
function get4PMETUtcMs(etDateStr: string): number {
  const at20utc = new Date(`${etDateStr}T20:00:00Z`);
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(at20utc),
    10,
  );
  // If 20:00 UTC = 16:00 ET, we're in EDT; otherwise EST → need 21:00 UTC
  return etHour === 16 ? at20utc.getTime() : new Date(`${etDateStr}T21:00:00Z`).getTime();
}

/**
 * From raw hourly bar values (UTC datetimes for crypto), extract one DailyBar per
 * calendar day (ET), using the bar closest to 4:00 PM ET.
 */
function extractDailyAtFourPMET(rawValues: Array<Record<string, string>>): DailyBar[] {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // Group bars by ET calendar date
  const byDate = new Map<string, Array<{ utcMs: number; close: number }>>();
  for (const v of rawValues) {
    const close = parseFloat(v.close);
    if (!isFinite(close) || close <= 0) continue;
    const utcMs = new Date(v.datetime.replace(' ', 'T') + 'Z').getTime();
    const parts = dtf.formatToParts(new Date(utcMs));
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    const etDate = `${year}-${month}-${day}`;
    if (!byDate.has(etDate)) byDate.set(etDate, []);
    byDate.get(etDate)!.push({ utcMs, close });
  }

  const result: DailyBar[] = [];
  for (const [etDate, bars] of byDate.entries()) {
    const target = get4PMETUtcMs(etDate);
    let best: { utcMs: number; close: number } | null = null;
    let bestDiff = Infinity;
    for (const bar of bars) {
      const diff = Math.abs(bar.utcMs - target);
      if (diff < bestDiff) { bestDiff = diff; best = bar; }
    }
    // Accept bars within 90 minutes of target (1h bars land at :00 each hour)
    if (best && bestDiff <= 90 * 60 * 1000) {
      result.push({ date: etDate, open: best.close, high: best.close, low: best.close, close: best.close });
    }
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
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

    const url =
      `${BASE}/time_series?symbol=${encodeSymbols(symbols)}` +
      `&interval=1day&start_date=${startDate}&end_date=${endDate}` +
      `&outputsize=5000&apikey=${this.apiKey}`;

    const res = await fetchWithTimeout(url, {
      next: { revalidate: 21600 },
    } as RequestInit);

    if (res.status === 429) throw new Error('Twelve Data rate limit hit (history)');
    if (!res.ok) throw new Error(`Twelve Data /time_series returned ${res.status}`);

    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Twelve Data /time_series: unexpected response shape');
    }

    const result: Record<string, DailyBar[]> = {};

    if (symbols.length === 1) {
      const single = raw as { values?: Array<Record<string, string>>; status?: string; message?: string };
      if (single.status === 'error') {
        console.warn(`Twelve Data: error for ${symbols[0]}: ${single.message}`);
        result[symbols[0]] = [];
        return result;
      }
      result[symbols[0]] = normalizeBars(single.values ?? []);
      return result;
    }

    const batch = raw as Record<string, { values?: Array<Record<string, string>>; status?: string; message?: string }>;
    for (const sym of symbols) {
      const entry = batch[sym];
      if (!entry || entry.status === 'error') {
        console.warn(`Twelve Data: missing/error for ${sym}: ${entry?.message ?? 'no data'}`);
        result[sym] = [];
        continue;
      }
      result[sym] = normalizeBars(entry.values ?? []);
    }
    return result;
  }

  async getCryptoDailyCloseBatch(
    symbols: string[],
    startDate: string,
    endDate: string,
  ): Promise<Record<string, DailyBar[]>> {
    if (symbols.length === 0) return {};

    const url =
      `${BASE}/time_series?symbol=${encodeSymbols(symbols)}` +
      `&interval=1h&start_date=${startDate}&end_date=${endDate}` +
      `&outputsize=5000&apikey=${this.apiKey}`;

    const res = await fetchWithTimeout(url, {
      next: { revalidate: 21600 },
    } as RequestInit);

    if (res.status === 429) throw new Error('Twelve Data rate limit hit (crypto hourly)');
    if (!res.ok) throw new Error(`Twelve Data /time_series (1h) returned ${res.status}`);

    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Twelve Data /time_series (1h): unexpected response shape');
    }

    const result: Record<string, DailyBar[]> = {};

    if (symbols.length === 1) {
      const single = raw as { values?: Array<Record<string, string>>; status?: string; message?: string };
      if (single.status === 'error') {
        console.warn(`Twelve Data (hourly): error for ${symbols[0]}: ${single.message}`);
        result[symbols[0]] = [];
        return result;
      }
      result[symbols[0]] = extractDailyAtFourPMET(single.values ?? []);
      return result;
    }

    const batch = raw as Record<string, { values?: Array<Record<string, string>>; status?: string; message?: string }>;
    for (const sym of symbols) {
      const entry = batch[sym];
      if (!entry || entry.status === 'error') {
        console.warn(`Twelve Data (hourly): missing/error for ${sym}: ${entry?.message ?? 'no data'}`);
        result[sym] = [];
        continue;
      }
      result[sym] = extractDailyAtFourPMET(entry.values ?? []);
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
