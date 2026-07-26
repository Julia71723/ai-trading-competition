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

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between refresh cycles
const WAVE2_DELAY_MS = 65_000; // minimum gap between Wave 1 and Wave 2 on market days
const SOFT_MSG = 'Updating remaining market prices — cached values shown.';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function Dashboard({ contestConfig }: Props) {
  const configured = useMemo(() => isContestConfigured(contestConfig), [contestConfig]);

  // Pre-seed prices with the official starting prices so the leaderboard
  // always shows something from the very first render. Each wave's response
  // is spread-merged in on top, replacing only the symbols it contains.
  const [prices, setPrices] = useState<Prices>(() => {
    const seed: Prices = {};
    for (const [sym, price] of Object.entries(contestConfig.startPrices)) {
      if (price !== null) seed[sym] = price;
    }
    return seed;
  });
  const [historyResponse, setHistoryResponse] = useState<MarketHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Shown below the hero while Wave 2 is pending or after a transient upstream error.
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isFresh, setIsFresh] = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>('pct');

  // ── History fetch ─────────────────────────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/market-history', { cache: 'no-store' });
      if (res.ok) setHistoryResponse(await res.json());
    } catch {
      // history is non-critical; fail silently
    }
  }, []);

  // ── Single-wave quote fetch ───────────────────────────────────────────────

  // Returns true if the wave completed with fresh prices and no server error.
  const fetchWave = useCallback(async (waveNum: 1 | 2): Promise<boolean> => {
    try {
      const res = await fetch(`/api/market-data?wave=${waveNum}`, { cache: 'no-store' });
      const data: MarketDataResponse = await res.json();

      // Merge new prices over existing state. Prices from the other wave and
      // from the starting-price seed are preserved by the spread.
      if (data.prices && Object.keys(data.prices).length > 0) {
        setPrices((prev) => ({ ...prev, ...data.prices }));
      }

      if (data.timestamp) setLastUpdated(data.timestamp);
      if (waveNum === 2) setIsFresh(data.isFresh ?? false);

      if (res.status === 503) {
        // API key not configured — non-recoverable without a server change.
        console.error(`[wave${waveNum}]`, data.error);
        return false;
      }
      if (data.error) {
        // Rate-limit or transient error; stale/seed prices already in state.
        console.warn(`[wave${waveNum}]`, data.error);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[wave${waveNum}] network error:`, err);
      return false;
    }
  }, []);

  // ── Wave orchestration ────────────────────────────────────────────────────

  useEffect(() => {
    if (!configured) {
      setIsLoading(false);
      return;
    }

    let alive = true;

    const runCycle = async (initial: boolean): Promise<void> => {
      const marketDay = isMarketDay();

      if (!marketDay) {
        // Weekend / holiday: stocks don't trade. Fetch only crypto; stock prices
        // remain at the official starting prices (or last cached close in state).
        const ok = await fetchWave(2);
        if (!alive) return;
        setStatusMessage(ok ? null : SOFT_MSG);
        if (initial) setIsLoading(false);
      } else {
        // Market day — Wave 1 first:
        await fetchWave(1);
        if (!alive) return;

        // Show Wave 1 results immediately; Wave 2 follows after the mandatory gap.
        if (initial) setIsLoading(false);
        setStatusMessage(SOFT_MSG);

        await sleep(WAVE2_DELAY_MS);
        if (!alive) return;

        const ok2 = await fetchWave(2);
        if (!alive) return;

        setStatusMessage(ok2 ? null : SOFT_MSG);
      }

      if (alive) {
        setTimeout(() => {
          if (alive) runCycle(false);
        }, REFRESH_INTERVAL_MS);
      }
    };

    fetchHistory();
    runCycle(true);

    return () => {
      alive = false;
    };
  }, [configured, fetchWave, fetchHistory]);

  // ── Manual refresh (Hero button) ──────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    if (!isMarketDay()) {
      fetchWave(2).then((ok) => {
        setStatusMessage(ok ? null : SOFT_MSG);
      });
    } else {
      setStatusMessage(SOFT_MSG);
      fetchWave(1).then(() =>
        sleep(WAVE2_DELAY_MS).then(() =>
          fetchWave(2).then((ok2) => {
            setStatusMessage(ok2 ? null : SOFT_MSG);
          }),
        ),
      );
    }
  }, [fetchWave]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const portfolioStates = useMemo<PortfolioState[] | null>(() => {
    if (!configured) return null;
    const raw = PORTFOLIOS.map((p) =>
      computePortfolioState(p, contestConfig.startPrices, prices, contestConfig.startingValue),
    );
    const benchmark = computeBenchmarkState(contestConfig, prices);
    return rankPortfolios(raw, benchmark.returnPct);
  }, [configured, prices, contestConfig]);

  const benchmarkState = useMemo<BenchmarkState | null>(() => {
    if (!configured) return null;
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

    if (!dates.includes(today)) {
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
        onRefresh={handleRefresh}
      />

      <div className="main-content">
        {statusMessage && (
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
            ⏳ {statusMessage}
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
