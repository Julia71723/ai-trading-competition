import type { PortfolioState, BenchmarkState, HistoryPoint } from './types';

/**
 * A complete, pre-computed daily market snapshot.
 *
 * Generated once per trading session at ~4:20 PM ET by the cron endpoint.
 * Stored durably in Vercel Blob and served to every visitor until the next
 * successful update. The frontend never calls market-data APIs directly.
 */
export interface MarketSnapshot {
  snapshotVersion: 1;
  /** ISO timestamp of when this snapshot was generated. */
  generatedAt: string;
  /** YYYY-MM-DD date of the trading session this snapshot covers (ET). */
  asOfMarketDate: string;
  /** Human-readable label, e.g. "Market close July 29, 2026". */
  asOfLabel: string;
  status: 'complete';
  /** Raw closing prices keyed by API symbol. */
  prices: Record<string, number>;
  /** Computed SPY benchmark state. */
  benchmark: BenchmarkState;
  /** All three portfolios, ranked by return, with vsSpyPct. */
  portfolios: PortfolioState[];
  /** Cumulative return history from contest start through asOfMarketDate. */
  chartData: HistoryPoint[];
  metadata: {
    priceProvider: string;
    assetsRequested: number;
    assetsResolved: number;
    durationMs: number;
  };
}
