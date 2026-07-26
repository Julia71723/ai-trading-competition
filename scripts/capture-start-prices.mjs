#!/usr/bin/env node
/**
 * capture-start-prices.mjs
 *
 * Captures official starting prices for all contest symbols using the methodology
 * defined in contest.config.json's officialPurchaseTimestamp (2026-07-24T16:00:00-04:00):
 *
 *   US stocks and SPY: official regular-session closing price on July 24, 2026.
 *   Crypto (BTC/USD, ETH/USD, SOL/USD): price at or nearest to 4:00 PM ET on July 24, 2026.
 *
 * Usage:
 *   node scripts/capture-start-prices.mjs            # skip already-set prices
 *   node scripts/capture-start-prices.mjs --force    # overwrite all prices
 *   node scripts/capture-start-prices.mjs --dry-run  # print without writing
 *
 * Requires: TWELVE_DATA_API_KEY environment variable.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '..', 'contest.config.json');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const TIMEOUT_MS = 15_000;

const CRYPTO_SYMBOLS = new Set(['BTC/USD', 'ETH/USD', 'SOL/USD']);

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function encodeSymbol(sym) {
  return sym.replace(/\//g, '%2F');
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/**
 * For a given ET calendar date, return the UTC milliseconds that represent 4:00 PM ET.
 * Accounts for EDT (UTC-4, summer) vs EST (UTC-5, winter).
 */
function get4PMETUtcMs(etDateStr) {
  const at20utc = new Date(`${etDateStr}T20:00:00Z`);
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(at20utc),
    10,
  );
  return etHour === 16 ? at20utc.getTime() : new Date(`${etDateStr}T21:00:00Z`).getTime();
}

/**
 * Fetch the official regular-session daily closing price for a US stock/ETF.
 * Uses the 1day bar on the official date from Twelve Data.
 * Returns { price, actualDatetime } or null if unavailable or wrong date.
 */
