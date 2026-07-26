import type {
  Portfolio,
  Prices,
  HoldingState,
  PortfolioState,
  BenchmarkState,
  SharedHolding,
  ContestConfig,
} from './types';
import { PORTFOLIOS } from './portfolios';

/** quantity = allocation / startPrice */
export function computeQuantity(allocation: number, startPrice: number): number {
  return allocation / startPrice;
}

/** positionValue = quantity * currentPrice */
export function computePositionValue(quantity: number, currentPrice: number): number {
  return quantity * currentPrice;
}

/** returnPct = (currentValue / startingValue - 1) * 100 */
export function computeReturnPct(currentValue: number, startingValue: number): number {
  return (currentValue / startingValue - 1) * 100;
}

/** Contribution of one holding to the portfolio's total return (%). */
export function computePortfolioContribution(
  gainLoss: number,
  startingPortfolioValue: number,
): number {
  return (gainLoss / startingPortfolioValue) * 100;
}

/** Compute full state for one holding given start and current prices. */
export function computeHoldingState(
  holding: { name: string; ticker: string; apiSymbol: string; assetClass: string; allocation: number; weight: number },
  startPrices: Record<string, number | null>,
  currentPrices: Prices,
  startingPortfolioValue: number,
): HoldingState {
  const startPrice = startPrices[holding.apiSymbol] ?? null;
  const currentPrice = currentPrices[holding.apiSymbol] ?? null;

  const quantity = startPrice !== null ? computeQuantity(holding.allocation, startPrice) : null;
  const positionValue = quantity !== null && currentPrice !== null
    ? computePositionValue(quantity, currentPrice)
    : null;
  const gainLoss = positionValue !== null ? positionValue - holding.allocation : null;
  const returnPct = positionValue !== null
    ? computeReturnPct(positionValue, holding.allocation)
    : null;
  const portfolioContribution = gainLoss !== null
    ? computePortfolioContribution(gainLoss, startingPortfolioValue)
    : null;

  return {
    holding: holding as HoldingState['holding'],
    startPrice,
    quantity,
    currentPrice,
    positionValue,
    gainLoss,
    returnPct,
    portfolioContribution,
  };
}

/** Compute full state for one portfolio. */
export function computePortfolioState(
  portfolio: Portfolio,
  startPrices: Record<string, number | null>,
  currentPrices: Prices,
  startingValue: number,
): Omit<PortfolioState, 'rank' | 'vsSpyPct'> {
  const holdingStates = portfolio.holdings.map((h) =>
    computeHoldingState(h, startPrices, currentPrices, startingValue),
  );

  const allPriced = holdingStates.every((h) => h.positionValue !== null);
  const totalValue = allPriced
    ? holdingStates.reduce((sum, h) => sum + (h.positionValue ?? 0), 0)
    : null;

  const gainLoss = totalValue !== null ? totalValue - startingValue : null;
  const returnPct = totalValue !== null ? computeReturnPct(totalValue, startingValue) : null;

  const priced = holdingStates.filter((h) => h.returnPct !== null);
  const bestHolding = priced.length > 0
    ? priced.reduce((best, h) => (h.returnPct! > best.returnPct! ? h : best))
    : null;
  const worstHolding = priced.length > 0
    ? priced.reduce((worst, h) => (h.returnPct! < worst.returnPct! ? h : worst))
    : null;

  return { portfolio, holdings: holdingStates, totalValue, gainLoss, returnPct, bestHolding, worstHolding };
}

/** Compute benchmark (SPY) state. */
export function computeBenchmarkState(
  config: ContestConfig,
  currentPrices: Prices,
): BenchmarkState {
  const startPrice = config.startPrices[config.benchmarkSymbol] ?? null;
  const currentPrice = currentPrices[config.benchmarkSymbol] ?? null;

  const quantity = startPrice !== null ? computeQuantity(config.startingValue, startPrice) : null;
  const totalValue = quantity !== null && currentPrice !== null
    ? computePositionValue(quantity, currentPrice)
    : null;
  const returnPct = totalValue !== null
    ? computeReturnPct(totalValue, config.startingValue)
    : null;

  return { startPrice, quantity, currentPrice, totalValue, returnPct };
}

/** Rank portfolios by returnPct (highest first). Null returns go last. */
export function rankPortfolios(
  states: Array<Omit<PortfolioState, 'rank' | 'vsSpyPct'>>,
  benchmarkReturnPct: number | null,
): PortfolioState[] {
  const sorted = [...states].sort((a, b) => {
    if (a.returnPct === null && b.returnPct === null) return 0;
    if (a.returnPct === null) return 1;
    if (b.returnPct === null) return -1;
    return b.returnPct - a.returnPct;
  });

  return sorted.map((s, i) => ({
    ...s,
    rank: i + 1,
    vsSpyPct:
      s.returnPct !== null && benchmarkReturnPct !== null
        ? s.returnPct - benchmarkReturnPct
        : null,
  }));
}

/** Detect which holdings appear in multiple portfolios. */
export function findSharedHoldings(portfolios: Portfolio[]): SharedHolding[] {
  const map = new Map<string, SharedHolding>();

  for (const portfolio of portfolios) {
    for (const holding of portfolio.holdings) {
      const key = holding.apiSymbol;
      if (!map.has(key)) {
        map.set(key, {
          apiSymbol: holding.apiSymbol,
          ticker: holding.ticker,
          name: holding.name,
          assetClass: holding.assetClass,
          portfolioIds: [],
          portfolioNames: [],
        });
      }
      const entry = map.get(key)!;
      entry.portfolioIds.push(portfolio.id);
      entry.portfolioNames.push(portfolio.name);
    }
  }

  return Array.from(map.values()).filter((s) => s.portfolioIds.length > 1);
}

/** Return true only when every startPrice in config is non-null and there is at least one. */
export function isContestConfigured(config: ContestConfig): boolean {
  const entries = Object.values(config.startPrices);
  return entries.length > 0 && entries.every((p) => p !== null);
}

/** Compute all portfolio states + ranked list from raw prices. */
export function computeAllPortfolioStates(
  config: ContestConfig,
  currentPrices: Prices,
): PortfolioState[] {
  const benchmark = computeBenchmarkState(config, currentPrices);
  const raw = PORTFOLIOS.map((p) =>
    computePortfolioState(p, config.startPrices, currentPrices, config.startingValue),
  );
  return rankPortfolios(raw, benchmark.returnPct);
}
