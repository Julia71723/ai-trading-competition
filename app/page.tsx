import { unstable_cache } from 'next/cache';
import { getContestConfig } from '@/lib/contest-config';
import { getLatestMarketSnapshot } from '@/lib/snapshot-store';
import { getLatestCompletedMarketDate } from '@/lib/market-calendar';
import { Dashboard } from '@/components/Dashboard';

// Re-read the snapshot on every request (force-dynamic) rather than relying on
// build-time static generation. The unstable_cache below provides an in-memory
// short-circuit across concurrent requests within the same instance and is
// invalidated by revalidateTag('market-snapshot') after each cron write.
export const dynamic = 'force-dynamic';

// Cache the Vercel Blob read for up to 5 minutes so concurrent page requests
// don't all hit the Blob API simultaneously. The cron endpoint invalidates this
// cache immediately after writing a new snapshot.
const getCachedSnapshot = unstable_cache(
  getLatestMarketSnapshot,
  ['market-snapshot'],
  { tags: ['market-snapshot'], revalidate: 300 },
);

export default async function Page() {
  const config = getContestConfig();
  const snapshot = await getCachedSnapshot();

  // Warn when the snapshot is older than the latest expected trading-session close.
  const latestExpected = getLatestCompletedMarketDate();
  const isStale =
    snapshot !== null &&
    latestExpected !== null &&
    snapshot.asOfMarketDate < latestExpected;

  return <Dashboard contestConfig={config} snapshot={snapshot} isStale={isStale} />;
}
