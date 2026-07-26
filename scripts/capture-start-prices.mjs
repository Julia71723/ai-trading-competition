#!/usr/bin/env node
/**
 * capture-start-prices.mjs
 *
 * Captures official starting prices for all contest symbols:
 *
 *   US stocks and SPY: official regular-session closing price on July 24, 2026.
 *   Crypto (BTC/USD, ETH/USD, SOL/USD): price at or nearest to 4:00 PM ET (20:00 UTC).
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

// ── Utilities ─────────────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function encodeSymbol(sym) {
  return encodeURIComponent(sym);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(id);
  }
}

/**
 * Build a guaranteed YYYY-MM-DD string from a Date in America/New_York.
 * Uses formatToParts so the result never depends on locale separator conventions.
 */
function toETDateStr(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

/**
 * For a given ET calendar date string (YYYY-MM-DD), return the UTC ms
 * that represent 4:00 PM ET, accounting for EDT (UTC-4) vs EST (UTC-5).
 * July is always EDT, so 4 PM ET = 20:00 UTC.
 */
function get4PMETUtcMs(etDateStr) {
  // Probe at 20:00 UTC — if that is 16:xx ET we are in EDT
  const at20utc = new Date(`${etDateStr}T20:00:00Z`);
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(at20utc),
    10,
  );
  // EDT: 20:00 UTC = 16:00 ET ✓   EST: 21:00 UTC = 16:00 ET
  return etHour === 16 ? at20utc.getTime() : new Date(`${etDateStr}T21:00:00Z`).getTime();
}

// ── Twelve Data helpers ───────────────────────────────────────────────────────

/**
 * Log a Twelve Data error body without revealing the API key.
 * The key is never included in any printed string.
 */
function logApiError(symbol, statusCode, body) {
  const code = body?.code ?? '—';
  const msg = body?.message ?? '(no message)';
  const status = body?.status ?? '—';
  console.error(
    `         ⛔  Twelve Data error for ${symbol}: ` +
    `HTTP ${statusCode} | status="${status}" code=${code} | ${msg}`,
  );
}

/**
 * Fetch a JSON response from Twelve Data, with unified error handling.
 * Returns { ok, status, body } — never throws on HTTP errors.
 * Throws on network failure.
 */
