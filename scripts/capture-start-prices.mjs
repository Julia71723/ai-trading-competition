#!/usr/bin/env node
/**
 * capture-start-prices.mjs
 *
 * Attempts to fetch the official starting prices for all symbols at the
 * officialPurchaseTimestamp defined in contest.config.json.
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
const TIMEOUT_MS = 12_000;

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
 * Attempt to fetch the 1-minute bar at the given timestamp for a symbol.
 * Returns { price, actualDatetime } or null if unavailable.
 */
async function fetchMinutePrice(symbol, isoTimestamp, apiKey) {
  const dt = new Date(isoTimestamp);
  // Format as "YYYY-MM-DD HH:MM:00" in ET (UTC-4 during EDT)
  const localDateStr = dt.toISOString().replace('T', ' ').slice(0, 16);

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeSymbol(symbol)}` +
    `&interval=1min` +
    `&start_date=${encodeURIComponent(localDateStr)}` +
    `&outputsize=1` +
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

  const bar = data.values[0];
  const price = parseFloat(bar.close);
  if (!isFinite(price) || price <= 0) return null;

  return { price, actualDatetime: bar.datetime };
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

  console.log(`\n📅  Official purchase timestamp: ${officialPurchaseTimestamp}`);
  console.log(`🔑  API key: ${apiKey.slice(0, 6)}...`);
  console.log(`📄  Config:  ${CONFIG_PATH}\n`);

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

  console.log(`🔍  Fetching minute-bar prices for ${toFetch.length} symbol(s):\n`);

  const results = {};
  const failed = [];
  const manualEntryNeeded = [];

  for (const symbol of toFetch) {
    process.stdout.write(`   ${symbol.padEnd(12)} ...`);
    const result = await fetchMinutePrice(symbol, officialPurchaseTimestamp, apiKey);

    if (result) {
      const { price, actualDatetime } = result;
      process.stdout.write(` ✓  $${price}  (bar: ${actualDatetime})\n`);

      // Verify the returned bar is close to the requested timestamp
      const requestedMs = new Date(officialPurchaseTimestamp).getTime();
      const actualMs = new Date(actualDatetime.replace(' ', 'T') + ':00Z').getTime();
      const diffMin = Math.abs(requestedMs - actualMs) / 60000;

      if (diffMin > 5) {
        console.warn(
          `      ⚠️   Bar datetime differs by ${diffMin.toFixed(1)} min from request.` +
          ` Refusing to use — timestamp mismatch.`,
        );
        manualEntryNeeded.push(symbol);
      } else {
        results[symbol] = price;
      }
    } else {
      process.stdout.write(` ✗  unavailable\n`);
      failed.push(symbol);
    }

    // Respect Twelve Data rate limit (1 req/sec on free tier)
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log('');

  if (Object.keys(results).length > 0 && !DRY_RUN) {
    for (const [sym, price] of Object.entries(results)) {
      config.startPrices[sym] = price;
    }
    saveConfig(config);
    console.log(`✅  Wrote ${Object.keys(results).length} price(s) to contest.config.json`);
  }

  const needManual = [...failed, ...manualEntryNeeded];
  if (needManual.length > 0) {
    console.log('\n──────────────────────────────────────────────────────');
    console.log('⚠️   The following prices could not be captured automatically');
    console.log('    and must be entered manually in contest.config.json:\n');
    for (const sym of needManual) {
      console.log(`    "${sym}": <price at ${officialPurchaseTimestamp}>,`);
    }
    console.log('\n    Minute-level historical prices may not be available on');
    console.log('    your Twelve Data plan, or the market was closed at that time.');
    console.log('    Check https://twelvedata.com/pricing for plan details.');
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(needManual.length === symbols.length ? 1 : 0);
  }

  console.log('\n🎉  Done. All prices captured.\n');
}

main().catch((err) => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
