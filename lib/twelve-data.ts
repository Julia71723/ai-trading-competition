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
