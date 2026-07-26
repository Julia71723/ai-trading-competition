export interface ContestConfig {
  contestName: string;
  officialPurchaseTimestamp: string;
  endTimestamp: string;
  startingValue: number;
  benchmarkSymbol: string;
  startPrices: Record<string, number | null>;
}

export type AssetClass = 'stock' | 'crypto';

export interface Holding {
  name: string;
  ticker: string;
  apiSymbol: string;
  assetClass: AssetClass;
  allocation: number;
  weight: number;
}

export interface Portfolio {
  id: string;
  name: string;
  color: string;
  holdings: Holding[];
}

/** Computed state for one holding at a point in time. */
export interface HoldingState {
  holding: Holding;
  startPrice: number | null;
  quantity: number | null;
  currentPrice: number | null;
  positionValue: number | null;
  gainLoss: number | null;
  returnPct: number | null;
  portfolioContribution: number | null;
}

/** Computed state for one portfolio at a point in time. */
export interface PortfolioState {
  portfolio: Portfolio;
  holdings: HoldingState[];
  totalValue: number | null;
  gainLoss: number | null;
  returnPct: number | null;
  rank: number;
  vsSpyPct: number | null;
  bestHolding: HoldingState | null;
  worstHolding: HoldingState | null;
}

export interface BenchmarkState {
  startPrice: number | null;
  quantity: number | null;
  currentPrice: number | null;
  totalValue: number | null;
  returnPct: number | null;
}

/** Latest prices keyed by API symbol. */
export type Prices = Record<string, number>;

/** One point in the performance chart time series. */
export interface HistoryPoint {
  date: string;
  chatgpt: number | null;
  claude: number | null;
  gemini: number | null;
  spy: number | null;
}

/** A single OHLCV bar from the market-data provider. */
export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Response shape from /api/market-data. */
export interface MarketDataResponse {
  prices: Prices;
  timestamp: string;
  isFresh: boolean;
  error?: string;
}

/** Response shape from /api/market-history. */
export interface MarketHistoryResponse {
  /** date → symbol → close price (forward-filled for stocks) */
  dailyPrices: Record<string, Record<string, number>>;
  dates: string[];
  timestamp: string;
  isFresh: boolean;
  error?: string;
}

export interface SharedHolding {
  apiSymbol: string;
  ticker: string;
  name: string;
  assetClass: AssetClass;
  portfolioIds: string[];
  portfolioNames: string[];
}