async function fetchStockDailyClose(symbol, dateStr, apiKey) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeSymbol(symbol)}&interval=1day` +
    `&start_date=${dateStr}&end_date=${dateStr}` +
    `&outputsize=1&apikey=${apiKey}`;

  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  if (data.status === 'error' || !data.values?.length) return null;

  const bar = data.values[0];
  // The datetime for a daily bar is just the date string "YYYY-MM-DD"
  if (!bar.datetime.startsWith(dateStr)) {
    console.warn(
      `      ⚠️  ${symbol}: returned date "${bar.datetime}" does not match requested "${dateStr}".` +
      ` This may mean the market was closed. Refusing to use.`,
    );
    return null;
  }

  const price = parseFloat(bar.close);
  if (!isFinite(price) || price <= 0) return null;

  return {
    price,
    actualDatetime: `${dateStr} regular-session close (4:00 PM ET)`,
    source: '1day close',
  };
}

/**
 * Fetch the crypto price at or nearest to 4:00 PM ET on the official date.
 * Uses 1-minute bars around the target UTC timestamp.
 * Returns { price, actualDatetime, diffMinutes } or null if unavailable or out of tolerance.
 */
async function fetchCryptoAt4PMET(symbol, dateStr, apiKey) {
  // 4 PM ET on official date = 20:00 UTC (EDT in July)
  const targetUTCMs = get4PMETUtcMs(dateStr);
  const targetUTC = new Date(targetUTCMs);

  // Fetch 20 minutes of 1-min bars centered on the target
  const windowStart = new Date(targetUTCMs - 10 * 60 * 1000);
  const windowStartStr = windowStart.toISOString().replace('T', ' ').slice(0, 16);

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeSymbol(symbol)}&interval=1min` +
    `&start_date=${encodeURIComponent(windowStartStr)}&outputsize=25` +
    `&apikey=${apiKey}`;

  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  if (data.status === 'error' || !data.values?.length) return null;

  // Find bar closest to the target UTC time
  let best = null;
  let bestDiff = Infinity;

  for (const bar of data.values) {
    // Crypto datetimes from Twelve Data are in UTC
    const barUTCMs = new Date(bar.datetime.replace(' ', 'T') + 'Z').getTime();
    const diff = Math.abs(barUTCMs - targetUTCMs) / 60000; // minutes
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { bar, diffMinutes: diff };
    }
  }

  if (!best || best.diffMinutes > 5) {
    if (best) {
      console.warn(
        `      ⚠️  ${symbol}: closest bar at ${best.bar.datetime} UTC is ` +
        `${best.diffMinutes.toFixed(1)} min from target — exceeds 5-min tolerance. Refusing to use.`,
      );
    }
    return null;
  }

  const price = parseFloat(best.bar.close);
  if (!isFinite(price) || price <= 0) return null;

  // Verify the bar date is on the right calendar day (ET)
  const barUTCMs = new Date(best.bar.datetime.replace(' ', 'T') + 'Z').getTime();
  const barETDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(barUTCMs));

  if (barETDate !== dateStr) {
    console.warn(
      `      ⚠️  ${symbol}: bar at ${best.bar.datetime} UTC is calendar date ` +
      `"${barETDate}" ET, not "${dateStr}". Refusing to use — wrong date.`,
    );
    return null;
  }

  return {
    price,
    actualDatetime: `${best.bar.datetime} UTC (nearest 1-min bar to ${targetUTC.toISOString()}, ${best.diffMinutes.toFixed(1)} min diff)`,
    source: '1min bar (nearest 4 PM ET)',
    diffMinutes: best.diffMinutes,
  };
}

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.error(
      '\n❌  TWELVE_DATA_API_KEY is not set.\n' +
      '   Export it before running this script:\n' +
      '     export TWELVE_DATA_API_KEY=your_key_here\n',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const { officialPurchaseTimestamp, startPrices } = config;

  // Derive the official date string (YYYY-MM-DD) in ET
  const officialUTC = new Date(officialPurchaseTimestamp);
  const officialDateET = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(officialUTC);

  console.log(`\n📅  Official purchase timestamp: ${officialPurchaseTimestamp}`);
  console.log(`📅  Official date (ET):          ${officialDateET}`);
  console.log(`🔑  API key: ${apiKey.slice(0, 6)}...`);
  console.log(`📄  Config:  ${CONFIG_PATH}\n`);
  console.log('📋  Methodology:');
  console.log('    • US stocks & SPY → official regular-session daily close (4:00 PM ET)');
  console.log('    • Crypto (BTC/USD, ETH/USD, SOL/USD) → price at or nearest 4:00 PM ET (1-min bar)\n');

  if (DRY_RUN) console.log('ℹ️   Dry-run mode — nothing will be written.\n');
  if (FORCE) console.log('⚠️   Force mode — will overwrite existing prices.\n');

  const symbols = Object.keys(startPrices);
  const toFetch = FORCE
    ? symbols
    : symbols.filter((s) => startPrices[s] === null);

  if (toFetch.length === 0) {
    console.log('✅  All starting prices are already set. Use --force to re-fetch.\n');
    return;
  }

  const stocksToFetch = toFetch.filter((s) => !CRYPTO_SYMBOLS.has(s));
  const cryptoToFetch = toFetch.filter((s) => CRYPTO_SYMBOLS.has(s));

  const results = {};
  const metaResults = {};
  const failed = [];

  // ── Stocks: official daily close ──────────────────────────────────────────
  if (stocksToFetch.length > 0) {
    console.log(`📈  Fetching daily closes for ${stocksToFetch.length} stock/ETF symbol(s):\n`);

    for (const symbol of stocksToFetch) {
      process.stdout.write(`   ${symbol.padEnd(12)} ...`);
      const result = await fetchStockDailyClose(symbol, officialDateET, apiKey);

      if (result) {
        process.stdout.write(` ✓  $${result.price}  (${result.actualDatetime})\n`);
        results[symbol] = result.price;
        metaResults[symbol] = { actualDatetime: result.actualDatetime, source: result.source };
      } else {
        process.stdout.write(` ✗  unavailable\n`);
        failed.push(symbol);
      }

      // Rate limit: 1 req/sec on free tier
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log('');
  }

  // ── Crypto: 1-minute bar nearest 4 PM ET ─────────────────────────────────
  if (cryptoToFetch.length > 0) {
    const targetUTC = new Date(get4PMETUtcMs(officialDateET));
    console.log(
      `₿   Fetching crypto prices at or nearest to 4:00 PM ET ` +
      `(${targetUTC.toISOString()}) for ${cryptoToFetch.length} symbol(s):\n`,
    );

    for (const symbol of cryptoToFetch) {
      process.stdout.write(`   ${symbol.padEnd(12)} ...`);
      const result = await fetchCryptoAt4PMET(symbol, officialDateET, apiKey);

      if (result) {
        process.stdout.write(` ✓  $${result.price}  (${result.diffMinutes.toFixed(1)} min from target)\n`);
        console.log(`               Actual bar: ${result.actualDatetime}`);
        results[symbol] = result.price;
        metaResults[symbol] = { actualDatetime: result.actualDatetime, source: result.source };
      } else {
        process.stdout.write(` ✗  unavailable\n`);
        failed.push(symbol);
      }

      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log('');
  }

  // ── Write results ─────────────────────────────────────────────────────────
  if (Object.keys(results).length > 0 && !DRY_RUN) {
    for (const [sym, price] of Object.entries(results)) {
      config.startPrices[sym] = price;
    }
    if (!config.startPriceMeta) config.startPriceMeta = {};
    for (const [sym, meta] of Object.entries(metaResults)) {
      config.startPriceMeta[sym] = meta;
    }
    saveConfig(config);
    console.log(`✅  Wrote ${Object.keys(results).length} price(s) to contest.config.json`);
  }

  if (failed.length > 0) {
    console.log('\n──────────────────────────────────────────────────────');
    console.log('⚠️   The following prices could not be captured automatically');
    console.log('    and must be entered manually in contest.config.json:\n');
    for (const sym of failed) {
      const isCrypto = CRYPTO_SYMBOLS.has(sym);
      if (isCrypto) {
        console.log(`    "${sym}": <price at 4:00 PM ET on ${officialDateET}>,`);
      } else {
        console.log(`    "${sym}": <official regular-session close on ${officialDateET}>,`);
      }
    }
    console.log('\n    Possible reasons:');
    console.log('    • Market was closed on that date (check if it was a trading day)');
    console.log('    • Minute-level historical data unavailable on your Twelve Data plan');
    console.log('    • Rate limit reached — try again or check https://twelvedata.com/pricing');
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed.length === symbols.length ? 1 : 0);
  }

  console.log('\n🎉  Done. All prices captured.\n');
}

main().catch((err) => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
