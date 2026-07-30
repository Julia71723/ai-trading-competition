import type { DailyBar } from './types';

/** Adapter interface — swap the implementation without touching the UI. */
export interface MarketDataProvider {
  /**
   * Fetch the latest price for each symbol.
   * Returns a map of apiSymbol → price. Missing symbols are omitted.
   */
  getLatestPrices(symbols: string[]): Promise<Record<string, number>>;

  /**
   * Fetch daily OHLCV bars for one symbol from startDate through endDate (inclusive).
   * Dates are ISO date strings: "YYYY-MM-DD".
   */
  getDailyBars(symbol: string, startDate: string, endDate: string): Promise<DailyBar[]>;

  /**
   * Fetch daily OHLCV bars for multiple symbols in a single batch request.
   * Returns a map of apiSymbol → bars array.
   */
  getDailyBarsBatch(
    symbols: string[],
    startDate: string,
    endDate: string,
  ): Promise<Record<string, DailyBar[]>>;

}

export async function createProvider(): Promise<MarketDataProvider> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'TWELVE_DATA_API_KEY environment variable is not set. ' +
      'Add it to .env.local for local development or to your Vercel project settings.',
    );
  }
  const { TwelveDataProvider } = await import('./twelve-data');
  return new TwelveDataProvider(apiKey);
}
