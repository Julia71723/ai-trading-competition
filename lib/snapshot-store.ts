import { put, get } from '@vercel/blob';
import type { MarketSnapshot } from './snapshot';

const LATEST_PATH = 'market-snapshots/latest.json';
const ARCHIVE_PATH = 'market-snapshots/archive.json';

const BLOB_OPTS = {
  access: 'private' as const,
  contentType: 'application/json',
  addRandomSuffix: false,
  allowOverwrite: true,
};

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
    const result = await get(LATEST_PATH, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return (await new Response(result.stream).json()) as MarketSnapshot;
  } catch (err) {
    console.error('[snapshot-store] read error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Read the accumulated snapshot archive. Returns an empty array when the archive
 * does not yet exist or cannot be read (first-run, network error, etc.).
 */
async function readArchive(): Promise<MarketSnapshot[]> {
  try {
    const result = await get(ARCHIVE_PATH, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return [];
    return (await new Response(result.stream).json()) as MarketSnapshot[];
  } catch {
    return [];
  }
}

/**
 * Write snapshot to Vercel Blob (private store).
 *
 * Always overwrites the stable "latest" path so `getLatestMarketSnapshot` stays
 * current. Also maintains a single `archive.json` that accumulates one entry per
 * trading date: the existing archive is read first, the new snapshot replaces any
 * existing entry for the same date (or is appended), and the merged result is
 * written back — so prior dates are never lost and repeated runs are idempotent.
 *
 * Throws on "latest" write failure so callers preserve the previous snapshot.
 * Archive write failure is non-fatal and only logged.
 */
export async function saveMarketSnapshot(snapshot: MarketSnapshot): Promise<void> {
  const body = JSON.stringify(snapshot);

  // Write "latest" first; throw on failure so the caller does not advance storedDate.
  await put(LATEST_PATH, body, BLOB_OPTS);

  // Read → merge → write archive so prior trading dates are always preserved.
  try {
    const existing = await readArchive();
    const merged = [
      ...existing.filter((s) => s.asOfMarketDate !== snapshot.asOfMarketDate),
      snapshot,
    ].sort((a, b) => a.asOfMarketDate.localeCompare(b.asOfMarketDate));
    await put(ARCHIVE_PATH, JSON.stringify(merged), BLOB_OPTS);
  } catch (err) {
    console.warn(
      '[snapshot-store] archive write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}
