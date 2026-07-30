import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isMarketDay,
  isAfterMarketClose,
  getEasternDateStr,
  getLatestCompletedMarketDate,
} from '../lib/market-calendar';
import { validateSnapshot, formatAsOfLabel, buildSnapshotsForDates } from '../lib/snapshot-builder';
import { buildHistorySeries } from '../lib/history';
import { PORTFOLIOS } from '../lib/portfolios';
import { SAMPLE_START_PRICES } from './fixtures/sample-prices';
import type { ContestConfig, DailyBar } from '../lib/types';
import type { MarketSnapshot } from '../lib/snapshot';
import type { MarketDataProvider } from '../lib/provider';
// Coinbase module is mocked so buildSnapshotsForDates never hits the network in tests.
import { fetchCoinbaseDailyClose } from '../lib/coinbase';
vi.mock('../lib/coinbase', () => ({ fetchCoinbaseDailyClose: vi.fn() }));

const CRYPTO_PRICES = {
  'BTC/USD': SAMPLE_START_PRICES['BTC/USD'],
  'ETH/USD': SAMPLE_START_PRICES['ETH/USD'],
  'SOL/USD': SAMPLE_START_PRICES['SOL/USD'],
};

// Reset all mocks and restore Coinbase default before each test.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchCoinbaseDailyClose).mockResolvedValue(CRYPTO_PRICES);
});

/**
 * Mock provider whose historical-bar methods return a flat close price
 * (from SAMPLE_START_PRICES, or `overrides` per date) for every requested
 * symbol on every date present in `datesWithPrices`.
 */
function makeHistoricalMockProvider(
  datesWithPrices: Record<string, Record<string, number>>,
): MarketDataProvider {
  const barsFor = (symbols: string[]): Record<string, DailyBar[]> => {
    const result: Record<string, DailyBar[]> = {};
    for (const sym of symbols) {
      result[sym] = Object.entries(datesWithPrices)
        .filter(([, prices]) => prices[sym] !== undefined)
        .map(([date, prices]) => ({
          date, open: prices[sym], high: prices[sym], low: prices[sym], close: prices[sym],
        }));
    }
    return result;
  };

  return {
    getLatestPrices: vi.fn().mockResolvedValue(SAMPLE_START_PRICES),
    getDailyBars: vi.fn().mockResolvedValue([]),
    getDailyBarsBatch: vi.fn(async (symbols: string[]) => barsFor(symbols)),
    getCryptoDailyCloseBatch: vi.fn(async (symbols: string[]) => barsFor(symbols)),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDate(isoStr: string): Date {
  return new Date(isoStr);
}

/** Build a minimal valid snapshot for testing. */
function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    snapshotVersion: 1,
    generatedAt: '2026-07-29T20:30:00.000Z',
    asOfMarketDate: '2026-07-29',
    asOfLabel: 'Market close July 29, 2026',
    status: 'complete',
    prices: { ...SAMPLE_START_PRICES },
    benchmark: {
      startPrice: 500,
      quantity: 20,
      currentPrice: 525,
      totalValue: 10500,
      returnPct: 5,
    },
    portfolios: [],
    chartData: [{ date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 }],
    metadata: {
      priceProvider: 'Twelve Data',
      assetsRequested: 11,
      assetsResolved: 11,
      durationMs: 1500,
    },
    ...overrides,
  };
}

const SAMPLE_CONFIG: ContestConfig = {
  contestName: 'Test Contest',
  officialPurchaseTimestamp: '2026-07-24T16:00:00-04:00',
  endTimestamp: '2026-12-31T16:00:00-05:00',
  startingValue: 10000,
  benchmarkSymbol: 'SPY',
  startPrices: SAMPLE_START_PRICES,
};

// ── formatAsOfLabel ───────────────────────────────────────────────────────────

describe('formatAsOfLabel', () => {
  it('formats a weekday date correctly', () => {
    expect(formatAsOfLabel('2026-07-29')).toBe('Market close July 29, 2026');
  });
  it('formats end-of-year correctly', () => {
    expect(formatAsOfLabel('2026-12-31')).toBe('Market close December 31, 2026');
  });
});

// ── validateSnapshot ──────────────────────────────────────────────────────────

