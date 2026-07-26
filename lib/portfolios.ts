import type { Portfolio } from './types';

export const PORTFOLIOS: Portfolio[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    color: '#22c55e',
    holdings: [
      {
        name: 'IREN Limited',
        ticker: 'IREN',
        apiSymbol: 'IREN',
        assetClass: 'stock',
        allocation: 3000,
        weight: 0.30,
      },
      {
        name: 'Solana',
        ticker: 'SOL',
        apiSymbol: 'SOL/USD',
        assetClass: 'crypto',
        allocation: 2500,
        weight: 0.25,
      },
      {
        name: 'AST SpaceMobile',
        ticker: 'ASTS',
        apiSymbol: 'ASTS',
        assetClass: 'stock',
        allocation: 2000,
        weight: 0.20,
      },
      {
        name: 'Ethereum',
        ticker: 'ETH',
        apiSymbol: 'ETH/USD',
        assetClass: 'crypto',
        allocation: 1500,
        weight: 0.15,
      },
      {
        name: 'Rocket Lab',
        ticker: 'RKLB',
        apiSymbol: 'RKLB',
        assetClass: 'stock',
        allocation: 1000,
        weight: 0.10,
      },
    ],
  },
  {
    id: 'claude',
    name: 'Claude',
    color: '#f97316',
    holdings: [
      {
        name: 'NVIDIA',
        ticker: 'NVDA',
        apiSymbol: 'NVDA',
        assetClass: 'stock',
        allocation: 2500,
        weight: 0.25,
      },
      {
        name: 'Solana',
        ticker: 'SOL',
        apiSymbol: 'SOL/USD',
        assetClass: 'crypto',
        allocation: 2000,
        weight: 0.20,
      },
      {
        name: 'Ethereum',
        ticker: 'ETH',
        apiSymbol: 'ETH/USD',
        assetClass: 'crypto',
        allocation: 2000,
        weight: 0.20,
      },
      {
        name: 'Bitcoin',
        ticker: 'BTC',
        apiSymbol: 'BTC/USD',
        assetClass: 'crypto',
        allocation: 2000,
        weight: 0.20,
      },
      {
        name: 'Micron',
        ticker: 'MU',
        apiSymbol: 'MU',
        assetClass: 'stock',
        allocation: 1500,
        weight: 0.15,
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    color: '#3b82f6',
    holdings: [
      {
        name: 'NVIDIA',
        ticker: 'NVDA',
        apiSymbol: 'NVDA',
        assetClass: 'stock',
        allocation: 2500,
        weight: 0.25,
      },
      {
        name: 'Bitcoin',
        ticker: 'BTC',
        apiSymbol: 'BTC/USD',
        assetClass: 'crypto',
        allocation: 2500,
        weight: 0.25,
      },
      {
        name: 'Solana',
        ticker: 'SOL',
        apiSymbol: 'SOL/USD',
        assetClass: 'crypto',
        allocation: 2000,
        weight: 0.20,
      },
      {
        name: 'Palantir',
        ticker: 'PLTR',
        apiSymbol: 'PLTR',
        assetClass: 'stock',
        allocation: 1500,
        weight: 0.15,
      },
      {
        name: 'Tesla',
        ticker: 'TSLA',
        apiSymbol: 'TSLA',
        assetClass: 'stock',
        allocation: 1500,
        weight: 0.15,
      },
    ],
  },
];

export const BENCHMARK = {
  id: 'spy',
  name: 'S&P 500',
  apiSymbol: 'SPY',
  note: 'tracked using SPY',
  color: '#a855f7',
  startingValue: 10000,
};

/** All unique API symbols across all portfolios + benchmark. */
export const ALL_SYMBOLS: string[] = Array.from(
  new Set([
    ...PORTFOLIOS.flatMap((p) => p.holdings.map((h) => h.apiSymbol)),
    BENCHMARK.apiSymbol,
  ]),
);