async function tdFetch(url) {
  const res = await fetchWithTimeout(url);
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// ── Stock fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch the official regular-session closing price for a US stock/ETF on dateStr.
 *
 * Uses interval=1day, start_date=dateStr, end_date=<next calendar day>.
 * end_date must be strictly after start_date; Twelve Data returns an empty
 * range when start_date === end_date.
 */
async function fetchStockDailyClose(symbol, dateStr, apiKey) {
  // end_date is the next calendar day so the range is unambiguous
  const endDate = nextDay(dateStr);

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeSymbol(symbol)}` +
    `&interval=1day` +
    `&start_date=${dateStr}` +
    `&end_date=${endDate}` +
    `&outputsize=2` +
    `&apikey=${apiKey}`;

  let result;
  try {
    result = await tdFetch(url);
  } catch (err) {
    console.error(`         ⛔  Network failure for ${symbol}: ${err.message}`);
    return null;
  }

  const { ok, status, body } = result;

  if (!ok || body?.status === 'error') {
    logApiError(symbol, status, body);
    return null;
  }

  const values = body?.values;
  if (!Array.isArray(values) || values.length === 0) {
    console.error(
      `         ⛔  No bars returned for ${symbol} ` +
      `(start_date=${dateStr}, end_date=${endDate}). ` +
      `The market may have been closed or the symbol is not on your plan.`,
    );
    return null;
  }

  // Twelve Data returns bars newest-first; find the one for dateStr
  const bar = values.find((v) => String(v.datetime).startsWith(dateStr));
  if (!bar) {
    const returned = values.map((v) => v.datetime).join(', ');
    console.error(
      `         ⛔  No bar for ${dateStr} in response for ${symbol}. ` +
      `Bars returned: [${returned}]`,
    );
    return null;
  }

  const price = parseFloat(bar.close);
  if (!isFinite(price) || price <= 0) {
    console.error(`         ⛔  Non-finite close price for ${symbol}: "${bar.close}"`);
    return null;
  }

  return {
    price,
    actualDatetime: `${dateStr} regular-session close (4:00 PM ET)`,
    source: '1day close',
  };
}

// ── Crypto fetch ──────────────────────────────────────────────────────────────

/**
 * Fetch the crypto price at or nearest to 4:00 PM ET on dateStr.
 * July 24, 2026 is in EDT, so the target is 20:00:00 UTC.
 *
 * Fetches a 20-minute window of 1-min bars centered on 20:00 UTC.
 * The start_date MUST include seconds ("YYYY-MM-DD HH:MM:SS"); Twelve Data
 * rejects "HH:MM" for intraday intervals.
 */
async function fetchCryptoAt4PMET(symbol, dateStr, apiKey) {
  const targetUTCMs = get4PMETUtcMs(dateStr);
  const targetUTC = new Date(targetUTCMs);

  // Window: 10 minutes before the target
  const windowStart = new Date(targetUTCMs - 10 * 60 * 1000);
  // MUST be YYYY-MM-DD HH:MM:SS — slice(0,19) drops milliseconds and the Z
  const windowStartStr = windowStart.toISOString().replace('T', ' ').slice(0, 19);

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeSymbol(symbol)}` +
    `&interval=1min` +
    `&start_date=${encodeURIComponent(windowStartStr)}` +
    `&outputsize=25` +
    `&apikey=${apiKey}`;

  let result;
  try {
    result = await tdFetch(url);
  } catch (err) {
    console.error(`         ⛔  Network failure for ${symbol}: ${err.message}`);
    return null;
  }

  const { ok, status, body } = result;

  if (!ok || body?.status === 'error') {
    logApiError(symbol, status, body);
    return null;
  }

  const values = body?.values;
  if (!Array.isArray(values) || values.length === 0) {
    console.error(
      `         ⛔  No bars returned for ${symbol} ` +
      `(window start: ${windowStartStr} UTC, target: ${targetUTC.toISOString()}). ` +
      `Minute-level history may not be available on your plan.`,
    );
    return null;
  }

  // Twelve Data crypto datetimes are in UTC
  let best = null;
  let bestDiff = Infinity;

  for (const bar of values) {
    // Append 'Z' to treat the datetime as UTC
    const barMs = new Date(bar.datetime.replace(' ', 'T') + 'Z').getTime();
    const diffMs = Math.abs(barMs - targetUTCMs);
    if (diffMs < bestDiff) {
      bestDiff = diffMs;
      best = { bar, diffMs };
    }
  }

  const bestDiffMin = bestDiff / 60000;

  if (!best || bestDiffMin > 5) {
    if (best) {
      console.error(
        `         ⛔  ${symbol}: closest bar is "${best.bar.datetime}" UTC ` +
        `(${bestDiffMin.toFixed(1)} min from target ${targetUTC.toISOString()}). ` +
        `Exceeds 5-minute tolerance — refusing to use.`,
      );
    }
    return null;
  }

  const price = parseFloat(best.bar.close);
  if (!isFinite(price) || price <= 0) {
    console.error(`         ⛔  Non-finite close price for ${symbol}: "${best.bar.close}"`);
    return null;
  }

  // Verify the bar falls on the correct ET calendar date
  const barETDate = toETDateStr(new Date(new Date(best.bar.datetime.replace(' ', 'T') + 'Z').getTime()));
  if (barETDate !== dateStr) {
    console.error(
      `         ⛔  ${symbol}: bar "${best.bar.datetime}" UTC is ET date "${barETDate}", ` +
      `not "${dateStr}". Wrong date — refusing to use.`,
    );
    return null;
  }

  return {
    price,
    actualDatetime:
      `${best.bar.datetime} UTC ` +
      `(target: ${targetUTC.toISOString()}, diff: ${bestDiffMin.toFixed(1)} min)`,
    source: '1min bar (nearest 4 PM ET)',
    diffMinutes: bestDiffMin,
  };
}

// ── Date utils ────────────────────────────────────────────────────────────────

