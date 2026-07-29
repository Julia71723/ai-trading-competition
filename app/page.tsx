import { unstable_cache } from 'next/cache';
import { getContestConfig, getStartDateStr } from '@/lib/contest-config';
import { getLatestMarketSnapshot } from '@/lib/snapshot-store';
import { getLatestCompletedMarketDate } from '@/lib/market-calendar';
import {
  computeAllPortfolioStates,
  computeBenchmarkState,
  isContestConfigured,
} from '@/lib/calculations';
import { Dashboard } from '@/components/Dashboard';
import type { PortfolioState, BenchmarkState } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Cache the Vercel Blob read for up to 5 minutes; invalidated by revalidateTag
// after each cron write so visitors see fresh data within one Next.js request cycle.
const getCachedSnapshot = unstable_cache(
  getLatestMarketSnapshot,
  ['market-snapshot'],
  { tags: ['market-snapshot'], revalidate: 300 },
);

export default async function Page() {
  const config = getContestConfig();
  const snapshot = await getCachedSnapshot();

  const latestExpected = getLatestCompletedMarketDate();
  const isStale =
    snapshot !== null &&
    latestExpected !== null &&
    snapshot.asOfMarketDate < latestExpected;

  // When no snapshot exists but the contest is configured, pre-compute baseline
  // portfolio states (start prices == current prices → all returns = 0%).
  // These are passed to the dashboard so it can render the full leaderboard and
  // portfolio cards at the $10,000 baseline before the first daily cron runs.
  let baselinePortfolios: PortfolioState[] | undefined;
  let baselineBenchmark: BenchmarkState | undefined;

  if (!snapshot && isContestConfigured(config)) {
    const startPrices = config.startPrices as Record<string, number>;
    const startDateStr = getStartDateStr(config);
    baselinePortfolios = computeAllPortfolioStates(config, startPrices);
    baselineBenchmark = computeBenchmarkState(config, startPrices);
    // Annotate with the purchase date so Dashboard can show it in the chart
    void startDateStr;
  }

  return (
    <Dashboard
      contestConfig={config}
      snapshot={snapshot}
      isStale={isStale}
      baselinePortfolios={baselinePortfolios}
      baselineBenchmark={baselineBenchmark}
    />
  );
}
