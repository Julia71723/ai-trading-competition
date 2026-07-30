import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MarketSnapshot } from '../lib/snapshot';

// Mock @vercel/blob BEFORE importing snapshot-store so the mock is in place
// when the module is first evaluated.
vi.mock('@vercel/blob', () => ({
  put: vi.fn().mockResolvedValue({ url: 'https://blob.example.com/test' }),
  get: vi.fn().mockResolvedValue(null),
}));

// Dynamic import so the mock above applies
const { saveMarketSnapshot } = await import('../lib/snapshot-store');
const { put, get } = await import('@vercel/blob');

function makeMinimalSnapshot(date = '2026-07-28'): MarketSnapshot {
  return {
    snapshotVersion: 1,
    generatedAt: '2026-07-28T20:30:00.000Z',
    asOfMarketDate: date,
    asOfLabel: `Market close July 28, 2026`,
    status: 'complete',
    prices: { SPY: 740.86 },
    benchmark: {
      startPrice: 738.93,
      quantity: 13.533,
      currentPrice: 740.86,
      totalValue: 10026.15,
      returnPct: 0.2615,
    },
    portfolios: [],
    chartData: [],
    metadata: {
      priceProvider: 'test',
      assetsRequested: 11,
      assetsResolved: 11,
      durationMs: 42,
    },
  };
}

describe('saveMarketSnapshot — private Blob access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  });

  it('calls put for market-snapshots/latest.json with access: private', async () => {
    await saveMarketSnapshot(makeMinimalSnapshot());
    expect(put).toHaveBeenCalledWith(
      'market-snapshots/latest.json',
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    );
  });

  it('calls put for the cumulative archive path with access: private', async () => {
    await saveMarketSnapshot(makeMinimalSnapshot());
    expect(put).toHaveBeenCalledWith(
      'market-snapshots/archive.json',
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    );
  });

  it('passes allowOverwrite: true to both put calls so existing blobs can be replaced', async () => {
    await saveMarketSnapshot(makeMinimalSnapshot());
    const mockPut = put as ReturnType<typeof vi.fn>;
    for (const callArgs of mockPut.mock.calls) {
      const opts = callArgs[2] as Record<string, unknown>;
      expect(opts.allowOverwrite).toBe(true);
    }
  });

  it('never passes access: public to any put call', async () => {
    await saveMarketSnapshot(makeMinimalSnapshot());
    const mockPut = put as ReturnType<typeof vi.fn>;
    for (const callArgs of mockPut.mock.calls) {
      const opts = callArgs[2] as Record<string, unknown>;
      expect(opts.access).not.toBe('public');
    }
  });

  it('makes exactly two put calls: latest + archive', async () => {
    await saveMarketSnapshot(makeMinimalSnapshot());
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('serialises snapshot JSON into the put body', async () => {
    const snap = makeMinimalSnapshot();
    await saveMarketSnapshot(snap);
    const mockPut = put as ReturnType<typeof vi.fn>;
    const body = mockPut.mock.calls[0][1] as string;
    const parsed = JSON.parse(body) as MarketSnapshot;
    expect(parsed.asOfMarketDate).toBe('2026-07-28');
    expect(parsed.snapshotVersion).toBe(1);
  });
});

// ── Archive merge / idempotency ───────────────────────────────────────────────

describe('saveMarketSnapshot — archive preserves prior trading dates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  });

  it('preserves earlier snapshot dates when archive.json is written a second time', async () => {
    const mockGet = get as ReturnType<typeof vi.fn>;
    const mockPut = put as ReturnType<typeof vi.fn>;

    const jul28 = makeMinimalSnapshot('2026-07-28');
    const jul29 = makeMinimalSnapshot('2026-07-29');

    // First save: archive does not exist yet (get returns null/undefined after clearAllMocks)
    await saveMarketSnapshot(jul28);

    // Capture what was written to archive.json during the first save
    const firstArchiveBody = mockPut.mock.calls.find(
      (args) => (args[0] as string) === 'market-snapshots/archive.json',
    )?.[1] as string;
    expect(firstArchiveBody).toBeDefined();
    expect(JSON.parse(firstArchiveBody)).toHaveLength(1);

    // Second save: simulate archive.json already containing jul28
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) { c.enqueue(encoder.encode(firstArchiveBody)); c.close(); },
    });
    mockGet.mockResolvedValueOnce({ statusCode: 200, stream });

    await saveMarketSnapshot(jul29);

    // Both archive writes should have happened
    const archivePuts = mockPut.mock.calls.filter(
      (args) => (args[0] as string) === 'market-snapshots/archive.json',
    );
    expect(archivePuts).toHaveLength(2);

    // The second archive write must include both trading dates
    const secondArchive = JSON.parse(archivePuts[1][1] as string) as MarketSnapshot[];
    const dates = secondArchive.map((s) => s.asOfMarketDate);
    expect(dates).toContain('2026-07-28');
    expect(dates).toContain('2026-07-29');
    expect(secondArchive).toHaveLength(2);
  });

  it('replaces an existing entry for the same date rather than duplicating it', async () => {
    const mockGet = get as ReturnType<typeof vi.fn>;
    const mockPut = put as ReturnType<typeof vi.fn>;

    const jul29v1 = makeMinimalSnapshot('2026-07-29');
    const jul29v2 = { ...makeMinimalSnapshot('2026-07-29'), generatedAt: '2026-07-30T11:05:00.000Z' };

    // First save
    await saveMarketSnapshot(jul29v1);

    const firstBody = mockPut.mock.calls.find(
      (args) => (args[0] as string) === 'market-snapshots/archive.json',
    )?.[1] as string;

    // Second save of the same date: simulate archive containing the first version
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) { c.enqueue(encoder.encode(firstBody)); c.close(); },
    });
    mockGet.mockResolvedValueOnce({ statusCode: 200, stream });

    await saveMarketSnapshot(jul29v2);

    const archivePuts = mockPut.mock.calls.filter(
      (args) => (args[0] as string) === 'market-snapshots/archive.json',
    );
    const secondArchive = JSON.parse(archivePuts[1][1] as string) as MarketSnapshot[];

    // Should have exactly one entry for July 29 (replaced, not duplicated)
    expect(secondArchive.filter((s) => s.asOfMarketDate === '2026-07-29')).toHaveLength(1);
    // The entry should be the newer version
    expect(secondArchive[0].generatedAt).toBe('2026-07-30T11:05:00.000Z');
  });
});
