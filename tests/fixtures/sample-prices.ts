/**
 * Sample fixture data for unit tests only.
 * These are not real market prices and must never appear in production UI.
 */

export const SAMPLE_START_PRICES: Record<string, number> = {
  'IREN': 10.00,
  'SOL/USD': 200.00,
  'ASTS': 20.00,
  'ETH/USD': 3000.00,
  'RKLB': 15.00,
  'NVDA': 150.00,
  'BTC/USD': 70000.00,
  'MU': 100.00,
  'PLTR': 50.00,
  'TSLA': 300.00,
  'SPY': 500.00,
};

/** Prices unchanged from start — every portfolio returns exactly 0%. */
export const SAMPLE_PRICES_FLAT = { ...SAMPLE_START_PRICES };

/** IREN doubled; everything else unchanged. */
export const SAMPLE_PRICES_IREN_DOUBLE: Record<string, number> = {
  ...SAMPLE_START_PRICES,
  'IREN': 20.00,
};

/** Everything up 10%. */
export const SAMPLE_PRICES_ALL_UP_10: Record<string, number> = Object.fromEntries(
  Object.entries(SAMPLE_START_PRICES).map(([k, v]) => [k, v * 1.1]),
);

/** SPY up 5%, AIs flat. */
export const SAMPLE_PRICES_SPY_UP: Record<string, number> = {
  ...SAMPLE_START_PRICES,
  'SPY': 525.00,
};
