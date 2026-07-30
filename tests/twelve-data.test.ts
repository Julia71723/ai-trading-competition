import { vi, describe, it, expect, beforeEach } from 'vitest';

// Replace global.fetch before any test. fetchWithTimeout calls fetch() at
// runtime (not at import time), so the stub is in place by the time any
// test method runs even though imports are hoisted.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { TwelveDataProvider } from '../lib/twelve-data';

const provider = new TwelveDataProvider('test-api-key');

function makeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: { get: vi.fn().mockReturnValue(null) },
  };
}

function makeBar(date: string, close: number) {
  return {
    datetime: date,
    open: String(close), high: String(close), low: String(close),
    close: String(close), volume: '1000000',
  };
}

beforeEach(() => vi.clearAllMocks());

// ── Exact-date request format ─────────────────────────────────────────────────

describe('getDailyBarsBatch — exact-date request format', () => {
  it('uses date= parameter for a single-date request (not start_date/end_date)', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      SPY: { values: [makeBar('2026-07-29', 741)], status: 'ok' },
    }));
    await provider.getDailyBarsBatch(['SPY'], '2026-07-29', '2026-07-29');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('date=2026-07-29');
    expect(url).not.toContain('start_date');
    expect(url).not.toContain('end_date');
  });

  it('uses start_date/end_date for multi-date range requests', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      SPY: {
        values: [makeBar('2026-07-29', 741), makeBar('2026-07-30', 742)],
        status: 'ok',
      },
    }));
    await provider.getDailyBarsBatch(['SPY'], '2026-07-29', '2026-07-30');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('start_date=2026-07-29');
    expect(url).toContain('end_date=2026-07-30');
    expect(url).not.toContain('&date=');
  });

  it('does not include outputsize in single-date requests', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      SPY: { values: [makeBar('2026-07-29', 741)], status: 'ok' },
    }));
    await provider.getDailyBarsBatch(['SPY'], '2026-07-29', '2026-07-29');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('outputsize');
  });
});

// ── Returned-date validation ──────────────────────────────────────────────────

describe('getDailyBarsBatch — returned-date validation', () => {
  it('accepts bars whose date matches the requested single date', async () => {
    // Single-symbol response: Twelve Data returns { values, status } at the top
    // level (not wrapped in a symbol key like the batch format does).
    fetchMock.mockResolvedValue(makeResponse({
      values: [makeBar('2026-07-29', 741)], status: 'ok',
    }));
    const result = await provider.getDailyBarsBatch(['SPY'], '2026-07-29', '2026-07-29');
    expect(result['SPY']).toHaveLength(1);
    expect(result['SPY'][0].date).toBe('2026-07-29');
    expect(result['SPY'][0].close).toBe(741);
  });

  it('discards bars whose date does not match the requested single date', async () => {
    // Twelve Data may return the previous day's close before today's EOD is published
    fetchMock.mockResolvedValue(makeResponse({
      SPY: { values: [makeBar('2026-07-28', 740)], status: 'ok' },
    }));
    const result = await provider.getDailyBarsBatch(['SPY'], '2026-07-29', '2026-07-29');
    expect(result['SPY']).toHaveLength(0);
  });

  it('does not apply date filtering for range requests', async () => {
    // Single-symbol range response: top-level { values, status }
    fetchMock.mockResolvedValue(makeResponse({
      values: [makeBar('2026-07-28', 739), makeBar('2026-07-29', 741)],
      status: 'ok',
    }));
    const result = await provider.getDailyBarsBatch(['SPY'], '2026-07-28', '2026-07-29');
    // Both bars should be returned — date filtering only applies to single-date queries
    expect(result['SPY']).toHaveLength(2);
  });

  it('discards wrong-date bars for all symbols in a batch single-date request', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      SPY:  { values: [makeBar('2026-07-29', 741)], status: 'ok' },
      NVDA: { values: [makeBar('2026-07-28', 200)], status: 'ok' }, // wrong date
    }));
    const result = await provider.getDailyBarsBatch(['SPY', 'NVDA'], '2026-07-29', '2026-07-29');
    expect(result['SPY']).toHaveLength(1);
    expect(result['NVDA']).toHaveLength(0);
  });
});

// ── Error propagation ─────────────────────────────────────────────────────────

describe('getDailyBarsBatch — error propagation', () => {
  it('throws on top-level API error (HTTP 200 with status:error)', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      status: 'error',
      message: 'You have run out of API credits for the current period.',
      code: 429,
    }));
    await expect(
      provider.getDailyBarsBatch(['SPY', 'NVDA'], '2026-07-29', '2026-07-29'),
    ).rejects.toThrow('Twelve Data API error');
  });

  it('throws on per-symbol error instead of silently returning empty bars', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      SPY:  { values: [makeBar('2026-07-29', 741)], status: 'ok' },
      NVDA: { status: 'error', message: 'No data is available on the specified dates.' },
    }));
    await expect(
      provider.getDailyBarsBatch(['SPY', 'NVDA'], '2026-07-29', '2026-07-29'),
    ).rejects.toThrow('Twelve Data batch failure');
  });

  it('throws on HTTP 4xx errors', async () => {
    fetchMock.mockResolvedValue(makeResponse('Unauthorized', 401));
    await expect(
      provider.getDailyBarsBatch(['SPY'], '2026-07-29', '2026-07-29'),
    ).rejects.toThrow('Twelve Data /time_series returned HTTP 401');
  });
});
