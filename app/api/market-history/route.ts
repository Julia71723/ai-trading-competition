import { NextResponse } from 'next/server';
import { createProvider } from '@/lib/provider';
import { ALL_SYMBOLS, PORTFOLIOS } from '@/lib/portfolios';
import { getContestConfig, getStartDateStr } from '@/lib/contest-config';
import { isContestConfigured } from '@/lib/calculations';
import { buildMasterTimeline, forwardFillPrices, barsToDateMap } from '@/lib/history';
import type { MarketHistoryResponse } from '@/lib/types';

// Cache history at the CDN layer for 6 hours.
export const revalidate = 21600;

export async function GET(): Promise<NextResponse> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    const body: MarketHistoryResponse = {
      dailyPrices: {},
      dates: [],
      timestamp: new Date().toISOString(),
      isFresh: false,
      error: 'TWELVE_DATA_API_KEY is not configured on this server.',
    };
    return NextResponse.json(body, { status: 503 });
  }

  const config = getContestConfig();

  // Don't fetch history until start prices are set
  if (!isContestConfigured(config)) {
    const body: MarketHistoryResponse = {
      dailyPrices: {},
      dates: [],
      timestamp: new Date().toISOString(),
      isFresh: true,
    };
    return NextResponse.json(body);
  }

  const startDateStr = getStartDateStr(config);
  const todayStr = new Date().toISOString().split('T')[0];

  // If the contest hasn't started yet, return empty series.
  if (todayStr < startDateStr) {
    const body: MarketHistoryResponse = {
      dailyPrices: {},
      dates: [],
      timestamp: new Date().toISOString(),
      isFresh: true,
    };
    return NextResponse.json(body);
  }

  try {
    const provider = await createProvider();

    // Build asset-class lookup; separate symbols for different fetch strategies
    const assetClasses: Record<string, 'stock' | 'crypto'> = {};
    for (const p of PORTFOLIOS) {
      for (const h of p.holdings) {
        assetClasses[h.apiSymbol] = h.assetClass;
      }
    }
    assetClasses[config.benchmarkSymbol] = 'stock';

    const cryptoSymbols = ALL_SYMBOLS.filter((s) => assetClasses[s] === 'crypto');
    const stockSymbols = ALL_SYMBOLS.filter((s) => assetClasses[s] !== 'crypto');

    // Stocks/ETFs: use official daily close; crypto: use 1h bars → 4 PM ET per day
    const [stockBarsMap, cryptoBarsMap] = await Promise.all([
      provider.getDailyBarsBatch(stockSymbols, startDateStr, todayStr),
      provider.getCryptoDailyCloseBatch(cryptoSymbols, startDateStr, todayStr),
    ]);
    const barsMap = { ...stockBarsMap, ...cryptoBarsMap };

    // Convert bars to date-keyed maps
    const rawPrices: Record<string, Record<string, number>> = {};
    for (const [sym, bars] of Object.entries(barsMap)) {
      rawPrices[sym] = barsToDateMap(bars);
    }

    const dates = buildMasterTimeline(startDateStr, todayStr);
    const filledPrices = forwardFillPrices(rawPrices, assetClasses, dates);

    const body: MarketHistoryResponse = {
      dailyPrices: filledPrices,
      dates,
      timestamp: new Date().toISOString(),
      isFresh: true,
    };

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error fetching history';
    console.error('[market-history]', message);

    const body: MarketHistoryResponse = {
      dailyPrices: {},
      dates: [],
      timestamp: new Date().toISOString(),
      isFresh: false,
      error: message,
    };
    return NextResponse.json(body, { status: 502 });
  }
}
