import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isMarketDay,
  isAfterMarketClose,
  getEasternDateStr,
  getLatestCompletedMarketDate,
} from '../lib/market-calendar';
import { validateSnapshot, formatAsOfLabel, buildMarketSnapshot } from '../lib/snapshot-builder';
import { buildHistorySeries } from '../lib/history';
import { PORTFOLIOS } from '../lib/portfolios';
import { SAMPLE_START_PRICES } from './fixtures/sample-prices';
import type { ContestConfig } from '../lib/types';
import type { MarketSnapshot } from '../lib/snapshot';
import type { MarketDataProvider } from '../lib/provider';

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

// ── buildMarketSnapshot — idempotency ─────────────────────────────────────────

describe('buildMarketSnapshot — duplicate same-day invocation', () => {
  it('replaces the last chart point instead of appending a duplicate', async () => {
    const prevSnap = makeSnapshot({
      asOfMarketDate: '2026-07-29',
      chartData: [
        { date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
        { date: '2026-07-29', chatgpt: 1, claude: 1, gemini: 1, spy: 1 },
      ],
    });

    // Mock provider returning prices slightly different from prevSnap
    const mockProvider: MarketDataProvider = {
      getLatestPrices: vi.fn().mockResolvedValue(SAMPLE_START_PRICES),
      getDailyBars: vi.fn().mockResolvedValue([]),
      getDailyBarsBatch: vi.fn().mockResolvedValue({}),
      getCryptoDailyCloseBatch: vi.fn().mockResolvedValue({}),
    };

    // Mock getEasternDateStr to return today = 2026-07-29 (same as prev snapshot)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T21:00:00Z')); // 5 PM ET (after close)

    const snap = await buildMarketSnapshot(SAMPLE_CONFIG, mockProvider, prevSnap);

    // Chart should still have exactly 2 points (start + today), not 3
    expect(snap.chartData).toHaveLength(2);
    expect(snap.chartData[0].date).toBe('2026-07-24');
    expect(snap.chartData[1].date).toBe('2026-07-29');

    vi.useRealTimers();
  });
});

describe('buildMarketSnapshot — new day appends chart point', () => {
  it('appends a new point for a new trading date', async () => {
    const prevSnap = makeSnapshot({
      asOfMarketDate: '2026-07-28',
      chartData: [
        { date: '2026-07-24', chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
        { date: '2026-07-28', chatgpt: 2, claude: 2, gemini: 2, spy: 2 },
      ],
    });

    const mockProvider: MarketDataProvider = {
      getLatestPrices: vi.fn().mockResolvedValue(SAMPLE_START_PRICES),
      getDailyBars: vi.fn().mockResolvedValue([]),
      getDailyBarsBatch: vi.fn().mockResolvedValue({}),
      getCryptoDailyCloseBatch: vi.fn().mockResolvedValue({}),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T21:00:00Z')); // 5 PM ET on July 29

    const snap = await buildMarketSnapshot(SAMPLE_CONFIG, mockProvider, prevSnap);

    expect(snap.chartData).toHaveLength(3);
    expect(snap.chartData[2].date).toBe('2026-07-29');
    // getDailyBarsBatch should NOT have been called (we have prev chart data)
    expect(mockProvider.getDailyBarsBatch).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('buildMarketSnapshot — first run fetches full history', () => {
  it('calls getDailyBarsBatch when no previous chart data', async () => {
    const mockProvider: MarketDataProvider = {
      getLatestPrices: vi.fn().mockResolvedValue(SAMPLE_START_PRICES),
      getDailyBars: vi.fn().mockResolvedValue([]),
      getDailyBarsBatch: vi.fn().mockResolvedValue({}),
      getCryptoDailyCloseBatch: vi.fn().mockResolvedValue({}),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T21:00:00Z'));

    await buildMarketSnapshot(SAMPLE_CONFIG, mockProvider, null);

    expect(mockProvider.getDailyBarsBatch).toHaveBeenCalled();
    expect(mockProvider.getCryptoDailyCloseBatch).toHaveBeenCalled();

    vi.useRealTimers();
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
