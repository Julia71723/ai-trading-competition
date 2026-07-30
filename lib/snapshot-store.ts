import { put, get, list } from '@vercel/blob';
import type { MarketSnapshot } from './snapshot';

const LATEST_PATH = 'market-snapshots/latest.json';
const ARCHIVE_PATH = 'market-snapshots/archive.json';

// Matches the old per-date archive filenames: market-snapshots/YYYY-MM-DD.json
const LEGACY_DATE_RE = /market-snapshots\/\d{4}-\d{2}-\d{2}\.json$/;

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
 * One-time migration: when archive.json does not yet exist, enumerate the old
 * per-date archive files (market-snapshots/YYYY-MM-DD.json) and read each one.
 * Returns them sorted chronologically so the first archive.json write contains
 * the full history rather than only the newest date.
 */
async function readLegacyArchives(): Promise<MarketSnapshot[]> {
  try {
    const { blobs } = await list({ prefix: 'market-snapshots/', limit: 1000 });
    const dateBlobs = blobs
      .filter((b) => LEGACY_DATE_RE.test(b.pathname))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));

    if (dateBlobs.length === 0) return [];

    const snapshots: MarketSnapshot[] = [];
    for (const blob of dateBlobs) {
      try {
        const result = await get(blob.pathname, { access: 'private' });
        if (result?.statusCode === 200 && result.stream) {
          snapshots.push((await new Response(result.stream).json()) as MarketSnapshot);
        }
      } catch {
        // skip files that can't be read individually
      }
    }

    if (snapshots.length > 0) {
      console.log(
        `[snapshot-store] seeding archive.json from ${snapshots.length} legacy per-date file(s)`,
      );
    }
    return snapshots;
  } catch {
    return [];
  }
}

/**
 * Read the accumulated snapshot archive.
 * When archive.json does not yet exist, falls back to the legacy per-date files
 * so that July 24 and July 28 (stored in the old format) are not lost on the
 * first write under the new system.
 * Returns an empty array on any error.
 */
async function readArchive(): Promise<MarketSnapshot[]> {
  try {
    const result = await get(ARCHIVE_PATH, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return await readLegacyArchives();
    }
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
 * trading date: the existing archive is read first (falling back to legacy per-date
 * files on the first run), the new snapshot replaces any existing entry for the
 * same date (or is appended), and the merged result is written back — so prior
 * dates are never lost and repeated runs are idempotent.
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
