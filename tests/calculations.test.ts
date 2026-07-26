import { describe, it, expect } from 'vitest';
import { PORTFOLIOS, BENCHMARK, ALL_SYMBOLS } from '../lib/portfolios';
import {
  computeQuantity,
  computePositionValue,
  computeReturnPct,
  computePortfolioContribution,
  computeHoldingState,
  computePortfolioState,
  computeBenchmarkState,
  rankPortfolios,
  findSharedHoldings,
  isContestConfigured,
} from '../lib/calculations';
import { buildMasterTimeline, forwardFillPrices, buildHistorySeries } from '../lib/history';
import {
  SAMPLE_START_PRICES,
  SAMPLE_PRICES_FLAT,
  SAMPLE_PRICES_IREN_DOUBLE,
  SAMPLE_PRICES_ALL_UP_10,
  SAMPLE_PRICES_SPY_UP,
} from './fixtures/sample-prices';
import type { ContestConfig } from '../lib/types';

const SAMPLE_CONFIG: ContestConfig = {
  contestName: 'Test Contest',
  officialPurchaseTimestamp: '2026-07-27T09:30:00-04:00',
  endTimestamp: '2026-12-31T16:00:00-05:00',
  startingValue: 10000,
  benchmarkSymbol: 'SPY',
  startPrices: SAMPLE_START_PRICES,
};

// ── Portfolio structure ────────────────────────────────────────────────────

describe('Portfolio definitions', () => {
  it('each portfolio has exactly 5 holdings', () => {
    for (const p of PORTFOLIOS) {
      expect(p.holdings).toHaveLength(5);
    }
  });

  it('each portfolio allocations total exactly $10,000', () => {
    for (const p of PORTFOLIOS) {
      const total = p.holdings.reduce((s, h) => s + h.allocation, 0);
      expect(total).toBe(10000);
    }
  });

  it('each portfolio weights total exactly 1.0', () => {
    for (const p of PORTFOLIOS) {
      const total = p.holdings.reduce((s, h) => s + h.weight, 0);
      expect(total).toBeCloseTo(1.0, 5);
    }
  });

  it('each weight matches allocation / 10000', () => {
    for (const p of PORTFOLIOS) {
      for (const h of p.holdings) {
        expect(h.weight).toBeCloseTo(h.allocation / 10000, 5);
      }
    }
  });

  it('all required symbols are present in ALL_SYMBOLS', () => {
    const required = [
      'IREN', 'SOL/USD', 'ASTS', 'ETH/USD', 'RKLB',
      'NVDA', 'BTC/USD', 'MU', 'PLTR', 'TSLA', 'SPY',
    ];
    for (const sym of required) {
      expect(ALL_SYMBOLS).toContain(sym);
    }
  });

  it('portfolio IDs are chatgpt, claude, gemini', () => {
    const ids = PORTFOLIOS.map((p) => p.id);
    expect(ids).toContain('chatgpt');
    expect(ids).toContain('claude');
    expect(ids).toContain('gemini');
  });
});

// ── Core math ──────────────────────────────────────────────────────────────

describe('computeQuantity', () => {
  it('computes shares correctly', () => {
    expect(computeQuantity(3000, 10)).toBe(300);
    expect(computeQuantity(2500, 200)).toBe(12.5);
    expect(computeQuantity(1000, 15)).toBeCloseTo(66.6667, 3);
  });
});

describe('computePositionValue', () => {
  it('multiplies quantity by price', () => {
    expect(computePositionValue(300, 10)).toBe(3000);
    expect(computePositionValue(12.5, 240)).toBe(3000);
  });
});

describe('computeReturnPct', () => {
  it('returns 0 when equal', () => {
    expect(computeReturnPct(10000, 10000)).toBe(0);
  });

  it('returns 100 when doubled', () => {
    expect(computeReturnPct(20000, 10000)).toBe(100);
  });

  it('returns -50 when halved', () => {
    expect(computeReturnPct(5000, 10000)).toBe(-50);
  });
});

describe('computePortfolioContribution', () => {
  it('contribution from a $3000 gain on $10000 portfolio is 30%', () => {
    expect(computePortfolioContribution(3000, 10000)).toBe(30);
  });
});

// ── Holding state ──────────────────────────────────────────────────────────

