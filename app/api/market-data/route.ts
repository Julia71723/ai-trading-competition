import { NextResponse } from 'next/server';
import { createProvider } from '@/lib/provider';
import { ALL_SYMBOLS } from '@/lib/portfolios';
import type { MarketDataResponse } from '@/lib/types';

// Cache responses at the CDN layer for 30 minutes.
export const revalidate = 1800;

export async function GET(): Promise<NextResponse> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    const body: MarketDataResponse = {
      prices: {},
      timestamp: new Date().toISOString(),
      isFresh: false,
      error: 'TWELVE_DATA_API_KEY is not configured on this server.',
    };
    return NextResponse.json(body, { status: 503 });
  }

  try {
    const provider = await createProvider();
    const prices = await provider.getLatestPrices(ALL_SYMBOLS);

    const body: MarketDataResponse = {
      prices,
      timestamp: new Date().toISOString(),
      isFresh: true,
    };

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=900',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error fetching market data';
    console.error('[market-data]', message);

    const body: MarketDataResponse = {
      prices: {},
      timestamp: new Date().toISOString(),
      isFresh: false,
      error: message,
    };
    return NextResponse.json(body, { status: 502 });
  }
}
