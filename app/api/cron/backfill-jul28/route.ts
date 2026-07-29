import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getContestConfig } from '@/lib/contest-config';
import { computeAllPortfolioStates, computeBenchmarkState } from '@/lib/calculations';
import { ALL_SYMBOLS } from '@/lib/portfolios';
import { saveMarketSnapshot } from '@/lib/snapshot-store';
import { formatAsOfLabel, validateSnapshot } from '@/lib/snapshot-builder';
import type { MarketSnapshot } from '@/lib/snapshot';
import type { HistoryPoint } from '@/lib/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKFILL_DATE = '2026-07-28';
// 4:00 PM ET on July 28, 2026 (EDT = UTC-4) → 20:00:00 UTC
const CRYPTO_TARGET_UTC = '2026-07-28T20:00:00Z';
// Maximum minutes a "closest preceding" bar may lag behind the 4 PM ET target
const MAX_LAG_MINUTES = 5;

// User-verified July 28, 2026 official regular-session closing prices.
// These are the authoritative source; no API call is made for these symbols.
const VERIFIED_STOCK_PRICES: Record<string, { price: number }> = {
  IREN: { price: 33.93 },
  ASTS: { price: 56.55 },
  RKLB: { price: 63.89 },
  NVDA: { price: 197.01 },
  MU:   { price: 820.53 },
  PLTR: { price: 123.53 },
  TSLA: { price: 307.44 },
  SPY:  { price: 740.86 },
};

const CRYPTO_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const TD_BASE = 'https://api.twelvedata.com';

// ── Crypto fetch ──────────────────────────────────────────────────────────────

interface CryptoResult {
  price: number;
  datetime: string;   // exactly as returned by Twelve Data, e.g. "2026-07-28 20:00:00"
  lagMinutes: number; // how far behind the 4 PM ET target
  endpoint: string;   // URL with API key redacted
}

/**
 * Fetch the 1-minute bar for `symbol` at or immediately before targetUtc.
 * Opens a ±20-minute window around the target and picks the most recent bar
 * that does NOT exceed the target timestamp.
 */