describe('validateSnapshot — success', () => {
  it('returns no errors for a complete snapshot', () => {
    const snap = makeSnapshot({
      portfolios: [
        {
          portfolio: PORTFOLIOS[0],
          holdings: [],
          totalValue: 11000,
          gainLoss: 1000,
          returnPct: 10,
          rank: 1,
          vsSpyPct: 5,
          bestHolding: null,
          worstHolding: null,
        },
      ],
    });
    const errs = validateSnapshot(snap);
    expect(errs).toHaveLength(0);
  });
});

describe('validateSnapshot — missing price', () => {
  it('reports an error when a symbol is absent', () => {
    const prices = { ...SAMPLE_START_PRICES };
    delete (prices as Record<string, number>)['IREN'];
    const snap = makeSnapshot({ prices });
    const errs = validateSnapshot(snap);
    expect(errs.some((e) => e.includes('IREN'))).toBe(true);
  });
});

describe('validateSnapshot — null benchmark', () => {
  it('reports an error when benchmark totalValue is null', () => {
    const snap = makeSnapshot({
      benchmark: {
        startPrice: 500, quantity: 20, currentPrice: null,
        totalValue: null, returnPct: null,
      },
    });
    const errs = validateSnapshot(snap);
    expect(errs.some((e) => e.includes('Benchmark'))).toBe(true);
  });
});

describe('validateSnapshot — null portfolio value', () => {
  it('reports an error when a portfolio totalValue is null', () => {
    const snap = makeSnapshot({
      portfolios: [
        {
          portfolio: PORTFOLIOS[0],
          holdings: [],
          totalValue: null,
          gainLoss: null,
          returnPct: null,
          rank: 1,
          vsSpyPct: null,
          bestHolding: null,
          worstHolding: null,
        },
      ],
    });
    const errs = validateSnapshot(snap);
    expect(errs.some((e) => e.includes('chatgpt'))).toBe(true);
  });
});

describe('validateSnapshot — empty chartData', () => {
  it('reports an error when chartData is empty', () => {
    const snap = makeSnapshot({ chartData: [] });
    const errs = validateSnapshot(snap);
    expect(errs.some((e) => e.includes('chartData'))).toBe(true);
  });
});

// ── buildSnapshotsForDates — catch-up builder ─────────────────────────────────