/** Return the calendar day after dateStr (YYYY-MM-DD). */
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.error(
      '\n❌  TWELVE_DATA_API_KEY is not set.\n' +
      '   Export it before running:\n' +
      '     export TWELVE_DATA_API_KEY=your_key_here\n',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const { officialPurchaseTimestamp, startPrices } = config;

  const officialUTC = new Date(officialPurchaseTimestamp);
  const officialDateET = toETDateStr(officialUTC);  // "2026-07-24"

  // Verify the timezone conversion is correct before fetching anything
  const targetUTCMs = get4PMETUtcMs(officialDateET);
  const targetUTCStr = new Date(targetUTCMs).toISOString(); // should be "...T20:00:00.000Z"

  console.log(`\n📅  Official purchase timestamp : ${officialPurchaseTimestamp}`);
  console.log(`📅  Official date (ET)           : ${officialDateET}`);
  console.log(`🕓  4:00 PM ET in UTC             : ${targetUTCStr}`);
  console.log(`🔑  API key                       : ${apiKey.slice(0, 6)}...`);
  console.log(`📄  Config                        : ${CONFIG_PATH}\n`);
  console.log('📋  Methodology:');
  console.log('    • Stocks / SPY  → 1day bar, official regular-session close');
  console.log('    • Crypto        → 1min bars, nearest bar to 4:00 PM ET (20:00 UTC)\n');

  if (DRY_RUN) console.log('ℹ️   Dry-run — nothing will be written.\n');
  if (FORCE)   console.log('⚠️   Force — existing prices will be overwritten.\n');

  const symbols = Object.keys(startPrices);
  const toFetch = FORCE ? symbols : symbols.filter((s) => startPrices[s] === null);

  if (toFetch.length === 0) {
    console.log('✅  All starting prices are already set. Use --force to re-fetch.\n');
    return;
  }

  const stocksToFetch = toFetch.filter((s) => !CRYPTO_SYMBOLS.has(s));
  const cryptoToFetch = toFetch.filter((s) => CRYPTO_SYMBOLS.has(s));

  const results = {};
  const metaResults = {};
  const failed = [];

  // ── 1. Stocks ────────────────────────────────────────────────────────────────
  if (stocksToFetch.length > 0) {
    console.log(`📈  Stocks / SPY (${stocksToFetch.length} symbol${stocksToFetch.length > 1 ? 's' : ''}):\n`);

    for (const symbol of stocksToFetch) {
      process.stdout.write(`   ${symbol.padEnd(12)} `);
      const r = await fetchStockDailyClose(symbol, officialDateET, apiKey);

      if (r) {
        process.stdout.write(`✓  $${r.price}  (${r.actualDatetime})\n`);
        results[symbol] = r.price;
        metaResults[symbol] = { actualDatetime: r.actualDatetime, source: r.source };
      } else {
        process.stdout.write(`✗  failed — see error above\n`);
        failed.push(symbol);
      }

      await sleep(1200); // respect 1 req/sec free-tier limit
    }
    console.log('');
  }

  // ── 2. Crypto ────────────────────────────────────────────────────────────────
  if (cryptoToFetch.length > 0) {
    console.log(`₿   Crypto (${cryptoToFetch.length} symbol${cryptoToFetch.length > 1 ? 's' : ''}) — nearest 1-min bar to ${targetUTCStr}:\n`);

    for (const symbol of cryptoToFetch) {
      process.stdout.write(`   ${symbol.padEnd(12)} `);
      const r = await fetchCryptoAt4PMET(symbol, officialDateET, apiKey);

      if (r) {
        process.stdout.write(`✓  $${r.price}  (diff: ${r.diffMinutes.toFixed(1)} min)\n`);
        console.log(`               Bar: ${r.actualDatetime}`);
        results[symbol] = r.price;
        metaResults[symbol] = { actualDatetime: r.actualDatetime, source: r.source };
      } else {
        process.stdout.write(`✗  failed — see error above\n`);
        failed.push(symbol);
      }

      await sleep(1200);
    }
    console.log('');
  }

  // ── 3. Write ─────────────────────────────────────────────────────────────────
  const capturedCount = Object.keys(results).length;

  if (capturedCount > 0 && !DRY_RUN) {
    for (const [sym, price] of Object.entries(results)) {
      config.startPrices[sym] = price;
    }
    if (!config.startPriceMeta) config.startPriceMeta = {};
    for (const [sym, meta] of Object.entries(metaResults)) {
      config.startPriceMeta[sym] = meta;
    }
    saveConfig(config);
    console.log(`✅  Wrote ${capturedCount} price(s) to ${CONFIG_PATH}`);
  }

  // ── 4. Report failures ───────────────────────────────────────────────────────
  if (failed.length > 0) {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log(`⚠️   ${failed.length} symbol(s) could not be captured:`);
    console.log('');
    for (const sym of failed) {
      if (CRYPTO_SYMBOLS.has(sym)) {
        console.log(`    "${sym}": <price at 4:00 PM ET (20:00 UTC) on ${officialDateET}>`);
      } else {
        console.log(`    "${sym}": <official regular-session close on ${officialDateET}>`);
      }
    }
    console.log('');
    console.log('    Check the ⛔ errors above for the specific Twelve Data error code.');
    console.log('    Common causes:');
    console.log('      • Plan does not include historical time_series (upgrade or use /price endpoint)');
    console.log('      • Symbol not recognised on your plan (check spelling)');
    console.log('      • Daily API credit limit reached');
    console.log('──────────────────────────────────────────────────────────────\n');
    process.exit(failed.length === symbols.length ? 1 : 0);
  }

  console.log('\n🎉  All prices captured.\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
