import type { MarketSnapshot } from './snapshot';
import type { ContestConfig, HistoryPoint } from './types';
import type { MarketDataProvider } from './provider';
import { ALL_SYMBOLS, PORTFOLIOS, BENCHMARK } from './portfolios';
import { computeAllPortfolioStates, computeBenchmarkState } from './calculations';
import {
  buildHistorySeries,
  forwardFillPrices,
  barsToDateMap,
  buildMasterTimeline,
} from './history';
import { getStartDateStr } from './contest-config';
import { getEasternDateStr } from './market-calendar';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Full history fetch (first run only) ───────────────────────────────────────

async function buildFullChartData(
  provider: MarketDataProvider,
  config: ContestConfig,
  startDate: string,
  endDate: string,
  todayPrices: Record<string, number>,
): Promise<HistoryPoint[]> {
  console.log(`[snapshot-builder] fetching full history ${startDate}→${endDate}`);

  const [stockBarsMap, cryptoBarsMap] = await Promise.all([
    provider.getDailyBarsBatch(STOCK_SYMBOLS, startDate, endDate),
    provider.getCryptoDailyCloseBatch(CRYPTO_SYMBOLS, startDate, endDate),
  ]);

  const rawPrices: Record<string, Record<string, number>> = {};
  for (const [sym, bars] of Object.entries({ ...stockBarsMap, ...cryptoBarsMap })) {
    rawPrices[sym] = barsToDateMap(bars);
  }

  // Inject today's live prices as the final close
  for (const [sym, price] of Object.entries(todayPrices)) {
    if (!rawPrices[sym]) rawPrices[sym] = {};
    rawPrices[sym][endDate] = price;
  }

  const masterDates = buildMasterTimeline(startDate, endDate);
  const filledPrices = forwardFillPrices(rawPrices, ASSET_CLASSES, masterDates);

  const series = buildHistorySeries(masterDates, filledPrices, PORTFOLIOS, config);

  // Pin the official purchase date to exactly 0%
  const startIdx = series.findIndex((p) => p.date === startDate);
  if (startIdx >= 0) {
    series[startIdx] = { date: startDate, chatgpt: 0, claude: 0, gemini: 0, spy: 0 };
  }

  return series;
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Fetch current prices, compute all portfolio/benchmark states, extend the
 * cumulative chart, and return a complete MarketSnapshot.
 *
 * Does NOT write to storage — the caller validates and saves.
 */
export async function buildMarketSnapshot(
  config: ContestConfig,
  provider: MarketDataProvider,
  prevSnapshot: MarketSnapshot | null,
): Promise<MarketSnapshot> {
  const startMs = Date.now();
  const now = new Date();
  const todayET = getEasternDateStr(now);
  const startDate = getStartDateStr(config);

  // 1. Fetch all current prices in one batch call
  console.log(`[snapshot-builder] fetching prices for ${ALL_SYMBOLS.length} symbols`);
  const prices = await provider.getLatestPrices(ALL_SYMBOLS);
  const assetsResolved = Object.keys(prices).length;
  const missingSymbols = ALL_SYMBOLS.filter((s) => !(s in prices));
  if (missingSymbols.length > 0) {
    console.error(`[snapshot-builder] missing prices: ${missingSymbols.join(', ')}`);
  } else {
    console.log(`[snapshot-builder] all ${assetsResolved} prices resolved`);
  }

  // 2. Compute portfolio and benchmark states
  const portfolios = computeAllPortfolioStates(config, prices);
  const benchmark = computeBenchmarkState(config, prices);

  // 3. Build or extend chart data
  let chartData: HistoryPoint[];
  const prevChartData = prevSnapshot?.chartData ?? [];
  const lastChartDate = prevChartData.at(-1)?.date ?? null;

  if (lastChartDate === todayET) {
    // Cron ran twice today: replace today's last point with current prices
    const filledToday: Record<string, Record<string, number>> = {};
    for (const [sym, price] of Object.entries(prices)) {
      filledToday[sym] = { [todayET]: price };
    }
    const todayPoint = computeChartPoint(todayET, filledToday, config);
    chartData = [...prevChartData.slice(0, -1), todayPoint];
    console.log(`[snapshot-builder] replaced chart point for ${todayET}`);
  } else if (prevChartData.length > 0 && lastChartDate && lastChartDate >= startDate) {
    // Normal daily update: append today's point
    const filledToday: Record<string, Record<string, number>> = {};
    for (const [sym, price] of Object.entries(prices)) {
      filledToday[sym] = { [todayET]: price };
    }
    const todayPoint = computeChartPoint(todayET, filledToday, config);
    chartData = [...prevChartData, todayPoint];
    console.log(`[snapshot-builder] appended chart point for ${todayET}`);
  } else {
    // First ever run (or corrupted chart): fetch full history from Twelve Data
    chartData = await buildFullChartData(provider, config, startDate, todayET, prices);
    console.log(`[snapshot-builder] built full chart: ${chartData.length} points`);
  }

  const durationMs = Date.now() - startMs;
  console.log(`[snapshot-builder] done in ${durationMs}ms`);

  return {
    snapshotVersion: 1,
    generatedAt: now.toISOString(),
    asOfMarketDate: todayET,
    asOfLabel: formatAsOfLabel(todayET),
    status: 'complete',
    prices,
    benchmark,
    portfolios,
    chartData,
    metadata: {
      priceProvider: 'Twelve Data',
      assetsRequested: ALL_SYMBOLS.length,
      assetsResolved,
      durationMs,
    },
  };
}
