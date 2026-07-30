import type { MarketSnapshot } from './snapshot';
import type { ContestConfig, HistoryPoint } from './types';
import type { MarketDataProvider } from './provider';
import { ALL_SYMBOLS, PORTFOLIOS, BENCHMARK } from './portfolios';
import { computeAllPortfolioStates, computeBenchmarkState } from './calculations';
import { buildHistorySeries, forwardFillPrices, barsToDateMap } from './history';
import { getStartDateStr } from './contest-config';
import { fetchCoinbaseDailyClose } from './coinbase';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-07-29" → "Market close July 29, 2026" */
export function formatAsOfLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `Market close ${MONTHS[month - 1]} ${day}, ${year}`;
}

const ASSET_CLASSES: Record<string, 'stock' | 'crypto'> = {};
for (const p of PORTFOLIOS) {
  for (const h of p.holdings) ASSET_CLASSES[h.apiSymbol] = h.assetClass;
}
ASSET_CLASSES[BENCHMARK.apiSymbol] = 'stock';

const STOCK_SYMBOLS = ALL_SYMBOLS.filter((s) => ASSET_CLASSES[s] !== 'crypto');
const CRYPTO_SYMBOLS = ALL_SYMBOLS.filter((s) => ASSET_CLASSES[s] === 'crypto');

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Returns a list of error strings. An empty array means the snapshot is valid.
 * A non-empty array means the snapshot should NOT replace the previous one.
 */
export function validateSnapshot(snapshot: MarketSnapshot): string[] {
  const errors: string[] = [];

  if (!snapshot.generatedAt) errors.push('Missing generatedAt');
  if (!snapshot.asOfMarketDate) errors.push('Missing asOfMarketDate');
  if (!snapshot.asOfLabel) errors.push('Missing asOfLabel');

  // All required symbols must have prices
  const missingPrices = ALL_SYMBOLS.filter((s) => !(s in snapshot.prices));
  if (missingPrices.length > 0) {
    errors.push(`Missing prices for: ${missingPrices.join(', ')}`);
  }

  // All prices must be positive finite numbers
  for (const [sym, price] of Object.entries(snapshot.prices)) {
    if (!isFinite(price) || price <= 0) {
      errors.push(`Invalid price for ${sym}: ${price}`);
    }
  }

  // Benchmark must be fully computed
  if (snapshot.benchmark.totalValue === null) errors.push('Benchmark totalValue is null');
  if (snapshot.benchmark.returnPct === null) errors.push('Benchmark returnPct is null');

  // Every portfolio must have a computed total value
  for (const ps of snapshot.portfolios) {
    if (ps.totalValue === null) {
      errors.push(`Portfolio ${ps.portfolio.id} totalValue is null`);
    }
  }

  // Chart data must have at least the start date
  if (snapshot.chartData.length === 0) errors.push('chartData is empty');

  return errors;
}

// ── Chart point helper ────────────────────────────────────────────────────────

function computeChartPoint(
  date: string,
  filledPrices: Record<string, Record<string, number>>,
  config: ContestConfig,
): HistoryPoint {
  const series = buildHistorySeries([date], filledPrices, PORTFOLIOS, config);
  return series[0] ?? { date, chatgpt: null, claude: null, gemini: null, spy: null };
}

// ── Catch-up builder ─────────────────────────────────────────────────────────

/**
 * Build one MarketSnapshot per date in `dates`, using each date's official
 * regular-session close (1-day bars for stocks, the bar nearest 4:00 PM ET
 * for crypto) rather than a live quote. This lets the caller "catch up" on
 * any number of missed trading days in a single call.
 *
 * `dates` must be in chronological order and contain only market days
 * (weekends/holidays already excluded by the caller). If `dates` contains
 * exactly one date that matches the last point of `prevSnapshot.chartData`,
 * that point is replaced rather than duplicated — this makes the function
 * safe to call twice for the same trading date.
 *
 * Does NOT write to storage — the caller validates and saves each snapshot,
 * in order, so every intermediate day is durably archived.
 */
