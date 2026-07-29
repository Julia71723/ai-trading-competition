import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createProvider } from '@/lib/provider';
import { getContestConfig } from '@/lib/contest-config';
import { isContestConfigured } from '@/lib/calculations';
import {
  isMarketDay,
  isAfterMarketClose,
  getEasternDateStr,
} from '@/lib/market-calendar';
import { getLatestMarketSnapshot, saveMarketSnapshot } from '@/lib/snapshot-store';
import { buildMarketSnapshot, validateSnapshot } from '@/lib/snapshot-builder';

// In-process lock to prevent two concurrent requests on the same instance
// from generating duplicate snapshots.
let refreshInProgress = false;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured → allow (dev / staging convenience)
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  const startMs = Date.now();
  const now = new Date();

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const todayET = getEasternDateStr(now);
  console.log(
    `[cron/refresh-market-snapshot] invoked — UTC: ${now.toISOString()}, ET date: ${todayET}`,
  );

  // Guard: must be a market trading day
  if (!isMarketDay(now)) {
    console.log(`[cron/refresh-market-snapshot] not a market day — no-op`);
    return NextResponse.json({ status: 'no-op', reason: 'not-a-market-day', marketDate: todayET });
  }

  // Guard: 4:20 PM ET must have passed (gives market data time to settle)
  if (!isAfterMarketClose(now)) {
    const etStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(now);
    console.log(`[cron/refresh-market-snapshot] before 4:20 PM ET (now ${etStr}) — no-op`);
    return NextResponse.json({ status: 'no-op', reason: 'before-market-close', etTime: etStr, marketDate: todayET });
  }

  // Guard: prevent concurrent builds on this instance
  if (refreshInProgress) {
    console.log(`[cron/refresh-market-snapshot] refresh already in progress — no-op`);
    return NextResponse.json({ status: 'no-op', reason: 'already-in-progress', marketDate: todayET });
  }

  // Idempotency: if a complete snapshot for today already exists, exit cleanly
  const prevSnapshot = await getLatestMarketSnapshot();
  if (prevSnapshot?.asOfMarketDate === todayET) {
    console.log(
      `[cron/refresh-market-snapshot] snapshot for ${todayET} already saved (generated ${prevSnapshot.generatedAt}) — no-op`,
    );
    return NextResponse.json({ status: 'no-op', reason: 'already-complete', marketDate: todayET });
  }

  // Guard: contest must have start prices configured
  const config = getContestConfig();
  if (!isContestConfigured(config)) {
    console.log(`[cron/refresh-market-snapshot] contest not yet configured — no-op`);
    return NextResponse.json({ status: 'no-op', reason: 'contest-not-configured', marketDate: todayET });
  }

  refreshInProgress = true;
  console.log(`[cron/refresh-market-snapshot] building snapshot for ${todayET}`);

  try {
    const provider = await createProvider();
    const snapshot = await buildMarketSnapshot(config, provider, prevSnapshot);

    // Validate before touching the stored snapshot
    const errors = validateSnapshot(snapshot);
    if (errors.length > 0) {
      console.error(`[cron/refresh-market-snapshot] validation failed — previous snapshot preserved`);
      for (const e of errors) console.error(`  • ${e}`);
      return NextResponse.json(
        { status: 'error', reason: 'validation-failed', errors, marketDate: todayET },
        { status: 422 },
      );
    }

    // Write atomically (throws on failure — previous snapshot untouched)
    await saveMarketSnapshot(snapshot);
    console.log(`[cron/refresh-market-snapshot] snapshot saved for ${todayET}`);

    // Invalidate the Next.js in-memory cache so the next page load reads fresh data
    revalidateTag('market-snapshot');

    const durationMs = Date.now() - startMs;
    console.log(
      `[cron/refresh-market-snapshot] complete in ${durationMs}ms — ` +
      `${snapshot.metadata.assetsResolved}/${snapshot.metadata.assetsRequested} assets`,
    );

    return NextResponse.json({
      status: 'updated',
      marketDate: todayET,
      generatedAt: snapshot.generatedAt,
      assetsResolved: snapshot.metadata.assetsResolved,
      assetsRequested: snapshot.metadata.assetsRequested,
      durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron/refresh-market-snapshot] unexpected error:`, message);
    return NextResponse.json(
      { status: 'error', reason: message, marketDate: todayET },
      { status: 500 },
    );
  } finally {
    refreshInProgress = false;
  }
}
