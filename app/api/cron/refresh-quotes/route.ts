import { NextResponse } from 'next/server';
import { isMarketDay } from '@/lib/market-calendar';

// Vercel sends Authorization: Bearer <CRON_SECRET> with every cron invocation.
// Set CRON_SECRET in your Vercel project environment variables.
function isCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // No secret configured → allow (dev/staging convenience)
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Maximum time to wait for each wave fetch (ms).
const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Resolve the base URL for self-calls.
  // VERCEL_PROJECT_PRODUCTION_URL is the stable production hostname (no preview hashes).
  // VERCEL_URL is the current deployment URL (works in preview too).
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL ??
    'localhost:3000';
  const scheme = host.startsWith('localhost') ? 'http' : 'https';
  const base = `${scheme}://${host}`;

  const marketDay = isMarketDay();
  const log: Record<string, unknown> = { marketDay, startedAt: new Date().toISOString() };

  try {
    if (marketDay) {
      // Wave 1 — refresh stocks
      const w1 = await fetchWithTimeout(`${base}/api/market-data?wave=1`);
      log.wave1Status = w1.status;

      // Hold for at least 65 s before Wave 2 to stay within Twelve Data rate limits
      await sleep(65_000);
    }

    // Wave 2 — refresh crypto (always; crypto trades 24/7)
    const w2 = await fetchWithTimeout(`${base}/api/market-data?wave=2`);
    log.wave2Status = w2.status;

    log.completedAt = new Date().toISOString();
    return NextResponse.json({ ok: true, ...log });
  } catch (err) {
    console.error('[cron/refresh-quotes]', err);
    return NextResponse.json({ ok: false, error: String(err), ...log }, { status: 500 });
  }
}