describe('computeHoldingState', () => {
  const holding = PORTFOLIOS[0].holdings[0]; // IREN, $3000, 30%

  it('returns null values when startPrice is missing', () => {
    const hs = computeHoldingState(holding, { 'IREN': null }, {}, 10000);
    expect(hs.startPrice).toBeNull();
    expect(hs.quantity).toBeNull();
    expect(hs.positionValue).toBeNull();
  });

  it('returns null values when currentPrice is missing', () => {
    const hs = computeHoldingState(holding, { 'IREN': 10 }, {}, 10000);
    expect(hs.quantity).toBe(300);
    expect(hs.positionValue).toBeNull();
  });

  it('computes full state when both prices available', () => {
    const hs = computeHoldingState(holding, { 'IREN': 10 }, { 'IREN': 20 }, 10000);
    expect(hs.quantity).toBe(300);
    expect(hs.positionValue).toBe(6000);
    expect(hs.gainLoss).toBe(3000);
    expect(hs.returnPct).toBe(100);
    expect(hs.portfolioContribution).toBe(30);
  });
});

// ── Portfolio state ────────────────────────────────────────────────────────

describe('computePortfolioState', () => {
  const chatgpt = PORTFOLIOS.find((p) => p.id === 'chatgpt')!;

  it('returns 0% when prices equal start prices', () => {
    const state = computePortfolioState(chatgpt, SAMPLE_START_PRICES, SAMPLE_PRICES_FLAT, 10000);
    expect(state.returnPct).toBeCloseTo(0, 5);
    expect(state.totalValue).toBeCloseTo(10000, 2);
    expect(state.gainLoss).toBeCloseTo(0, 2);
  });

  it('returns null totalValue when a price is missing', () => {
    const partialPrices = { ...SAMPLE_START_PRICES };
    delete (partialPrices as Record<string, number>)['IREN'];
    const state = computePortfolioState(chatgpt, SAMPLE_START_PRICES, partialPrices, 10000);
    expect(state.totalValue).toBeNull();
  });

  it('IREN doubling adds +30% contribution to ChatGPT portfolio', () => {
    const state = computePortfolioState(chatgpt, SAMPLE_START_PRICES, SAMPLE_PRICES_IREN_DOUBLE, 10000);
    // IREN: $3000 at $10, now $20 → position $6000, gain $3000
    // Other 4 positions unchanged (total $7000)
    // Portfolio value: $6000 + $7000 = $13000
    expect(state.totalValue).toBeCloseTo(13000, 2);
    expect(state.returnPct).toBeCloseTo(30, 2);
  });

  it('10% rise in all assets gives 10% return', () => {
    for (const p of PORTFOLIOS) {
      const state = computePortfolioState(p, SAMPLE_START_PRICES, SAMPLE_PRICES_ALL_UP_10, 10000);
      expect(state.returnPct).toBeCloseTo(10, 2);
      expect(state.totalValue).toBeCloseTo(11000, 2);
    }
  });

  it('identifies best and worst holdings', () => {
    const state = computePortfolioState(chatgpt, SAMPLE_START_PRICES, SAMPLE_PRICES_IREN_DOUBLE, 10000);
    expect(state.bestHolding?.holding.ticker).toBe('IREN');
    // All others are flat (0%), IREN is +100%
    expect(state.bestHolding?.returnPct).toBeCloseTo(100, 2);
  });
});

// ── Benchmark ──────────────────────────────────────────────────────────────

describe('computeBenchmarkState', () => {
  it('starts at 0% with flat prices', () => {
    const b = computeBenchmarkState(SAMPLE_CONFIG, SAMPLE_PRICES_FLAT);
    expect(b.returnPct).toBeCloseTo(0, 5);
    expect(b.totalValue).toBeCloseTo(10000, 2);
  });

  it('SPY up 5% gives 5% benchmark return', () => {
    const b = computeBenchmarkState(SAMPLE_CONFIG, SAMPLE_PRICES_SPY_UP);
    expect(b.returnPct).toBeCloseTo(5, 3);
    expect(b.totalValue).toBeCloseTo(10500, 2);
  });

  it('normalizes to $10,000 at start regardless of SPY price level', () => {
    const highSpyConfig = { ...SAMPLE_CONFIG, startPrices: { ...SAMPLE_START_PRICES, 'SPY': 600 } };
    const prices = { ...SAMPLE_PRICES_FLAT, 'SPY': 630 };
    const b = computeBenchmarkState(highSpyConfig, prices);
    expect(b.returnPct).toBeCloseTo(5, 3);
  });
});

