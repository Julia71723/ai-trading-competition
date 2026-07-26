import { NextResponse } from 'next/server';
import { TwelveDataProvider } from '@/lib/twelve-data';
import { isMarketDay } from '@/lib/market-calendar';
import type { MarketDataResponse } from '@/lib/types';

const WAVE1_SYMBOLS = ['IREN', 'ASTS', 'RKLB', 'NVDA', 'MU', 'PLTR', 'TSLA', 'SPY'];
const WAVE2_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  price: number;
  cachedAt: number;
}

// Module-level per-symbol cache. Vercel Fluid Compute reuses instances across
// concurrent requests, so this prevents duplicate Twelve Data calls within the
// same 30-minute window on a single instance.
const symbolCache = new Map<string, CacheEntry>();

// Global API serialization chain: Wave 1 and Wave 2 Twelve Data fetches are
// enqueued here so they NEVER execute in parallel, even if concurrent visitors
// trigger both waves simultaneously.
let apiChain: Promise<void> = Promise.resolve();

// Per-wave single-flight: concurrent requests for the same wave share the one
// in-flight Promise instead of launching independent upstream fetches.
let wave1Inflight: Promise<void> | null = null;
let wave2Inflight: Promise<void> | null = null;

// Last upstream error per wave, cleared on the next successful fetch.
let wave1LastErr: string | null = null;
let wave2LastErr: string | null = null;

function isFresh(sym: string): boolean {
  const e = symbolCache.get(sym);
  return !!e && Date.now() - e.cachedAt < CACHE_TTL_MS;
}

function collectPrices(symbols: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sym of symbols) {
    const e = symbolCache.get(sym);
    if (e) out[sym] = e.price;
  }
  return out;
}

// Enqueue fn on the serial API chain so no two Twelve Data calls ever overlap.
// fn always runs once the previous chain link resolves (success or failure).
function enqueueApiCall(fn: () => Promise<void>): Promise<void> {
  const next = apiChain.then(() => fn(), () => fn());
  // Absorb errors so the chain itself never rejects and future enqueues work.
  apiChain = next.then(() => {}, () => {});
  return next;
}

async function doFetch(
  provider: TwelveDataProvider,
  symbols: string[],
  waveNum: 1 | 2,
): Promise<void> {
  try {
    const prices = await provider.getLatestPrices(symbols);
    const now = Date.now();
    for (const [sym, price] of Object.entries(prices)) {
      symbolCache.set(sym, { price, cachedAt: now });
    }
    if (waveNum === 1) wave1LastErr = null;
    else wave2LastErr = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[market-data wave${waveNum}]`, msg);
    if (waveNum === 1) wave1LastErr = msg;
    else wave2LastErr = msg;
  }
}

async function refreshWave(waveNum: 1 | 2, provider: TwelveDataProvider): Promise<void> {
  const symbols = waveNum === 1 ? WAVE1_SYMBOLS : WAVE2_SYMBOLS;

  // Cache hit — serve without any upstream call.
  if (symbols.every(isFresh)) return;

  // Wave 1 on a non-trading day: stocks haven't changed; skip the Twelve Data
  // credit. The caller uses starting prices as fallback for any missing symbols.
  if (waveNum === 1 && !isMarketDay()) return;

  if (waveNum === 1) {
    wave1Inflight ??= enqueueApiCall(() => doFetch(provider, symbols, 1)).finally(() => {
      wave1Inflight = null;
    });
    await wave1Inflight;
  } else {
    wave2Inflight ??= enqueueApiCall(() => doFetch(provider, symbols, 2)).finally(() => {
      wave2Inflight = null;
    });
    await wave2Inflight;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        prices: {},
        timestamp: new Date().toISOString(),
        isFresh: false,
        error: 'TWELVE_DATA_API_KEY is not configured on this server.',
      } satisfies MarketDataResponse,
      { status: 503 },
    );
  }

  const wave = new URL(request.url).searchParams.get('wave');

  if (wave !== '1' && wave !== '2') {
    // No wave param: return current cache state without triggering any fetch.
    // The client always passes ?wave=1 or ?wave=2 explicitly.
    return NextResponse.json(
      {
        prices: { ...collectPrices(WAVE1_SYMBOLS), ...collectPrices(WAVE2_SYMBOLS) },
        timestamp: new Date().toISOString(),
        isFresh: false,
      } satisfies MarketDataResponse,
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const waveNum = wave === '1' ? 1 : 2;
  const provider = new TwelveDataProvider(apiKey);

  await refreshWave(waveNum, provider);

  const symbols = waveNum === 1 ? WAVE1_SYMBOLS : WAVE2_SYMBOLS;
  const prices = collectPrices(symbols);
  const fresh = symbols.every(isFresh);
  const lastErr = waveNum === 1 ? wave1LastErr : wave2LastErr;

  const body: MarketDataResponse = {
    prices,
    timestamp: new Date().toISOString(),
    isFresh: fresh,
    ...(lastErr !== null && {
      error: 'Updating remaining market prices — cached values shown.',
    }),
  };

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
