import { NextResponse } from 'next/server';
import { TwelveDataProvider } from '@/lib/twelve-data';
import type { MarketDataResponse } from '@/lib/types';

// Wave 1 — US stocks + SPY benchmark (regular-session, closed on weekends/holidays)
const WAVE1_SYMBOLS = ['IREN', 'ASTS', 'RKLB', 'NVDA', 'MU', 'PLTR', 'TSLA', 'SPY'];
// Wave 2 — crypto (24/7, fetched at least 65 s after Wave 1 on market days)
const WAVE2_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  price: number;
  cachedAt: number;
}

// Module-level per-symbol cache.
// On Vercel Fluid Compute, function instances are reused across requests, so this
// cache persists between visitor requests to the same instance — effectively a
// 30-minute in-process cache that prevents duplicate Twelve Data upstream calls.
const symbolCache = new Map<string, CacheEntry>();

// Wave-level single-flight: at most one in-flight batch per wave.
// Concurrent requests for the same wave all await the same Promise instead of
// launching independent upstream fetches.
let wave1Inflight: Promise<void> | null = null;
let wave2Inflight: Promise<void> | null = null;

function isFresh(symbol: string): boolean {
  const entry = symbolCache.get(symbol);
  return !!entry && Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function allFresh(symbols: string[]): boolean {
  return symbols.every(isFresh);
}

async function fetchAndCache(provider: TwelveDataProvider, symbols: string[]): Promise<void> {
  try {
    const prices = await provider.getLatestPrices(symbols);
    const now = Date.now();
    for (const [sym, price] of Object.entries(prices)) {
      symbolCache.set(sym, { price, cachedAt: now });
    }
  } catch (err) {
    // Log but preserve existing cache — stale values remain usable
    console.error('[market-data] upstream fetch error:', err instanceof Error ? err.message : err);
  }
}

async function refreshWave(waveNum: 1 | 2, provider: TwelveDataProvider): Promise<void> {
  const symbols = waveNum === 1 ? WAVE1_SYMBOLS : WAVE2_SYMBOLS;
  if (allFresh(symbols)) return;

  if (waveNum === 1) {
    wave1Inflight ??= fetchAndCache(provider, symbols).finally(() => {
      wave1Inflight = null;
    });
    await wave1Inflight;
  } else {
    wave2Inflight ??= fetchAndCache(provider, symbols).finally(() => {
      wave2Inflight = null;
    });
    await wave2Inflight;
  }
}

function collectAllCached(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, entry] of symbolCache.entries()) out[sym] = entry.price;
  return out;
}

export async function GET(request: Request): Promise<NextResponse> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        prices: collectAllCached(),
        timestamp: new Date().toISOString(),
        isFresh: false,
        error: 'TWELVE_DATA_API_KEY is not configured on this server.',
      } satisfies MarketDataResponse,
      { status: 503 },
    );
  }

  const provider = new TwelveDataProvider(apiKey);
  const wave = new URL(request.url).searchParams.get('wave');

  // Refresh the requested wave. Errors are swallowed inside refreshWave so
  // we always return whatever is in the cache rather than a 5xx crash.
  if (wave === '1') {
    await refreshWave(1, provider);
  } else if (wave === '2') {
    await refreshWave(2, provider);
  } else {
    // No wave param (initial cold load): refresh all stale symbols in parallel
    await Promise.all([refreshWave(1, provider), refreshWave(2, provider)]);
  }

  const prices = collectAllCached();
  const allSymbols = [...WAVE1_SYMBOLS, ...WAVE2_SYMBOLS];
  const everythingFresh = allFresh(allSymbols);
  const wave2Pending = !allFresh(WAVE2_SYMBOLS);

  const body: MarketDataResponse = {
    prices,
    timestamp: new Date().toISOString(),
    isFresh: everythingFresh,
    ...(wave2Pending && { wave2Pending: true }),
  };

  return NextResponse.json(body, {
    // No CDN-layer caching — the module-level cache handles deduplication.
    // Clients always reach the origin and receive the current in-process cache.
    headers: { 'Cache-Control': 'no-store' },
  });
}
