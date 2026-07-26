import type { HistoryPoint, ContestConfig } from './types';
import type { Portfolio } from './types';
import { computeQuantity, computePositionValue, computeReturnPct } from './calculations';

/** Produce an array of every calendar date from start through today (inclusive). */
export function buildMasterTimeline(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Forward-fill a price map for stocks (not crypto).
 * For each date in the master timeline, carry the previous available close
 * forward if no actual bar exists for that date.
 *
 * Raw input: symbol → { date → close }
 * Output:    symbol → { date → close }  (gaps filled for stocks only)
 */
export function forwardFillPrices(
  rawPrices: Record<string, Record<string, number>>,
  assetClasses: Record<string, 'stock' | 'crypto'>,
  dates: string[],
): Record<string, Record<string, number>> {
  const filled: Record<string, Record<string, number>> = {};

  for (const symbol of Object.keys(rawPrices)) {
    const raw = rawPrices[symbol];
    const out: Record<string, number> = {};
    let last: number | null = null;

    for (const date of dates) {
      if (raw[date] !== undefined) {
        last = raw[date];
        out[date] = raw[date];
      } else if (assetClasses[symbol] === 'stock' && last !== null) {
        out[date] = last;
      }
      // For crypto with no data: leave undefined (treated as null downstream)
    }

    filled[symbol] = out;
  }

  return filled;
}

/**
 * Convert an array of DailyBar[] into a { date → close } map.
 */
export function barsToDateMap(bars: Array<{ date: string; close: number }>): Record<string, number> {
  const map: Record<string, number> = {};
  for (const bar of bars) {
    map[bar.date] = bar.close;
  }
  return map;
}

/**
 * Build the full history series from date-keyed prices.
 *
 * Returns one HistoryPoint per date in `dates`.
 * The first point (contest start) is always 0% for all series.
 */
export function buildHistorySeries(
  dates: string[],
  filledPrices: Record<string, Record<string, number>>,
  portfolios: Portfolio[],
  config: ContestConfig,
): HistoryPoint[] {
  const startPrices = config.startPrices as Record<string, number>;
  const benchmarkSymbol = config.benchmarkSymbol;
  const startingValue = config.startingValue;

  // Pre-compute quantities for each portfolio holding
  const portfolioQuantities = portfolios.map((p) => ({
    id: p.id,
    holdings: p.holdings.map((h) => ({
      apiSymbol: h.apiSymbol,
      quantity: startPrices[h.apiSymbol]
        ? computeQuantity(h.allocation, startPrices[h.apiSymbol])
        : null,
    })),
  }));

  const benchmarkQuantity = startPrices[benchmarkSymbol]
    ? computeQuantity(startingValue, startPrices[benchmarkSymbol])
    : null;

  return dates.map((date) => {
    const point: HistoryPoint = { date, chatgpt: null, claude: null, gemini: null, spy: null };

    // SPY benchmark
    if (benchmarkQuantity !== null) {
      const price = filledPrices[benchmarkSymbol]?.[date];
      if (price !== undefined) {
        const val = computePositionValue(benchmarkQuantity, price);
        point.spy = computeReturnPct(val, startingValue);
      }
    }

    // Each portfolio
    for (const pq of portfolioQuantities) {
      const id = pq.id as 'chatgpt' | 'claude' | 'gemini';
      let total = 0;
      let valid = true;

      for (const hq of pq.holdings) {
        if (hq.quantity === null) { valid = false; break; }
        const price = filledPrices[hq.apiSymbol]?.[date];
        if (price === undefined) { valid = false; break; }
        total += computePositionValue(hq.quantity, price);
      }

      if (valid) {
        point[id] = computeReturnPct(total, startingValue);
      }
    }

    return point;
  });
}