// ── Ranking ────────────────────────────────────────────────────────────────

describe('rankPortfolios', () => {
  it('ranks by returnPct descending', () => {
    const raw = PORTFOLIOS.map((p) =>
      computePortfolioState(p, SAMPLE_START_PRICES, SAMPLE_PRICES_IREN_DOUBLE, 10000),
    );
    const ranked = rankPortfolios(raw, null);
    // ChatGPT has IREN (30% allocation, 100% gain) → +30% total return
    // Claude and Gemini have no IREN → 0% return
    expect(ranked[0].portfolio.id).toBe('chatgpt');
    expect(ranked[0].rank).toBe(1);
  });

  it('puts null-return portfolios last', () => {
    const raw = PORTFOLIOS.map((p) =>
      computePortfolioState(p, SAMPLE_START_PRICES, {}, 10000),
    );
    const ranked = rankPortfolios(raw, null);
    expect(ranked.every((r) => r.totalValue === null)).toBe(true);
  });

  it('computes vsSpyPct correctly', () => {
    const raw = PORTFOLIOS.map((p) =>
      computePortfolioState(p, SAMPLE_START_PRICES, SAMPLE_PRICES_ALL_UP_10, 10000),
    );
    // SPY also up 10%
    const ranked = rankPortfolios(raw, 10);
    for (const r of ranked) {
      expect(r.vsSpyPct).toBeCloseTo(0, 5);
    }
  });
});

// ── Shared holdings ────────────────────────────────────────────────────────

describe('findSharedHoldings', () => {
  it('detects SOL/USD as held by all three', () => {
    const shared = findSharedHoldings(PORTFOLIOS);
    const sol = shared.find((s) => s.apiSymbol === 'SOL/USD');
    expect(sol).toBeDefined();
    expect(sol?.portfolioIds).toHaveLength(3);
  });

  it('detects NVDA as held by Claude and Gemini', () => {
    const shared = findSharedHoldings(PORTFOLIOS);
    const nvda = shared.find((s) => s.apiSymbol === 'NVDA');
    expect(nvda).toBeDefined();
    expect(nvda?.portfolioIds).toHaveLength(2);
    expect(nvda?.portfolioIds).toContain('claude');
    expect(nvda?.portfolioIds).toContain('gemini');
  });

  it('detects BTC/USD as held by Claude and Gemini', () => {
    const shared = findSharedHoldings(PORTFOLIOS);
    const btc = shared.find((s) => s.apiSymbol === 'BTC/USD');
    expect(btc?.portfolioIds).toContain('claude');
    expect(btc?.portfolioIds).toContain('gemini');
  });

  it('does not list exclusive picks as shared', () => {
    const shared = findSharedHoldings(PORTFOLIOS);
    const symbols = shared.map((s) => s.apiSymbol);
    // IREN, ASTS, RKLB are ChatGPT-exclusive
    expect(symbols).not.toContain('IREN');
    expect(symbols).not.toContain('ASTS');
    expect(symbols).not.toContain('RKLB');
    // MU is Claude-exclusive
    expect(symbols).not.toContain('MU');
    // PLTR, TSLA are Gemini-exclusive
    expect(symbols).not.toContain('PLTR');
    expect(symbols).not.toContain('TSLA');
  });
});

// ── isContestConfigured ────────────────────────────────────────────────────

describe('isContestConfigured', () => {
  it('returns false when any price is null', () => {
    const cfg = { ...SAMPLE_CONFIG, startPrices: { ...SAMPLE_START_PRICES, 'IREN': null } };
    expect(isContestConfigured(cfg)).toBe(false);
  });

  it('returns true when all prices are set', () => {
    expect(isContestConfigured(SAMPLE_CONFIG)).toBe(true);
  });

  it('returns false for empty startPrices', () => {
    const cfg = { ...SAMPLE_CONFIG, startPrices: {} };
    expect(isContestConfigured(cfg)).toBe(false);
  });
});

// ── Historical chart ───────────────────────────────────────────────────────

