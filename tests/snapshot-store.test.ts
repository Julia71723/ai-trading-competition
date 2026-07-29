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
const { put } = await import('@vercel/blob');

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

  it('calls put for the dated archive path with access: private', async () => {
    await saveMarketSnapshot(makeMinimalSnapshot());
    expect(put).toHaveBeenCalledWith(
      'market-snapshots/2026-07-28.json',
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    );
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
