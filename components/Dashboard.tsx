'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import type { ContestConfig, Prices, PortfolioState, BenchmarkState, HistoryPoint } from '@/lib/types';
import type { MarketDataResponse, MarketHistoryResponse } from '@/lib/types';
import {
  computePortfolioState,
  computeBenchmarkState,
  rankPortfolios,
  isContestConfigured,
} from '@/lib/calculations';
import { buildHistorySeries, forwardFillPrices, buildMasterTimeline } from '@/lib/history';
import { isMarketDay } from '@/lib/market-calendar';
import { PORTFOLIOS, BENCHMARK } from '@/lib/portfolios';
import { Hero } from './Hero';
import { Leaderboard } from './Leaderboard';
import { PortfolioPanel } from './PortfolioPanel';
import { SharedPicks } from './SharedPicks';
import { Methodology } from './Methodology';
import { Disclaimer } from './Disclaimer';
import { PurchaseRecord } from './PurchaseRecord';

// Load the chart client-only; Chart.js requires browser canvas APIs and must
// not run during server-side rendering.
const PerformanceChart = dynamic(
  () => import('./PerformanceChart').then((m) => ({ default: m.PerformanceChart })),
  { ssr: false },
);

interface Props {
  contestConfig: ContestConfig;
}

type ChartMode = 'pct' | 'value';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const WAVE2_DELAY_MS = 65_000; // 65 seconds between Wave 1 and Wave 2 on market days

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function Dashboard({ contestConfig }: Props) {
  const configured = useMemo(() => isContestConfigured(contestConfig), [contestConfig]);

  // prices is cumulative: each wave's result is merged in with spread.
  // This ensures Wave 1 data stays visible while Wave 2 is still pending.
  const [prices, setPrices] = useState<Prices | null>(null);
  const [historyResponse, setHistoryResponse] = useState<MarketHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [wave2Pending, setWave2Pending] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isFresh, setIsFresh] = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>('pct');

  // ── History fetch (independent of wave cycle) ─────────────────────────────

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/market-history', { cache: 'no-store' });
      if (res.ok) setHistoryResponse(await res.json());
    } catch {
      // history is non-critical; fail silently
    }
  }, []);

  // ── Single-wave quote fetch ───────────────────────────────────────────────

  const fetchWave = useCallback(async (waveNum: 1 | 2): Promise<void> => {
    try {
      const res = await fetch(`/api/market-data?wave=${waveNum}`, { cache: 'no-store' });
      const data: MarketDataResponse = await res.json();

      const newPrices = data.prices;
      if (newPrices && Object.keys(newPrices).length > 0) {
        // Spread-merge so existing prices from the other wave are preserved
        setPrices((prev) => ({ ...prev, ...newPrices }));
        if (waveNum === 1) setLastUpdated(data.timestamp);
        if (waveNum === 2) {
          setLastUpdated(data.timestamp);
          setIsFresh(data.isFresh ?? false);
        }
      }

      // A 503 means the API key is not configured — surface it once.
      // A 502 (rate limit / network) is transient; stale prices stay on screen.
      if (res.status === 503 && data.error) {
        console.error(`[wave${waveNum}] fatal:`, data.error);
      } else if (!res.ok) {
        console.warn(`[wave${waveNum}] non-fatal (${res.status}):`, data.error ?? res.statusText);
      }
    } catch (err) {
      console.warn(`[wave${waveNum}] network error:`, err);
    }
  }, []);

  // ── Wave orchestration ────────────────────────────────────────────────────

  useEffect(() => {
    if (!configured) {
      setIsLoading(false);
      return;
    }

    let alive = true;

    async function runCycle(isInitialLoad: boolean): Promise<void> {
      const marketDay = isMarketDay();

      if (isInitialLoad) {
        // First load: fetch both waves in parallel. Speed matters more here
        // than rate-limit spacing (two calls from a single visitor is fine).
        setIsLoading(true);
        await Promise.all([fetchWave(1), fetchWave(2), fetchHistory()]);
        if (alive) {
          setIsLoading(false);
          setWave2Pending(false);
        }
      } else if (!marketDay) {
        // Weekend / holiday: stocks don't change — only refresh crypto.
        // Wave 1 returns the server's cached stock prices from the last market close.
        await Promise.all([fetchWave(1), fetchWave(2)]);
      } else {
        // Market-day refresh: Wave 1 first, then at least 65 s later Wave 2.
        // The delay keeps us well within Twelve Data's per-minute call limit.
        setWave2Pending(true);
        await fetchWave(1);
        if (!alive) return;

        await sleep(WAVE2_DELAY_MS);
        if (!alive) return;

        await fetchWave(2);
        if (alive) setWave2Pending(false);
      }

      // Schedule the next cycle
      if (alive) {
        setTimeout(() => {
          if (alive) runCycle(false);
        }, REFRESH_INTERVAL_MS);
      }
    }

    runCycle(true);
    return () => {
      alive = false;
    };
  }, [configured, fetchWave, fetchHistory]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const portfolioStates = useMemo<PortfolioState[] | null>(() => {
    if (!configured || !prices) return null;
    const raw = PORTFOLIOS.map((p) =>
      computePortfolioState(p, contestConfig.startPrices, prices, contestConfig.startingValue),
    );
    const benchmark = computeBenchmarkState(contestConfig, prices);
    return rankPortfolios(raw, benchmark.returnPct);
  }, [configured, prices, contestConfig]);

  const benchmarkState = useMemo<BenchmarkState | null>(() => {
    if (!configured || !prices) return null;
    return computeBenchmarkState(contestConfig, prices);
  }, [configured, prices, contestConfig]);

  const historySeries = useMemo<HistoryPoint[] | null>(() => {
    if (!configured || !historyResponse || historyResponse.dates.length === 0) return null;

    const { dailyPrices, dates } = historyResponse;

    const assetClasses: Record<string, 'stock' | 'crypto'> = {};
    for (const p of PORTFOLIOS) {
      for (const h of p.holdings) assetClasses[h.apiSymbol] = h.assetClass;
    }
    assetClasses[BENCHMARK.apiSymbol] = 'stock';

    const filled = forwardFillPrices(dailyPrices, assetClasses, dates);

    const today = new Date().toISOString().split('T')[0];
    const allDates = dates.includes(today) ? dates : [...dates, today];

    if (prices && !dates.includes(today)) {
      for (const [sym, price] of Object.entries(prices)) {
        if (!filled[sym]) filled[sym] = {};
        filled[sym][today] = price;
      }
    }

    const masterDates = buildMasterTimeline(dates[0], today);
    const refilled = forwardFillPrices(filled, assetClasses, masterDates);

    const startDate = dates[0];
    const series = buildHistorySeries(allDates, refilled, PORTFOLIOS, contestConfig);

    const startIdx = series.findIndex((p) => p.date === startDate);
    if (startIdx >= 0) {
      series[startIdx] = { date: startDate, chatgpt: 0, claude: 0, gemini: 0, spy: 0 };
    }

    return series;
  }, [configured, historyResponse, prices, contestConfig]);

  const startDateStr = useMemo(
    () => new Date(contestConfig.officialPurchaseTimestamp).toISOString().split('T')[0],
    [contestConfig.officialPurchaseTimestamp],
  );
  const baselineSeries = useMemo<HistoryPoint[]>(
    () => [{ date: startDateStr, chatgpt: 0, claude: 0, gemini: 0, spy: 0 }],
    [startDateStr],
  );
  const displaySeries = historySeries ?? baselineSeries;

  // ── Pre-contest view ──────────────────────────────────────────────────────

  if (!configured) {
    return (
      <>
        <Hero
          contestConfig={contestConfig}
          lastUpdated={null}
          isFresh={false}
          isLoading={false}
          onRefresh={() => {}}
        />
        <div className="main-content" style={{ paddingTop: 32 }}>
          <PerformanceChart
            series={baselineSeries}
            mode={chartMode}
            onModeChange={setChartMode}
            isLoading={false}
            pricesPending={true}
          />
          <div className="setup-banner">
            <h2>⏳ Waiting for official purchase prices</h2>
            <p>
              All 15 positions are locked and ready. Official starting prices have not been
              entered yet — run{' '}
              <code>node scripts/capture-start-prices.mjs</code> with your API key, or fill in
              prices manually in <code>contest.config.json</code>.
            </p>
          </div>
          <PurchaseRecord contestConfig={contestConfig} />
          <SharedPicks portfolios={PORTFOLIOS} />
          <Methodology />
          <Disclaimer />
        </div>
      </>
    );
  }

  // ── Live contest view ─────────────────────────────────────────────────────

  return (
    <>
      <Hero
        contestConfig={contestConfig}
        lastUpdated={lastUpdated}
        isFresh={isFresh}
        isLoading={isLoading}
        onRefresh={() => {
          // Manual refresh: re-run the cycle immediately (treated as non-initial
          // so the 65-second delay applies on market days)
          if (isMarketDay()) {
            setWave2Pending(true);
            fetchWave(1).then(() =>
              sleep(WAVE2_DELAY_MS).then(() => {
                fetchWave(2).then(() => setWave2Pending(false));
              }),
            );
          } else {
            Promise.all([fetchWave(1), fetchWave(2)]);
          }
        }}
      />

      <div className="main-content">
        {wave2Pending && (
          <div
            style={{
              padding: '8px 18px',
              fontSize: '0.72rem',
              color: 'var(--muted)',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: 7,
              marginBottom: 12,
            }}
          >
            ⏳ Stock prices updated — crypto refresh in ~65 s
          </div>
        )}

        <Leaderboard
          portfolios={portfolioStates}
          benchmark={benchmarkState}
          isLoading={isLoading && !portfolioStates}
        />

        <PerformanceChart
          series={displaySeries}
          mode={chartMode}
          onModeChange={setChartMode}
          isLoading={isLoading && !historySeries}
        />

        {PORTFOLIOS.map((p) => (
          <PortfolioPanel
            key={p.id}
            portfolio={p}
            state={portfolioStates?.find((s) => s.portfolio.id === p.id) ?? null}
            isLoading={isLoading}
          />
        ))}

        <PurchaseRecord contestConfig={contestConfig} />
        <SharedPicks portfolios={PORTFOLIOS} />
        <Methodology />
        <Disclaimer />
      </div>
    </>
  );
}