export async function buildSnapshotsForDates(
  config: ContestConfig,
  provider: MarketDataProvider,
  prevSnapshot: MarketSnapshot | null,
  dates: string[],
): Promise<MarketSnapshot[]> {
  if (dates.length === 0) return [];

  const startDate = getStartDateStr(config);
  const rangeStart = dates[0];
  const rangeEnd = dates[dates.length - 1];

  console.log(
    `[snapshot-builder] fetching ${rangeStart}→${rangeEnd} (${dates.length} date(s)) — ` +
    `stocks via Twelve Data, crypto via Coinbase (parallel, independent APIs)`,
  );

  // Stocks: Twelve Data daily bars (8 symbols, well within the 8-credit/min limit).
  // Crypto: Coinbase Exchange public candles per date (no API key, no shared rate limit).
  // Both fetches run in parallel — they hit different upstream services.
  const [stockBarsMap, cryptoByDate] = await Promise.all([
    provider.getDailyBarsBatch(STOCK_SYMBOLS, rangeStart, rangeEnd),
    (async () => {
      const byDate: Record<string, Record<string, number>> = {};
      await Promise.all(
        dates.map(async (date) => {
          byDate[date] = await fetchCoinbaseDailyClose(CRYPTO_SYMBOLS, date);
        }),
      );
      return byDate;
    })(),
  ]);

  // Log Twelve Data results
  const stockSucceeded = STOCK_SYMBOLS.filter((s) => stockBarsMap[s]?.length > 0);
  const stockFailed    = STOCK_SYMBOLS.filter((s) => !stockBarsMap[s]?.length);
  console.log(
    `[snapshot-builder] Twelve Data: requested=[${STOCK_SYMBOLS.join(', ')}]` +
    ` succeeded=[${stockSucceeded.join(', ')}]` +
    (stockFailed.length ? ` MISSING=[${stockFailed.join(', ')}]` : ''),
  );

  // Build rawPrices: stocks from Twelve Data bars, crypto from Coinbase closes
  const rawPrices: Record<string, Record<string, number>> = {};
  for (const [sym, bars] of Object.entries(stockBarsMap)) {
    rawPrices[sym] = barsToDateMap(bars);
  }
  for (const sym of CRYPTO_SYMBOLS) {
    rawPrices[sym] = {};
    for (const date of dates) {
      const price = cryptoByDate[date]?.[sym];
      if (price !== undefined) rawPrices[sym][date] = price;
    }
  }

  const filledPrices = forwardFillPrices(rawPrices, ASSET_CLASSES, dates);

  const snapshots: MarketSnapshot[] = [];
  let chartData = prevSnapshot?.chartData ?? [];

  for (const date of dates) {
    const dateStartMs = Date.now();

    const prices: Record<string, number> = {};
    for (const sym of ALL_SYMBOLS) {
      const p = filledPrices[sym]?.[date];
      if (p !== undefined) prices[sym] = p;
    }

    const portfolios = computeAllPortfolioStates(config, prices);
    const benchmark = computeBenchmarkState(config, prices);

    // Pin the official purchase date to exactly 0% regardless of any tiny
    // discrepancy between the fetched close and the recorded start price.
    const point = date === startDate
      ? { date, chatgpt: 0, claude: 0, gemini: 0, spy: 0 }
      : computeChartPoint(date, filledPrices, config);

    if (chartData.length > 0 && chartData[chartData.length - 1].date === date) {
      chartData = [...chartData.slice(0, -1), point];
      console.log(`[snapshot-builder] replaced chart point for ${date}`);
    } else {
      chartData = [...chartData, point];
      console.log(`[snapshot-builder] appended chart point for ${date}`);
    }

    const assetsResolved = Object.keys(prices).length;
    const missingSymbols = ALL_SYMBOLS.filter((s) => !(s in prices));
    if (missingSymbols.length > 0) {
      console.error(`[snapshot-builder] ${date}: missing prices for ${missingSymbols.join(', ')}`);
    }

    snapshots.push({
      snapshotVersion: 1,
      generatedAt: new Date().toISOString(),
      asOfMarketDate: date,
      asOfLabel: formatAsOfLabel(date),
      status: 'complete',
      prices,
      benchmark,
      portfolios,
      chartData,
      metadata: {
        priceProvider: 'Twelve Data',
        assetsRequested: ALL_SYMBOLS.length,
        assetsResolved,
        durationMs: Date.now() - dateStartMs,
      },
    });
  }

  return snapshots;
}