async function fetchCryptoAt4PMET(apiKey: string, symbol: string): Promise<CryptoResult> {
  const targetMs = new Date(CRYPTO_TARGET_UTC).getTime();

  // Window: 20 minutes before target → 1 minute after target
  const windowStart = new Date(targetMs - 20 * 60 * 1000);
  const windowEnd   = new Date(targetMs + 1 * 60 * 1000);

  const startStr = windowStart.toISOString().replace('T', ' ').slice(0, 16);
  const endStr   = windowEnd.toISOString().replace('T', ' ').slice(0, 16);
  const encSym   = encodeURIComponent(symbol);

  const url =
    `${TD_BASE}/time_series?symbol=${encSym}` +
    `&interval=1min&start_date=${encodeURIComponent(startStr)}&end_date=${encodeURIComponent(endStr)}` +
    `&outputsize=30&apikey=${apiKey}`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Twelve Data 1min HTTP ${res.status} for ${symbol}`);
  }

  const raw = (await res.json()) as {
    values?: Array<{ datetime: string; close: string }>;
    status?: string;
    message?: string;
  };

  if (raw.status === 'error') {
    throw new Error(`Twelve Data 1min error for ${symbol}: ${raw.message}`);
  }
  if (!raw.values || raw.values.length === 0) {
    throw new Error(`No 1-minute bars returned for ${symbol} near ${CRYPTO_TARGET_UTC}`);
  }

  // Candidates: bars at or before the target timestamp, ordered most-recent-first
  const candidates = raw.values
    .map((v) => {
      const utcMs = new Date(v.datetime.replace(' ', 'T') + 'Z').getTime();
      return { datetime: v.datetime, utcMs, price: parseFloat(v.close) };
    })
    .filter((b) => isFinite(b.price) && b.price > 0 && b.utcMs <= targetMs)
    .sort((a, b) => b.utcMs - a.utcMs);

  if (candidates.length === 0) {
    throw new Error(
      `No bars at or before ${CRYPTO_TARGET_UTC} for ${symbol}. ` +
      `Bars available: ${raw.values.map((v) => v.datetime).join(', ')}`,
    );
  }

  const best = candidates[0];
  const lagMinutes = (targetMs - best.utcMs) / 60_000;

  if (lagMinutes > MAX_LAG_MINUTES) {
    throw new Error(
      `Closest preceding bar for ${symbol} is ${lagMinutes.toFixed(1)} min before target ` +
      `(max allowed: ${MAX_LAG_MINUTES} min). Got: ${best.datetime}`,
    );
  }

  const redactedUrl = url.replace(apiKey, '[REDACTED]');
  return { price: best.price, datetime: best.datetime, lagMinutes, endpoint: redactedUrl };
}

// ── Authorization ─────────────────────────────────────────────────────────────

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'TWELVE_DATA_API_KEY not set' }, { status: 500 });
  }

  const config = getContestConfig();
  const startDateStr = new Date(config.officialPurchaseTimestamp).toISOString().split('T')[0];
  const startMs = Date.now();
  const logs: string[] = [];
  const log = (msg: string) => { console.log(msg); logs.push(msg); };

  log(`[backfill-jul28] Starting — target date: ${BACKFILL_DATE}, crypto target: ${CRYPTO_TARGET_UTC}`);

  // ── 1. Stock prices (hardcoded, user-verified) ────────────────────────────

  const prices: Record<string, number> = {};
  const verification: Array<{
    symbol: string; price: number; sourceDate?: string;
    sourceDatetime?: string; lagMinutes?: number; endpoint: string;
  }> = [];

  log('[backfill-jul28] Stock prices (verified official July 28 closes):');
  for (const [sym, { price }] of Object.entries(VERIFIED_STOCK_PRICES)) {
    prices[sym] = price;
    verification.push({ symbol: sym, price, sourceDate: BACKFILL_DATE, endpoint: 'hardcoded/verified' });
    log(`[backfill-jul28]   ${sym.padEnd(8)} $${price}`);
  }

  // ── 2. Crypto prices at exactly 4:00 PM ET (1-minute bars) ───────────────

  log(`[backfill-jul28] Fetching crypto at ${CRYPTO_TARGET_UTC} (4:00 PM ET = 20:00 UTC):`);

  const cryptoResults: Record<string, CryptoResult> = {};
  for (const sym of CRYPTO_SYMBOLS) {
    try {
      const result = await fetchCryptoAt4PMET(apiKey, sym);
      cryptoResults[sym] = result;
      prices[sym] = result.price;
      verification.push({
        symbol: sym,
        price: result.price,
        sourceDatetime: result.datetime + ' UTC',
        lagMinutes: result.lagMinutes,
        endpoint: 'Twelve Data /time_series?interval=1min',
      });
      log(
        `[backfill-jul28]   ${sym.padEnd(10)} $${result.price.toFixed(2)} ` +
        `@ ${result.datetime} UTC (lag: ${result.lagMinutes.toFixed(1)} min)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[backfill-jul28]   ${sym}: FAILED — ${msg}`);
      return NextResponse.json({ status: 'error', reason: msg, logs }, { status: 422 });
    }
  }

  // ── 3. Validate all 11 symbols present ───────────────────────────────────

  const missingSymbols = ALL_SYMBOLS.filter((s) => !(s in prices));
  if (missingSymbols.length > 0) {
    const reason = `Missing prices for: ${missingSymbols.join(', ')}`;
    log(`[backfill-jul28] ERROR: ${reason}`);
    return NextResponse.json({ status: 'error', reason, logs }, { status: 422 });
  }
  log(`[backfill-jul28] All ${ALL_SYMBOLS.length} prices confirmed.`);

  // ── 4. Validate crypto timestamps ─────────────────────────────────────────

  for (const sym of CRYPTO_SYMBOLS) {
    const r = cryptoResults[sym];
    const barUtcMs = new Date(r.datetime.replace(' ', 'T') + 'Z').getTime();
    const targetMs = new Date(CRYPTO_TARGET_UTC).getTime();
    if (barUtcMs > targetMs) {
      const reason = `Crypto bar for ${sym} is AFTER target (${r.datetime} > ${CRYPTO_TARGET_UTC})`;
      log(`[backfill-jul28] REJECT: ${reason}`);
      return NextResponse.json({ status: 'error', reason, logs }, { status: 422 });
    }
    // Also verify the bar falls on the correct calendar date (UTC date = 2026-07-28)
    if (!r.datetime.startsWith(BACKFILL_DATE)) {
      const reason = `Crypto bar for ${sym} is on wrong date: ${r.datetime}`;
      log(`[backfill-jul28] REJECT: ${reason}`);
      return NextResponse.json({ status: 'error', reason, logs }, { status: 422 });
    }
  }

  // ── 5. Compute portfolio and benchmark states ─────────────────────────────

  const portfolioStates = computeAllPortfolioStates(config, prices);
  const benchmark = computeBenchmarkState(config, prices);

  log('[backfill-jul28] Portfolio values (July 28):');
  for (const ps of portfolioStates) {
    log(
      `[backfill-jul28]   ${ps.portfolio.id.padEnd(8)} rank ${ps.rank} | ` +
      `$${ps.totalValue?.toFixed(2)} | ${ps.returnPct?.toFixed(4)}% | ` +
      `vs SPY: ${ps.vsSpyPct?.toFixed(4)}%`,
    );
  }
  log(
    `[backfill-jul28]   ${'SPY'.padEnd(8)} bench  | ` +
    `$${benchmark.totalValue?.toFixed(2)} | ${benchmark.returnPct?.toFixed(4)}%`,
  );

  // ── 6. Build chart (2 points: July 24 baseline + July 28 snapshot) ────────

  // The chart contains only completed market-close sessions.
  // July 24 is pinned to exactly 0% (official purchase date).
  // July 28 is derived directly from the portfolio return computations.
  const portfolioById = Object.fromEntries(portfolioStates.map((ps) => [ps.portfolio.id, ps]));

  const jul28Point: HistoryPoint = {
    date: BACKFILL_DATE,
    chatgpt: portfolioById['chatgpt']?.returnPct ?? null,
    claude:  portfolioById['claude']?.returnPct ?? null,
    gemini:  portfolioById['gemini']?.returnPct ?? null,
    spy:     benchmark.returnPct,
  };

  const chartData: HistoryPoint[] = [
    { date: startDateStr, chatgpt: 0, claude: 0, gemini: 0, spy: 0 },
    jul28Point,
  ];

  log(`[backfill-jul28] Chart: ${chartData.length} points — ${chartData.map((p) => p.date).join(', ')}`);

  // ── 7. Assemble and validate snapshot ─────────────────────────────────────

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
    chartData,
    metadata: {
      priceProvider: 'Twelve Data (1min) + user-verified closes',
      assetsRequested: ALL_SYMBOLS.length,
      assetsResolved: Object.keys(prices).length,
      durationMs,
    },
  };

  const errors = validateSnapshot(snapshot);
  if (errors.length > 0) {
    log(`[backfill-jul28] Validation errors: ${errors.join('; ')}`);
    return NextResponse.json({ status: 'error', reason: 'Validation failed', errors, logs }, { status: 422 });
  }

  // ── 8. Save to Vercel Blob (unconditional overwrite) ──────────────────────

  await saveMarketSnapshot(snapshot);
  revalidateTag('market-snapshot');

  log(`[backfill-jul28] Snapshot saved. Total time: ${durationMs}ms`);

  // ── 9. Return verification report ─────────────────────────────────────────

  return NextResponse.json({
    status: 'ok',
    asOfMarketDate: BACKFILL_DATE,
    asOfLabel: snapshot.asOfLabel,
    generatedAt: snapshot.generatedAt,
    verification,
    leaderboard: portfolioStates.map((ps) => ({
      rank: ps.rank,
      id: ps.portfolio.id,
      name: ps.portfolio.name,
      totalValue: ps.totalValue,
      gainLoss: ps.gainLoss,
      returnPct: ps.returnPct,
      vsSpyPct: ps.vsSpyPct,
      bestHolding: ps.bestHolding
        ? { ticker: ps.bestHolding.holding.ticker, returnPct: ps.bestHolding.returnPct }
        : null,
      worstHolding: ps.worstHolding
        ? { ticker: ps.worstHolding.holding.ticker, returnPct: ps.worstHolding.returnPct }
        : null,
    })),
    benchmark: {
      totalValue: benchmark.totalValue,
      gainLoss:
        benchmark.totalValue !== null ? benchmark.totalValue - config.startingValue : null,
      returnPct: benchmark.returnPct,
    },
    chartDates: chartData.map((p) => p.date),
    durationMs,
    logs,
  });
}
