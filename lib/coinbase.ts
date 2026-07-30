/**
 * Coinbase Exchange public REST API — no API key required.
 * Used exclusively for BTC/USD, ETH/USD, SOL/USD daily closes.
 * Completely separate from Twelve Data; shares no rate limit.
 */

const BASE_URL = 'https://api.exchange.coinbase.com';

const SYMBOL_TO_PRODUCT: Record<string, string> = {
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
  'SOL/USD': 'SOL-USD',
};

/**
 * Returns Unix seconds for 4:00:00 PM ET on the given YYYY-MM-DD date.
 * Accounts for EDT (UTC-4) vs EST (UTC-5).
 */
function get4pmETasUTCSec(date: string): number {
  const at20utc = new Date(`${date}T20:00:00Z`);
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(at20utc),
    10,
  );
  // EDT: 20:00 UTC = 16:00 ET → use 20:00 UTC
  // EST: 20:00 UTC = 15:00 ET → need 21:00 UTC
  return etHour === 16
    ? Math.floor(at20utc.getTime() / 1000)
    : Math.floor(new Date(`${date}T21:00:00Z`).getTime() / 1000);
}

async function fetchProductClose(
  sym: string,          // internal e.g. 'BTC/USD'
  productId: string,    // Coinbase e.g. 'BTC-USD'
  targetUTCSec: number, // Unix seconds for 4 PM ET
): Promise<number> {
  // 1-minute candles in a ±5-minute window around the target
  const startISO = new Date((targetUTCSec - 300) * 1000).toISOString();
  const endISO   = new Date((targetUTCSec + 300) * 1000).toISOString();

  const url =
    `${BASE_URL}/products/${encodeURIComponent(productId)}/candles` +
    `?granularity=60&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'ai-trading-competition/1.0' },
    cache: 'no-store',
  });

  console.log(`[coinbase] ${sym}: HTTP ${res.status} — ${url.replace(BASE_URL, 'api.exchange.coinbase.com')}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Coinbase HTTP ${res.status} for ${productId}: ${body.slice(0, 300)}`);
  }

  // Response: [[time, low, high, open, close, volume], ...] newest-first
  // `time` is the Unix-second START of the 1-minute candle period.
  const candles = (await res.json()) as Array<[number, number, number, number, number, number]>;

  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(
      `Coinbase returned no candles for ${productId} near ${new Date(targetUTCSec * 1000).toISOString()}`,
    );
  }

  // Find the candle whose start is exactly at 4 PM ET; fall back to the closest preceding one.
  const candidates = candles
    .filter(([t]) => t <= targetUTCSec)
    .sort((a, b) => b[0] - a[0]); // most-recent first

  if (candidates.length === 0) {
    const avail = candles.map(([t]) => new Date(t * 1000).toISOString()).join(', ');
    throw new Error(
      `No Coinbase candle at or before 4 PM ET (${new Date(targetUTCSec * 1000).toISOString()}) ` +
      `for ${productId}. Available candles: ${avail}`,
    );
  }

  const [candleTime, , , , close] = candidates[0];
  const lagSec = targetUTCSec - candleTime;

  if (lagSec > 300) {
    throw new Error(
      `Coinbase candle for ${productId} is ${lagSec}s before 4 PM ET ` +
      `(${new Date(candleTime * 1000).toISOString()}) — max 300s allowed`,
    );
  }

  console.log(
    `[coinbase] ${sym}: close=${close} @ ${new Date(candleTime * 1000).toISOString()} ` +
    `(${lagSec}s before 4 PM ET target)`,
  );
  return close;
}

/**
 * Fetch the 4 PM ET close price for each symbol from Coinbase Exchange.
 * All symbols are fetched in parallel. Throws on any failure.
 *
 * @param symbols  Internal symbols: 'BTC/USD', 'ETH/USD', 'SOL/USD'
 * @param date     Market date in ET: 'YYYY-MM-DD'
 */
export async function fetchCoinbaseDailyClose(
  symbols: string[],
  date: string,
): Promise<Record<string, number>> {
  const targetUTCSec = get4pmETasUTCSec(date);
  console.log(
    `[coinbase] fetching ${symbols.join(', ')} for ${date}` +
    ` — 4 PM ET = ${new Date(targetUTCSec * 1000).toISOString()}`,
  );

  const entries = await Promise.all(
    symbols.map(async (sym) => {
      const productId = SYMBOL_TO_PRODUCT[sym];
      if (!productId) throw new Error(`No Coinbase product mapping for: ${sym}`);
      const price = await fetchProductClose(sym, productId, targetUTCSec);
      return [sym, price] as const;
    }),
  );

  return Object.fromEntries(entries);
}
