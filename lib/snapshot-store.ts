import { put, list } from '@vercel/blob';
import type { MarketSnapshot } from './snapshot';

const LATEST_PATH = 'market-snapshots/latest.json';
const ARCHIVE_PREFIX = 'market-snapshots/';

/**
 * Read the most recently saved market snapshot from Vercel Blob.
 * Returns null if no snapshot exists or the store is not configured.
 */
export async function getLatestMarketSnapshot(): Promise<MarketSnapshot | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn('[snapshot-store] BLOB_READ_WRITE_TOKEN is not set — snapshot store unavailable');
    return null;
  }
  try {
    const { blobs } = await list({ prefix: LATEST_PATH, limit: 1 });
    if (blobs.length === 0) return null;
    // Public blob: fetch the CDN URL without authentication
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) {
      console.error(`[snapshot-store] blob fetch failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as MarketSnapshot;
  } catch (err) {
    console.error('[snapshot-store] read error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Write snapshot to Vercel Blob.
 * Saves to a stable "latest" path (overwriting the previous) and also
 * archives the snapshot under its market date.
 * Throws on write failure — callers must not replace the previous snapshot
 * if this throws.
 */
export async function saveMarketSnapshot(snapshot: MarketSnapshot): Promise<void> {
  const body = JSON.stringify(snapshot);
  const opts = {
    access: 'public' as const,
    contentType: 'application/json',
    addRandomSuffix: false,
  };

  // Write "latest" first; if it fails, throw before archiving
  await put(LATEST_PATH, body, opts);

  // Best-effort archive — a failure here does not corrupt the latest snapshot
  const archivePath = `${ARCHIVE_PREFIX}${snapshot.asOfMarketDate}.json`;
  await put(archivePath, body, opts).catch((err) => {
    console.warn('[snapshot-store] archive write failed (non-fatal):', err instanceof Error ? err.message : err);
  });
}
