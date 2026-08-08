import type { MarketSnapshot } from './snapshot';
import type { ContestConfig, HistoryPoint, DailyBar } from './types';
import type { MarketDataProvider } from './provider';
import { ALL_SYMBOLS, PORTFOLIOS, BENCHMARK } from './portfolios';
import { computeAllPortfolioStates, computeBenchmarkState } from './calculations';
import { buildHistorySeries, forwardFillPrices, barsToDateMap } from './history';
import { getStartDateStr } from './contest-config';
import { fetchCoinbaseDailyClose } from './coinbase';
import { getEasternDateStr } from './market-calendar';

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
 * Build one MarketSnapshot per date in `dates`.
 *
 * Crypto (BTC/USD, ETH/USD, SOL/USD) always comes from Coinbase's public
 * candles for the bar nearest 4:00 PM ET on that date — Coinbase has no
 * next-day publish lag, so this works identically for today or any past date.
 *
 * Stocks are sourced differently depending on the date:
 *  - If `dates` includes today (ET, per `now`), today's price is a *live quote*
 *    (Twelve Data's real-time /price endpoint), captured once the close guard
 *    in getLatestCompletedMarketDate has cleared. Twelve Data's Basic plan does
 *    not publish the official EOD daily bar for a session until the following
 *    morning, so the settled aggregate cannot be used same-day.
 *  - Every other (past) date uses the settled EOD daily bar (1-day interval),
 *    which is reliably available for any date strictly before today.
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
  now: Date = new Date(),
): Promise<MarketSnapshot[]> {
  if (dates.length === 0) return [];

  const startDate = getStartDateStr(config);
  const todayET = getEasternDateStr(now);
  const isTodayIncluded = dates.includes(todayET);
  const historicalDates = dates.filter((d) => d !== todayET);

  console.log(
    `[snapshot-builder] building ${dates.length} date(s): ${dates.join(', ')} — ` +
    `crypto via Coinbase; stocks via ` +
    [
      historicalDates.length > 0 ? `Twelve Data EOD (${historicalDates.join(', ')})` : null,
      isTodayIncluded ? `Twelve Data live quote (${todayET})` : null,
    ].filter(Boolean).join(' + '),
  );

  // All three fetches run in parallel — they hit independent upstream services
  // (or, for historical/live, independent Twelve Data endpoints).
  const [historicalBarsMap, liveStockPrices, cryptoByDate] = await Promise.all([
    historicalDates.length > 0
      ? provider.getDailyBarsBatch(STOCK_SYMBOLS, historicalDates[0], historicalDates[historicalDates.length - 1])
      : Promise.resolve({} as Record<string, DailyBar[]>),
    isTodayIncluded
      ? provider.getLatestPrices(STOCK_SYMBOLS)
      : Promise.resolve({} as Record<string, number>),
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

  if (historicalDates.length > 0) {
    const succeeded = STOCK_SYMBOLS.filter((s) => historicalBarsMap[s]?.length > 0);
    const failed    = STOCK_SYMBOLS.filter((s) => !historicalBarsMap[s]?.length);
    console.log(
      `[snapshot-builder] Twelve Data EOD: requested=[${STOCK_SYMBOLS.join(', ')}]` +
      ` succeeded=[${succeeded.join(', ')}]` +
      (failed.length ? ` MISSING=[${failed.join(', ')}]` : ''),
    );
  }
  if (isTodayIncluded) {
    const resolved = STOCK_SYMBOLS.filter((s) => s in liveStockPrices);
    const missing   = STOCK_SYMBOLS.filter((s) => !(s in liveStockPrices));
    console.log(
      `[snapshot-builder] Twelve Data live quote (${todayET}): requested=[${STOCK_SYMBOLS.join(', ')}]` +
      ` resolved=[${resolved.join(', ')}]` +
      (missing.length ? ` MISSING=[${missing.join(', ')}]` : ''),
    );
  }

  // Build rawPrices: historical stocks from EOD bars, today's stocks from the
  // live quote, crypto from Coinbase closes.
  const rawPrices: Record<string, Record<string, number>> = {};
  for (const [sym, bars] of Object.entries(historicalBarsMap)) {
    rawPrices[sym] = barsToDateMap(bars);
  }
  if (isTodayIncluded) {
    for (const [sym, price] of Object.entries(liveStockPrices)) {
      if (!rawPrices[sym]) rawPrices[sym] = {};
      rawPrices[sym][todayET] = price;
    }
  }
  for (const sym of CRYPTO_SYMBOLS) {
    rawPrices[sym] = rawPrices[sym] ?? {};
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
