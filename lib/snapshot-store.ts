import { put, get } from '@vercel/blob';
import type { MarketSnapshot } from './snapshot';

const LATEST_PATH = 'market-snapshots/latest.json';
const ARCHIVE_PREFIX = 'market-snapshots/';

/**
 * Read the most recently saved market snapshot from Vercel Blob (private store).
 * Uses the server-side BLOB_READ_WRITE_TOKEN — never called from the browser.
 * Returns null if no snapshot exists or the store is not configured.
 */
export async function getLatestMarketSnapshot(): Promise<MarketSnapshot | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn('[snapshot-store] BLOB_READ_WRITE_TOKEN is not set — snapshot store unavailable');
    return null;
  }
  try {
    // get() by pathname resolves the store from BLOB_READ_WRITE_TOKEN automatically.
    // Returns null when the blob does not exist yet.
    const result = await get(LATEST_PATH, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    // Consume the ReadableStream server-side; never sent to the browser directly.
    return (await new Response(result.stream).json()) as MarketSnapshot;
  } catch (err) {
    console.error('[snapshot-store] read error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Write snapshot to Vercel Blob (private store).
 * Saves to a stable "latest" path (overwriting the previous) and also
 * archives the snapshot under its market date.
 * Throws on "latest" write failure so callers can preserve the previous snapshot.
 */
export async function saveMarketSnapshot(snapshot: MarketSnapshot): Promise<void> {
  const body = JSON.stringify(snapshot);
  const opts = {
    access: 'private' as const,
    contentType: 'application/json',
    addRandomSuffix: false,
  };

  // Write "latest" first; throw on failure (caller must not replace previous snapshot)
  await put(LATEST_PATH, body, opts);

  // Best-effort archive — failure here does not corrupt the latest snapshot
  const archivePath = `${ARCHIVE_PREFIX}${snapshot.asOfMarketDate}.json`;
  await put(archivePath, body, opts).catch((err) => {
    console.warn(
      '[snapshot-store] archive write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  });
}
