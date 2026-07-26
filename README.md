# AI Portfolio Showdown

Live leaderboard tracking a paper-trading contest between ChatGPT, Claude, and Gemini.
Each AI was given $10,000 and five picks, locked until December 31, 2026.
Performance is compared against the S&P 500 (tracked via SPY).

**→ [Live site](https://ai-trading-competition.vercel.app)** — deploy via Vercel (see below)

---

## What's in this repo

```
app/
  api/market-data/route.ts    — server-side endpoint: latest prices (cached 30 min)
  api/market-history/route.ts — server-side endpoint: daily history (cached 6 hr)
  globals.css                 — all styles (dark theme, responsive)
  layout.tsx                  — HTML shell, metadata, OpenGraph
  page.tsx                    — server entry point; reads contest config
components/
  Dashboard.tsx               — client orchestrator: fetches data, runs calculations
  Hero.tsx                    — title, countdown, last-updated header
  Leaderboard.tsx             — ranked cards with return vs SPY
  PerformanceChart.tsx        — Chart.js cumulative-return line chart
  PortfolioPanel.tsx          — per-AI holdings table + allocation bar
  SharedPicks.tsx             — overlap/exclusive holding breakdown
  Methodology.tsx             — collapsible rules + prompt text
  Disclaimer.tsx              — paper-trading notice
lib/
  types.ts                    — shared TypeScript interfaces
  portfolios.ts               — AUTHORITATIVE portfolio definitions (do not edit)
  calculations.ts             — pure math functions (quantities, returns, ranking)
  history.ts                  — timeline building, forward-fill, series computation
  provider.ts                 — adapter interface; swap data providers here
  twelve-data.ts              — Twelve Data API implementation
  contest-config.ts           — reads + validates contest.config.json
tests/
  calculations.test.ts        — 41 unit tests
  fixtures/sample-prices.ts   — test-only fixture prices (never shown in prod UI)
scripts/
  capture-start-prices.mjs    — fetches official start prices from Twelve Data
  update.py                   — legacy Python price updater (superseded by API routes)
contest.config.json           — EDITABLE: timestamps, startingValue, startPrices
```

---

## Requirements

- Node.js 22 or higher
- A [Twelve Data](https://twelvedata.com) API key

---

## Local development

```bash
# 1. Clone and install
git clone https://github.com/Julia71723/ai-trading-competition.git
cd ai-trading-competition
npm install

# 2. Add your API key
cp .env.local.example .env.local
# Edit .env.local and set TWELVE_DATA_API_KEY=your_key_here

# 3. Start the dev server
npm run dev
# → http://localhost:3000
```

---

## Entering official starting prices

**Before the prices are set**, the site displays "Waiting for official purchase prices"
and shows the portfolio allocations without any returns.

### Pricing methodology

| Symbol type | Source |
|-------------|--------|
| US stocks (IREN, ASTS, RKLB, NVDA, MU, PLTR, TSLA) | Official regular-session close, July 24, 2026 (4:00 PM ET) |
| SPY | Official regular-session close, July 24, 2026 (4:00 PM ET) |
| Crypto (BTC/USD, ETH/USD, SOL/USD) | Price at or nearest to 4:00 PM ET on July 24, 2026 (1-min bar) |

After-hours prices are **not** used. Midnight UTC daily closes are **not** substituted for crypto.

### Option A — run the capture script

```bash
export TWELVE_DATA_API_KEY=your_key_here
node scripts/capture-start-prices.mjs
```

The script automatically applies the correct methodology per symbol type:
- Stocks/SPY: fetches the `1day` bar for July 24, 2026
- Crypto: fetches 1-minute bars around 4:00 PM ET (20:00 UTC) and picks the nearest

Prices already set in `contest.config.json` are skipped unless you pass `--force`.
If any symbol cannot be retrieved accurately, it is left null with a clear report.

```bash
node scripts/capture-start-prices.mjs --dry-run   # print prices without writing
node scripts/capture-start-prices.mjs --force      # overwrite existing prices
```

### Option B — manual entry

Open `contest.config.json` and fill in each null value:
- US stocks/SPY: the official regular-session closing price on Friday, July 24, 2026
- Crypto: the price at or nearest to 4:00 PM ET (20:00 UTC) on July 24, 2026

```json
{
  "startPrices": {
    "IREN":    12.34,
    "SOL/USD": 178.50,
    "ASTS":    18.75,
    "ETH/USD": 3150.00,
    "RKLB":    19.20,
    "NVDA":    145.30,
    "BTC/USD": 68200.00,
    "MU":      110.50,
    "PLTR":    85.60,
    "TSLA":    285.00,
    "SPY":     556.20
  }
}
```

Commit and push — the site will immediately start computing returns.

---

## Configuring the official purchase timestamp

Edit `contest.config.json`:

```json
{
  "officialPurchaseTimestamp": "2026-07-24T16:00:00-04:00",
  "endTimestamp": "2026-12-31T16:00:00-05:00"
}
```

The timestamp is used for:
- The countdown display
- The `capture-start-prices.mjs` script (determines the official date and target time)
- The historical series start date

**Do not change the timestamp after starting prices have been entered.** The prices
must match the timestamp exactly.

---

## How the calculations work

All math is in `lib/calculations.ts` (pure functions, fully unit-tested).

### Quantities

```
quantity = allocation / officialStartPrice
```

Quantities are fixed forever at purchase time and computed at full floating-point precision.
Numbers are only rounded for display.

### Position value

```
positionValue = quantity × currentPrice
```

### Portfolio return

```
portfolioReturn% = (sum(positionValues) / 10000 − 1) × 100
```

### Benchmark (SPY)

```
spyQuantity    = 10000 / SPY_startPrice
benchmarkValue = spyQuantity × SPY_currentPrice
benchmarkReturn% = (benchmarkValue / 10000 − 1) × 100
```

### AI vs S&P 500

```
outperformance = aiReturn% − benchmarkReturn%
```

### Historical series

- Daily closing prices are fetched from Twelve Data.
- For stock/ETF symbols (including SPY): weekend and holiday gaps are forward-filled
  with the last available closing price. Missing prices are never treated as zero.
- For crypto (BTC/USD, ETH/USD, SOL/USD): no forward-filling; missing dates are left null.
- The first data point (contest start date) is pinned to exactly **0.00%** for all series.
- The latest live quote is appended as the final chart point.

---

## How caching works

| Endpoint            | Server-side cache (Vercel CDN) | stale-while-revalidate |
|---------------------|--------------------------------|------------------------|
| `/api/market-data`  | 30 minutes                     | 15 minutes             |
| `/api/market-history` | 6 hours                      | 1 hour                 |

Caching is handled by Next.js `fetch` options and `Cache-Control` headers.
Vercel's Edge Network respects `s-maxage` and `stale-while-revalidate`.

---

## Running tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

41 tests cover:
- Portfolio structure (5 assets, $10,000 total, correct weights)
- Core math (quantity, position value, return %)
- Holding state with missing prices
- Portfolio state with all/partial/no prices
- Benchmark normalization
- Ranking (highest return first, nulls last)
- Shared holding detection
- `isContestConfigured` edge cases
- Timeline building (includes weekends)
- Forward-fill (stocks filled, crypto not)
- Historical series start at exactly 0%
- Missing-price returns null (not zero)

---

## Deploying to Vercel

1. Import the GitHub repo in your Vercel dashboard.
2. Add the environment variable:
   - **Key**: `TWELVE_DATA_API_KEY`
   - **Value**: your Twelve Data API key
   - **Environments**: Production, Preview, Development
3. Deploy. The site auto-deploys on every push to `main`.

The API routes run as serverless functions. No GitHub Actions data pipeline is needed —
prices are fetched at request time, cached at the CDN layer.

---

## Setting TWELVE_DATA_API_KEY in Vercel

In your project settings → **Environment Variables**:

| Key | Value | Environments |
|-----|-------|--------------|
| `TWELVE_DATA_API_KEY` | `your_key_here` | Production, Preview, Development |

Or via the Vercel CLI:

```bash
vercel env add TWELVE_DATA_API_KEY production
```

---

## ⚠ Licensing notice

Before publicly launching this site, confirm that your Twelve Data plan permits
public display of market data. Most free plans restrict data to personal use only.
Check [twelvedata.com/pricing](https://twelvedata.com/pricing) and their terms of service.

---

## Disclaimer

This is a paper-trading entertainment experiment. No real money is invested.
Market data may be delayed. Nothing on this website is financial advice.
