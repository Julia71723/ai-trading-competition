import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createProvider } from '@/lib/provider';
import { getContestConfig, getStartDateStr } from '@/lib/contest-config';
import { isContestConfigured } from '@/lib/calculations';
import { getLatestCompletedMarketDate, getMarketDaysBetween } from '@/lib/market-calendar';
import { getLatestMarketSnapshot, saveMarketSnapshot } from '@/lib/snapshot-store';
import { buildSnapshotsForDates, validateSnapshot } from '@/lib/snapshot-builder';

// In-process lock to prevent two concurrent requests on the same instance
// from generating duplicate snapshots.
let refreshInProgress = false;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured → allow (dev / staging convenience)
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

/**
 * Refreshes the market snapshot for every trading day since the last stored one.
 * Stocks (8 symbols) are fetched from Twelve Data; crypto (BTC/USD, ETH/USD, SOL/USD)
 * from Coinbase Exchange public candles — a completely separate API with no shared
 * rate limit. Both fetches run in parallel within a single invocation with no
 * artificial delays. Because the cron may run less often than trading days pass
 * (deploy gaps, failures), it always catches up in chronological order.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const startMs = Date.now();
  const now = new Date();
  const invokedAtUtc = now.toISOString();

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  console.log(`[cron/refresh-market-snapshot] invoked — UTC: ${invokedAtUtc}`);

  const latestCompleted = getLatestCompletedMarketDate(now);
  console.log(`[cron/refresh-market-snapshot] latest completed trading date (ET): ${latestCompleted ?? 'none'}`);

  if (!latestCompleted) {
    console.log(`[cron/refresh-market-snapshot] result: no-op — no completed trading day found`);
    return NextResponse.json({ status: 'no-op', reason: 'no-completed-trading-day' });
  }

  const config = getContestConfig();
  if (!isContestConfigured(config)) {
    console.log(`[cron/refresh-market-snapshot] result: no-op — contest not yet configured`);
    return NextResponse.json({ status: 'no-op', reason: 'contest-not-configured', latestCompleted });
  }

  const startDate = getStartDateStr(config);
  if (latestCompleted < startDate) {
    console.log(`[cron/refresh-market-snapshot] result: no-op — contest has not started yet`);
    return NextResponse.json({ status: 'no-op', reason: 'contest-not-started', latestCompleted });
  }

  if (refreshInProgress) {
    console.log(`[cron/refresh-market-snapshot] result: no-op — refresh already in progress`);
    return NextResponse.json({ status: 'no-op', reason: 'already-in-progress', latestCompleted });
  }

  refreshInProgress = true;

  try {
    const prevSnapshot = await getLatestMarketSnapshot();
    const storedDate = prevSnapshot?.asOfMarketDate ?? null;
    console.log(`[cron/refresh-market-snapshot] stored snapshot date: ${storedDate ?? 'none'}`);

    // Determine every trading day that needs a snapshot, in chronological order.
    let missingDates: string[];
    if (storedDate === null) {
      // Never run before: build the full history from the contest start.
      missingDates = [startDate, ...getMarketDaysBetween(startDate, latestCompleted)];
    } else if (storedDate === latestCompleted) {
      // Same trading date invoked again (e.g. re-triggered same day):
      // rebuild just that one date so it replaces, not duplicates.
      missingDates = [latestCompleted];
    } else if (storedDate < latestCompleted) {
      missingDates = getMarketDaysBetween(storedDate, latestCompleted);
    } else {
      // Stored date is somehow ahead of the latest completed date — nothing to do.
      missingDates = [];
    }

    if (missingDates.length === 0) {
      console.log(`[cron/refresh-market-snapshot] result: no-op — already up to date through ${storedDate}`);
      return NextResponse.json({
        status: 'no-op',
        reason: 'already-complete',
        latestCompleted,
        storedDate,
      });
    }

    console.log(
      `[cron/refresh-market-snapshot] catching up ${missingDates.length} trading day(s): ${missingDates.join(', ')}`,
    );

    const provider = await createProvider();
    const snapshots = await buildSnapshotsForDates(config, provider, prevSnapshot, missingDates);

    const savedDates: string[] = [];
    for (const snapshot of snapshots) {
      const errors = validateSnapshot(snapshot);
      if (errors.length > 0) {
        console.error(
          `[cron/refresh-market-snapshot] validation failed for ${snapshot.asOfMarketDate} — ` +
          `stopping catch-up, all prior snapshots in this run remain saved`,
        );
        for (const e of errors) console.error(`  • ${e}`);
        console.log(`[cron/refresh-market-snapshot] result: error — validation-failed on ${snapshot.asOfMarketDate}`);
        return NextResponse.json(
          {
            status: 'error',
            reason: 'validation-failed',
            date: snapshot.asOfMarketDate,
            errors,
            savedDates,
            latestCompleted,
            storedDate,
          },
          { status: 422 },
        );
      }

      // Write atomically per date — a failure here leaves the previous
      // "latest" snapshot untouched and every already-saved date archived.
      await saveMarketSnapshot(snapshot);
      savedDates.push(snapshot.asOfMarketDate);
      console.log(`[cron/refresh-market-snapshot] snapshot saved for ${snapshot.asOfMarketDate}`);
    }

    // Invalidate the Next.js in-memory cache so the next page load reads fresh data
    revalidateTag('market-snapshot');

    const durationMs = Date.now() - startMs;
    const finalSnapshot = snapshots[snapshots.length - 1];
    console.log(
      `[cron/refresh-market-snapshot] result: updated — saved ${savedDates.length} snapshot(s) ` +
      `(${savedDates.join(', ')}), latest is now ${finalSnapshot.asOfMarketDate}, took ${durationMs}ms`,
    );

    return NextResponse.json({
      status: 'updated',
      invokedAtUtc,
      latestCompleted,
      storedDate,
      savedDates,
      generatedAt: finalSnapshot.generatedAt,
      assetsResolved: finalSnapshot.metadata.assetsResolved,
      assetsRequested: finalSnapshot.metadata.assetsRequested,
      durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron/refresh-market-snapshot] unexpected error:`, message);
    console.log(`[cron/refresh-market-snapshot] result: error — ${message}`);
    return NextResponse.json({ status: 'error', reason: message, latestCompleted }, { status: 500 });
  } finally {
    refreshInProgress = false;
  }
}