describe('buildMasterTimeline', () => {
  it('includes start and end dates', () => {
    const dates = buildMasterTimeline('2026-07-27', '2026-07-29');
    expect(dates).toContain('2026-07-27');
    expect(dates).toContain('2026-07-29');
  });

  it('produces daily increments', () => {
    const dates = buildMasterTimeline('2026-07-27', '2026-07-30');
    expect(dates).toEqual(['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30']);
  });

  it('includes weekends', () => {
    // 2026-08-01 is Saturday, 2026-08-02 is Sunday
    const dates = buildMasterTimeline('2026-07-31', '2026-08-03');
    expect(dates).toContain('2026-08-01');
    expect(dates).toContain('2026-08-02');
  });
});

describe('forwardFillPrices (weekend fill)', () => {
  it('carries stock prices forward on weekends', () => {
    const rawPrices = {
      'SPY': { '2026-07-31': 500 },
      'SOL/USD': { '2026-07-31': 200 },
    };
    const assetClasses = { 'SPY': 'stock' as const, 'SOL/USD': 'crypto' as const };
    const dates = ['2026-07-31', '2026-08-01', '2026-08-02'];
    const filled = forwardFillPrices(rawPrices, assetClasses, dates);

    // SPY forward-filled on weekend
    expect(filled['SPY']['2026-08-01']).toBe(500);
    expect(filled['SPY']['2026-08-02']).toBe(500);

    // Crypto not filled (no data on those days)
    expect(filled['SOL/USD']['2026-08-01']).toBeUndefined();
    expect(filled['SOL/USD']['2026-08-02']).toBeUndefined();
  });

  it('does not interpolate — uses last actual value', () => {
    const rawPrices = { 'SPY': { '2026-07-27': 500, '2026-07-30': 510 } };
    const assetClasses = { 'SPY': 'stock' as const };
    const dates = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'];
    const filled = forwardFillPrices(rawPrices, assetClasses, dates);

    // Weekend gets last trading day's price (500), not the next trading day's (510)
    expect(filled['SPY']['2026-07-28']).toBe(500);
    expect(filled['SPY']['2026-07-29']).toBe(500);
    expect(filled['SPY']['2026-07-30']).toBe(510);
  });
});

describe('buildHistorySeries (starting point)', () => {
  it('starts all series at exactly 0%', () => {
    const dates = ['2026-07-27'];
    const filled: Record<string, Record<string, number>> = {};
    for (const [sym, price] of Object.entries(SAMPLE_START_PRICES)) {
      filled[sym] = { '2026-07-27': price };
    }
    const series = buildHistorySeries(dates, filled, PORTFOLIOS, SAMPLE_CONFIG);
    expect(series[0].chatgpt).toBeCloseTo(0, 5);
    expect(series[0].claude).toBeCloseTo(0, 5);
    expect(series[0].gemini).toBeCloseTo(0, 5);
    expect(series[0].spy).toBeCloseTo(0, 5);
  });

  it('all series +10% when all prices rise 10%', () => {
    const dates = ['2026-07-27', '2026-07-28'];
    const filled: Record<string, Record<string, number>> = {};
    for (const [sym, price] of Object.entries(SAMPLE_START_PRICES)) {
      filled[sym] = { '2026-07-27': price, '2026-07-28': price * 1.1 };
    }
    const series = buildHistorySeries(dates, filled, PORTFOLIOS, SAMPLE_CONFIG);
    expect(series[1].chatgpt).toBeCloseTo(10, 2);
    expect(series[1].claude).toBeCloseTo(10, 2);
    expect(series[1].gemini).toBeCloseTo(10, 2);
    expect(series[1].spy).toBeCloseTo(10, 2);
  });

  it('returns null when a price is missing (not zero)', () => {
    const dates = ['2026-07-27'];
    // IREN missing from day 1
    const filled: Record<string, Record<string, number>> = {};
    for (const [sym, price] of Object.entries(SAMPLE_START_PRICES)) {
      if (sym !== 'IREN') filled[sym] = { '2026-07-27': price };
    }
    const series = buildHistorySeries(dates, filled, PORTFOLIOS, SAMPLE_CONFIG);
    // ChatGPT holds IREN — its value should be null
    expect(series[0].chatgpt).toBeNull();
    // Claude and Gemini don't hold IREN — they should be fine
    expect(series[0].claude).toBeCloseTo(0, 5);
    expect(series[0].gemini).toBeCloseTo(0, 5);
  });
});