describe('buildSnapshotsForDates — same trading date invoked twice', () => {
  it('replaces the last chart point instead of appending a duplicate', async () => {
    const prevSnap = makeSnapshot({
      asOfMarketDate: '2026-07-29',
      chartData: [
        { date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
        { date: '2026-07-29', chatgpt: 1, claude: 1, gemini: 1, spy: 1 },
      ],
    });

    const mockProvider = makeHistoricalMockProvider({ '2026-07-29': SAMPLE_START_PRICES });

    const [snap] = await buildSnapshotsForDates(SAMPLE_CONFIG, mockProvider, prevSnap, ['2026-07-29']);

    // Chart should still have exactly 2 points (start + the re-run date), not 3
    expect(snap.chartData).toHaveLength(2);
    expect(snap.chartData[0].date).toBe('2026-07-24');
    expect(snap.chartData[1].date).toBe('2026-07-29');
  });
});

describe('buildSnapshotsForDates — catch-up appends missing trading days chronologically', () => {
  it('produces one snapshot per missing date, each extending the chart', async () => {
    const prevSnap = makeSnapshot({
      asOfMarketDate: '2026-07-28',
      chartData: [
        { date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
        { date: '2026-07-28', chatgpt: 2, claude: 2, gemini: 2, spy: 2 },
      ],
    });

    const mockProvider = makeHistoricalMockProvider({
      '2026-07-29': SAMPLE_START_PRICES,
      '2026-07-30': SAMPLE_START_PRICES,
    });

    const snapshots = await buildSnapshotsForDates(
      SAMPLE_CONFIG, mockProvider, prevSnap, ['2026-07-29', '2026-07-30'],
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].asOfMarketDate).toBe('2026-07-29');
    expect(snapshots[0].chartData.map((p) => p.date)).toEqual(['2026-07-24', '2026-07-28', '2026-07-29']);
    expect(snapshots[1].asOfMarketDate).toBe('2026-07-30');
    expect(snapshots[1].chartData.map((p) => p.date)).toEqual(['2026-07-24', '2026-07-28', '2026-07-29', '2026-07-30']);
    // No date appears twice across the final chart
    const uniqueDates = new Set(snapshots[1].chartData.map((p) => p.date));
    expect(uniqueDates.size).toBe(snapshots[1].chartData.length);
  });
});

describe('buildSnapshotsForDates — first run ever pins the start date to zero', () => {
  it('builds full history from the contest start and fetches historical bars', async () => {
    const mockProvider = makeHistoricalMockProvider({
      '2026-07-24': SAMPLE_START_PRICES,
      '2026-07-27': SAMPLE_START_PRICES,
    });

    const snapshots = await buildSnapshotsForDates(
      SAMPLE_CONFIG, mockProvider, null, ['2026-07-24', '2026-07-27'],
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].chartData).toEqual([
      { date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
    ]);
    expect(snapshots[1].chartData.map((p) => p.date)).toEqual(['2026-07-24', '2026-07-27']);
    // Stocks come from Twelve Data provider
    expect(mockProvider.getDailyBarsBatch).toHaveBeenCalled();
    // Crypto never touches Twelve Data — Coinbase handles it
    expect(mockProvider.getCryptoDailyCloseBatch).not.toHaveBeenCalled();
    expect(vi.mocked(fetchCoinbaseDailyClose)).toHaveBeenCalled();
  });
});

// ── getEasternDateStr ─────────────────────────────────────────────────────────

describe('getEasternDateStr', () => {
  it('returns correct ET date from a UTC datetime (EDT, UTC-4)', () => {
    // 2026-07-29 00:30 UTC = 2026-07-28 20:30 ET (EDT)
    expect(getEasternDateStr(makeDate('2026-07-29T00:30:00Z'))).toBe('2026-07-28');
  });

  it('returns correct ET date from a UTC datetime (EST, UTC-5)', () => {
    // 2026-12-31 04:30 UTC = 2026-12-30 23:30 ET (EST)
    expect(getEasternDateStr(makeDate('2026-12-31T04:30:00Z'))).toBe('2026-12-30');
  });

  it('returns the current ET date when the UTC day has rolled over', () => {
    // 2026-07-29 20:30 UTC = 2026-07-29 16:30 ET
    expect(getEasternDateStr(makeDate('2026-07-29T20:30:00Z'))).toBe('2026-07-29');
  });
});

// ── isAfterMarketClose ────────────────────────────────────────────────────────

describe('isAfterMarketClose', () => {
  it('returns false at 3:00 PM ET (before close)', () => {
    // 3 PM ET on a summer day (EDT) = 19:00 UTC
    expect(isAfterMarketClose(makeDate('2026-07-29T19:00:00Z'))).toBe(false);
  });

  it('returns false at exactly 4:19 PM ET', () => {
    // 4:19 PM EDT = 20:19 UTC
    expect(isAfterMarketClose(makeDate('2026-07-29T20:19:00Z'))).toBe(false);
  });

  it('returns true at exactly 4:20 PM ET', () => {
    // 4:20 PM EDT = 20:20 UTC
    expect(isAfterMarketClose(makeDate('2026-07-29T20:20:00Z'))).toBe(true);
  });

  it('returns true at 5:00 PM ET', () => {
    // 5 PM EDT = 21:00 UTC
    expect(isAfterMarketClose(makeDate('2026-07-29T21:00:00Z'))).toBe(true);
  });

  it('handles EST (winter time) — 4:20 PM ET = 21:20 UTC', () => {
    // December: 4:20 PM EST = 21:20 UTC
    expect(isAfterMarketClose(makeDate('2026-12-01T21:20:00Z'))).toBe(true);
    expect(isAfterMarketClose(makeDate('2026-12-01T21:19:00Z'))).toBe(false);
  });
});

// ── isMarketDay ───────────────────────────────────────────────────────────────

describe('isMarketDay', () => {
  it('returns false on Saturday', () => {
    // 2026-08-01 is a Saturday
    expect(isMarketDay(makeDate('2026-08-01T14:00:00Z'))).toBe(false);
  });

  it('returns false on Sunday', () => {
    // 2026-08-02 is a Sunday
    expect(isMarketDay(makeDate('2026-08-02T14:00:00Z'))).toBe(false);
  });

  it('returns true on a weekday that is not a holiday', () => {
    // 2026-07-29 is a Wednesday
    expect(isMarketDay(makeDate('2026-07-29T14:00:00Z'))).toBe(true);
  });

  it('returns false on Labor Day 2026 (2026-09-07, Monday)', () => {
    expect(isMarketDay(makeDate('2026-09-07T14:00:00Z'))).toBe(false);
  });

  it('returns false on Thanksgiving 2026 (2026-11-26, Thursday)', () => {
    expect(isMarketDay(makeDate('2026-11-26T14:00:00Z'))).toBe(false);
  });

  it('returns false on Christmas 2026 (2026-12-25, Friday)', () => {
    expect(isMarketDay(makeDate('2026-12-25T14:00:00Z'))).toBe(false);
  });

  it('returns true the day after Thanksgiving', () => {
    // 2026-11-27 (Friday) — market is open (short day, but not a holiday)
    expect(isMarketDay(makeDate('2026-11-27T14:00:00Z'))).toBe(true);
  });
});

// ── getLatestCompletedMarketDate ──────────────────────────────────────────────

describe('getLatestCompletedMarketDate', () => {
  it('returns today when it is a market day and after 4:20 PM ET (EDT)', () => {
    // Wednesday July 29 at 5 PM EDT = 21:00 UTC
    expect(getLatestCompletedMarketDate(makeDate('2026-07-29T21:00:00Z'))).toBe('2026-07-29');
  });

  it('returns yesterday when today is a market day but before 4:20 PM ET', () => {
    // Wednesday July 29 at 10 AM EDT = 14:00 UTC → before close
    // Previous market day = Tuesday July 28
    expect(getLatestCompletedMarketDate(makeDate('2026-07-29T14:00:00Z'))).toBe('2026-07-28');
  });

  it('returns Friday when invoked on Saturday', () => {
    // Saturday Aug 1, 2026 at noon UTC
    expect(getLatestCompletedMarketDate(makeDate('2026-08-01T16:00:00Z'))).toBe('2026-07-31');
  });

  it('returns Friday when invoked on Sunday', () => {
    // Sunday Aug 2, 2026
    expect(getLatestCompletedMarketDate(makeDate('2026-08-02T16:00:00Z'))).toBe('2026-07-31');
  });

  it('returns Friday (not Labor Day Monday) when invoked the Tuesday after', () => {
    // Tuesday Sep 8, 2026 at 10 AM ET = 14:00 UTC (before close)
    // Sep 7 = Labor Day (holiday), Sep 6 = Sunday, Sep 5 = Saturday → Sep 4 = Friday
    expect(getLatestCompletedMarketDate(makeDate('2026-09-08T14:00:00Z'))).toBe('2026-09-04');
  });
});

// ── Chart duplicate-point prevention ─────────────────────────────────────────

describe('chart duplicate-point prevention', () => {
  it('buildHistorySeries produces exactly one point per date in the input', () => {
    const dates = ['2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27'];
    const filled: Record<string, Record<string, number>> = {};
    for (const [sym, price] of Object.entries(SAMPLE_START_PRICES)) {
      filled[sym] = {};
      for (const d of dates) filled[sym][d] = price;
    }
    const series = buildHistorySeries(dates, filled, PORTFOLIOS, SAMPLE_CONFIG);
    expect(series).toHaveLength(4);
    const uniqueDates = new Set(series.map((p) => p.date));
    expect(uniqueDates.size).toBe(4);
  });

  it('snapshot chartData has no duplicate dates', () => {
    const chartData = [
      { date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
      { date: '2026-07-25', chatgpt: 1, claude: 1, gemini: 1, spy: 1 },
      { date: '2026-07-26', chatgpt: 2, claude: 2, gemini: 2, spy: 2 },
    ];
    const uniqueDates = new Set(chartData.map((p) => p.date));
    expect(uniqueDates.size).toBe(chartData.length);
  });
});

// ── Stateless across separate serverless invocations ─────────────────────────

describe('buildSnapshotsForDates — stateless across separate invocations', () => {
  it('chains chart correctly when each invocation receives prevSnapshot from persistence only', async () => {
    // Invocation A: a cold serverless function builds July 24 + July 29 from scratch.
    const providerA = makeHistoricalMockProvider({
      '2026-07-24': SAMPLE_START_PRICES,
      '2026-07-29': SAMPLE_START_PRICES,
    });
    const snapsA = await buildSnapshotsForDates(
      SAMPLE_CONFIG, providerA, null, ['2026-07-24', '2026-07-29'],
    );
    // The July 29 snapshot is what would be written to Vercel Blob.
    const savedToBlob = snapsA[snapsA.length - 1];

    // Invocation B: a completely separate serverless instance — providerA is gone.
    // The only durable input is savedToBlob (read from Blob at startup).
    const providerB = makeHistoricalMockProvider({ '2026-07-30': SAMPLE_START_PRICES });
    const [snapB] = await buildSnapshotsForDates(
      SAMPLE_CONFIG, providerB, savedToBlob, ['2026-07-30'],
    );

    expect(snapB.asOfMarketDate).toBe('2026-07-30');
    // Chart grew from the Blob snapshot, not from any in-memory state left by invocation A.
    expect(snapB.chartData.map((p) => p.date)).toEqual(['2026-07-24', '2026-07-29', '2026-07-30']);
    // Each stock provider was consulted exactly once — no cross-invocation sharing.
    expect(providerA.getDailyBarsBatch).toHaveBeenCalledTimes(1);
    expect(providerB.getDailyBarsBatch).toHaveBeenCalledTimes(1);
    // Crypto never goes through either provider — it uses Coinbase independently.
    expect(providerA.getCryptoDailyCloseBatch).not.toHaveBeenCalled();
    expect(providerB.getCryptoDailyCloseBatch).not.toHaveBeenCalled();
    // Coinbase was called once per date: Jul 24, Jul 29 (inv A) + Jul 30 (inv B) = 3
    expect(vi.mocked(fetchCoinbaseDailyClose)).toHaveBeenCalledTimes(3);
  });
});

// ── Crypto source isolation ───────────────────────────────────────────────────

describe('buildSnapshotsForDates — crypto never calls Twelve Data', () => {
  it('routes BTC/USD, ETH/USD, SOL/USD to Coinbase and never to the stock provider', async () => {
    const provider = makeHistoricalMockProvider({
      '2026-07-24': SAMPLE_START_PRICES,
      '2026-07-29': SAMPLE_START_PRICES,
    });

    await buildSnapshotsForDates(SAMPLE_CONFIG, provider, null, ['2026-07-24', '2026-07-29']);

    // Twelve Data provider must never receive crypto symbols
    expect(provider.getCryptoDailyCloseBatch).not.toHaveBeenCalled();
    const stockCallArgs = (provider.getDailyBarsBatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(stockCallArgs).not.toContain('BTC/USD');
    expect(stockCallArgs).not.toContain('ETH/USD');
    expect(stockCallArgs).not.toContain('SOL/USD');

    // Coinbase must have been called for each date with the crypto symbols
    expect(vi.mocked(fetchCoinbaseDailyClose)).toHaveBeenCalledWith(
      expect.arrayContaining(['BTC/USD', 'ETH/USD', 'SOL/USD']),
      '2026-07-24',
    );
    expect(vi.mocked(fetchCoinbaseDailyClose)).toHaveBeenCalledWith(
      expect.arrayContaining(['BTC/USD', 'ETH/USD', 'SOL/USD']),
      '2026-07-29',
    );
    expect(vi.mocked(fetchCoinbaseDailyClose)).toHaveBeenCalledTimes(2);
  });

  it('resulting snapshot contains Coinbase-sourced crypto prices', async () => {
    const coinbasePrices = { 'BTC/USD': 99_000, 'ETH/USD': 4_000, 'SOL/USD': 250 };
    vi.mocked(fetchCoinbaseDailyClose).mockResolvedValue(coinbasePrices);

    const provider = makeHistoricalMockProvider({ '2026-07-29': SAMPLE_START_PRICES });
    const [snap] = await buildSnapshotsForDates(SAMPLE_CONFIG, provider, null, ['2026-07-29']);

    expect(snap.prices['BTC/USD']).toBe(99_000);
    expect(snap.prices['ETH/USD']).toBe(4_000);
    expect(snap.prices['SOL/USD']).toBe(250);
  });
});

// ── No client-side API calls ──────────────────────────────────────────────────

describe('frontend — no market-provider imports', () => {
  it('Dashboard does not import twelve-data or provider', async () => {
    // Import the module's source text to check for forbidden imports
    const fs = await import('fs');
    const src = fs.readFileSync('components/Dashboard.tsx', 'utf8');
    expect(src).not.toContain('twelve-data');
    expect(src).not.toContain('createProvider');
    expect(src).not.toContain('getLatestPrices');
    expect(src).not.toContain("fetch('/api/market-data");
    expect(src).not.toContain('fetch(`/api/market-data');
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('useEffect');
  });

  it('Hero does not poll for market data', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('components/Hero.tsx', 'utf8');
    expect(src).not.toContain('fetch');
    expect(src).not.toContain('twelve-data');
  });
});
