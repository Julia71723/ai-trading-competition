import { NextResponse } from 'next/server';
import { getLatestMarketSnapshot } from '@/lib/snapshot-store';

// Always read fresh from Blob — never serve a stale CDN-cached copy of this
// endpoint, since a fresh snapshot may have just been written.
export const dynamic = 'force-dynamic';

/**
 * GET /api/market-snapshot
 *
 * Returns the latest complete market snapshot from Vercel Blob.
 * Read-only — never calls external market-data APIs.
 * Used for debugging and admin verification; the main page reads the
 * snapshot server-side via page.tsx.
 */
export async function GET(): Promise<NextResponse> {
  const snapshot = await getLatestMarketSnapshot();

  if (!snapshot) {
    return NextResponse.json(
      {
        error: 'No snapshot available yet. Trigger the cron endpoint manually to generate the first snapshot.',
        hint: 'GET /api/cron/refresh-market-snapshot (with CRON_SECRET header if configured)',
      },
      { status: 404 },
    );
  }

  return NextResponse.json(snapshot, {
    headers: {
      // Short CDN cache: a new snapshot is only written once per day, but allow
      // browsers to avoid redundant round-trips within the same minute.
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
