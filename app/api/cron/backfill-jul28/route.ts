import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { TwelveDataProvider } from '@/lib/twelve-data';
import { getContestConfig, getStartDateStr } from '@/lib/contest-config';
import { computeAllPortfolioStates, computeBenchmarkState } from '@/lib/calculations';
import {
  buildHistorySeries,
  forwardFillPrices,
  barsToDateMap,
  buildMasterTimeline,
} from '@/lib/history';
import { PORTFOLIOS, BENCHMARK, ALL_SYMBOLS } from '@/lib/portfolios';
import { getLatestMarketSnapshot, saveMarketSnapshot } from '@/lib/snapshot-store';
import { formatAsOfLabel, validateSnapshot } from '@/lib/snapshot-builder';
import type { MarketSnapshot } from '@/lib/snapshot';

// One-time historical backfill for the July 28, 2026 market close.
// Call once with Authorization: Bearer <CRON_SECRET>.
// Idempotent: returns no-op if a July 28 snapshot already exists.

const BACKFILL_DATE = '2026-07-28';
const STOCK_SYMBOLS = ['IREN', 'ASTS', 'RKLB', 'NVDA', 'MU', 'PLTR', 'TSLA', 'SPY'];
const CRYPTO_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];

const ASSET_CLASSES: Record<string, 'stock' | 'crypto'> = {};
for (const p of PORTFOLIOS) {
  for (const h of p.holdings) ASSET_CLASSES[h.apiSymbol] = h.assetClass;
}
ASSET_CLASSES[BENCHMARK.apiSymbol] = 'stock';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev convenience
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'TWELVE_DATA_API_KEY not set' }, { status: 500 });
  }

  const config = getContestConfig();
  const startDate = getStartDateStr(config); // '2026-07-24'
  const startMs = Date.now();
  const logs: string[] = [];
  const log = (msg: string) => { console.log(msg); logs.push(msg); };

  // Idempotency: skip if July 28 snapshot already stored
  const existing = await getLatestMarketSnapshot();
  if (existing?.asOfMarketDate === BACKFILL_DATE) {
    return NextResponse.json({
      status: 'no-op',
      reason: `Snapshot for ${BACKFILL_DATE} already exists (generatedAt: ${existing.generatedAt})`,
    });
  }

  log(`[backfill-jul28] Starting historical backfill for ${BACKFILL_DATE}`);
  log(`[backfill-jul28] Fetching ${startDate} → ${BACKFILL_DATE}`);

  const provider = new TwelveDataProvider(apiKey);

  // ── Wave 1: 8 stock + SPY symbols (8 credits) ────────────────────────────

  log(`[backfill-jul28] Wave 1 — stocks (${STOCK_SYMBOLS.join(', ')})`);
  const stockBarsMap = await provider.getDailyBarsBatch(STOCK_SYMBOLS, startDate, BACKFILL_DATE);

  const stockPrices: Record<string, number> = {};
  for (const sym of STOCK_SYMBOLS) {
    const bars = stockBarsMap[sym] ?? [];
    const bar = bars.find((b) => b.date === BACKFILL_DATE);
    if (bar) {
      stockPrices[sym] = bar.close;
      log(`[backfill-jul28]   ${sym}: $${bar.close.toFixed(sym === 'BTC/USD' ? 0 : 2)}`);
    } else {
      log(`[backfill-jul28]   ${sym}: MISSING — available dates: [${bars.map((b) => b.date).join(', ')}]`);
    }
  }

  // ── Wait 65 seconds before Wave 2 ────────────────────────────────────────

  log('[backfill-jul28] Waiting 65 seconds before Wave 2 (rate-limit safety)...');
  await sleep(65_000);

  // ── Wave 2: 3 crypto symbols at 4 PM ET (3 credits) ──────────────────────

  log(`[backfill-jul28] Wave 2 — crypto at 4 PM ET (${CRYPTO_SYMBOLS.join(', ')})`);
  const cryptoBarsMap = await provider.getCryptoDailyCloseBatch(
    CRYPTO_SYMBOLS, startDate, BACKFILL_DATE,
  );

  const cryptoPrices: Record<string, number> = {};
  for (const sym of CRYPTO_SYMBOLS) {
    const bars = cryptoBarsMap[sym] ?? [];
    const bar = bars.find((b) => b.date === BACKFILL_DATE);
    if (bar) {
      cryptoPrices[sym] = bar.close;
      log(`[backfill-jul28]   ${sym}: $${bar.close.toFixed(sym === 'BTC/USD' ? 0 : 2)} (4 PM ET close)`);
    } else {
      log(`[backfill-jul28]   ${sym}: MISSING — available dates: [${bars.map((b) => b.date).join(', ')}]`);
    }
  }

  // ── Merge and validate all 11 prices ─────────────────────────────────────

  const prices: Record<string, number> = { ...stockPrices, ...cryptoPrices };
  const missingSymbols = ALL_SYMBOLS.filter((s) => !(s in prices));

  if (missingSymbols.length > 0) {
    log(`[backfill-jul28] ERROR: missing prices for: ${missingSymbols.join(', ')}`);
    return NextResponse.json(
      { status: 'error', reason: `Missing prices for: ${missingSymbols.join(', ')}`, logs },
      { status: 422 },
    );
  }

  log(`[backfill-jul28] All ${Object.keys(prices).length} prices confirmed for ${BACKFILL_DATE}`);

  // ── Build chart data (full history from purchase date → July 28) ──────────

  const rawPrices: Record<string, Record<string, number>> = {};
  for (const [sym, bars] of Object.entries({ ...stockBarsMap, ...cryptoBarsMap })) {
    rawPrices[sym] = barsToDateMap(bars);
  }

  const masterDates = buildMasterTimeline(startDate, BACKFILL_DATE);
  const filledPrices = forwardFillPrices(rawPrices, ASSET_CLASSES, masterDates);
  const series = buildHistorySeries(masterDates, filledPrices, PORTFOLIOS, config);

  // Pin the official purchase date to exactly 0%
  const startIdx = series.findIndex((p) => p.date === startDate);
  if (startIdx >= 0) {
    series[startIdx] = { date: startDate, chatgpt: 0, claude: 0, gemini: 0, spy: 0 };
  }

  log(`[backfill-jul28] Chart: ${series.length} points (${series[0]?.date} → ${series.at(-1)?.date})`);

  // ── Compute portfolio and benchmark states ────────────────────────────────

  const portfolioStates = computeAllPortfolioStates(config, prices);
  const benchmark = computeBenchmarkState(config, prices);

  for (const ps of portfolioStates) {
    log(
      `[backfill-jul28]   ${ps.portfolio.id} (rank ${ps.rank}): ` +
      `$${ps.totalValue?.toFixed(2)} | ${ps.returnPct?.toFixed(2)}% | vs SPY: ${ps.vsSpyPct?.toFixed(2)}%`,
    );
  }
  log(
    `[backfill-jul28]   SPY benchmark: ` +
    `$${benchmark.totalValue?.toFixed(2)} | ${benchmark.returnPct?.toFixed(2)}%`,
  );

  // ── Assemble snapshot ─────────────────────────────────────────────────────

  const durationMs = Date.now() - startMs;

  const snapshot: MarketSnapshot = {
    snapshotVersion: 1,
    generatedAt: new Date().toISOString(),
    asOfMarketDate: BACKFILL_DATE,
    asOfLabel: formatAsOfLabel(BACKFILL_DATE),
    status: 'complete',
    prices,
    benchmark,
    portfolios: portfolioStates,
    chartData: series,
    metadata: {
      priceProvider: 'Twelve Data',
      assetsRequested: ALL_SYMBOLS.length,
      assetsResolved: Object.keys(prices).length,
      durationMs,
    },
  };

  // ── Validate before saving ────────────────────────────────────────────────

  const errors = validateSnapshot(snapshot);
  if (errors.length > 0) {
    log(`[backfill-jul28] Validation failed: ${errors.join('; ')}`);
    return NextResponse.json(
      { status: 'error', reason: 'Validation failed', errors, logs },
      { status: 422 },
    );
  }

  // ── Write to Vercel Blob ──────────────────────────────────────────────────

  await saveMarketSnapshot(snapshot);
  revalidateTag('market-snapshot');

  log(`[backfill-jul28] Snapshot saved to Vercel Blob (${durationMs}ms total)`);

  return NextResponse.json({
    status: 'ok',
    asOfMarketDate: BACKFILL_DATE,
    generatedAt: snapshot.generatedAt,
    prices,
    leaderboard: portfolioStates.map((ps) => ({
      id: ps.portfolio.id,
      rank: ps.rank,
      totalValue: ps.totalValue,
      returnPct: ps.returnPct,
      vsSpyPct: ps.vsSpyPct,
    })),
    benchmark: {
      totalValue: benchmark.totalValue,
      returnPct: benchmark.returnPct,
    },
    chartDates: series.map((p) => p.date),
    chartPointCount: series.length,
    durationMs,
    logs,
  });
}
