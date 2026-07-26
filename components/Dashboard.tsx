'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { ContestConfig, Prices, PortfolioState, BenchmarkState, HistoryPoint } from '@/lib/types';
import type { MarketDataResponse, MarketHistoryResponse } from '@/lib/types';
import {
  computePortfolioState,
  computeBenchmarkState,
  rankPortfolios,
  isContestConfigured,
} from '@/lib/calculations';
import { buildHistorySeries, forwardFillPrices, buildMasterTimeline } from '@/lib/history';
import { PORTFOLIOS, BENCHMARK } from '@/lib/portfolios';
import { Hero } from './Hero';
import { Leaderboard } from './Leaderboard';
import { PerformanceChart } from './PerformanceChart';
import { PortfolioPanel } from './PortfolioPanel';
import { SharedPicks } from './SharedPicks';
import { Methodology } from './Methodology';
import { Disclaimer } from './Disclaimer';

interface Props {
  contestConfig: ContestConfig;
}

type ChartMode = 'pct' | 'value';

function SetupBanner() {
  return (
    <div className="main-content" style={{ paddingTop: 32 }}>
      <div className="setup-banner">
        <h2>⏳ Waiting for official purchase prices</h2>
        <p>
          The contest configuration is ready, but the official starting prices have not been
          entered yet. Once you capture the prices at the official purchase timestamp
          and fill them into <code>contest.config.json</code>, live performance will appear here.
        </p>
        <p style={{ marginTop: 8 }}>
          See the README for exact instructions, or run{' '}
          <code>node scripts/capture-start-prices.mjs</code> on the purchase date.
        </p>
      </div>

      {/* Show portfolios and allocations even in setup state */}
      <div className="setup-allocation-grid">
        {PORTFOLIOS.map((p) => (
          <div key={p.id} className="portfolio-panel" style={{ '--accent': p.color } as React.CSSProperties}>
            <div className="panel-header" style={{ alignItems: 'center' }}>
              <div className="panel-title">
                <div className="panel-dot" style={{ background: p.color }} />
                <span className="panel-name">{p.name}</span>
              </div>
              <span style={{ fontSize: '0.78rem', color: 'var(--muted)', fontFamily: 'var(--num-font)' }}>
                $10,000
              </span>
            </div>
            <table className="holdings-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Class</th>
                  <th>Allocation</th>
                  <th>Weight</th>
                </tr>
              </thead>
              <tbody>
                {p.holdings.map((h) => (
                  <tr key={h.apiSymbol}>
                    <td>{h.name}<br /><span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600 }}>{h.ticker}</span></td>
                    <td><span className={`asset-class-badge ${h.assetClass}`}>{h.assetClass}</span></td>
                    <td>${h.allocation.toLocaleString()}</td>
                    <td>{(h.weight * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <SharedPicks portfolios={PORTFOLIOS} />
      <Methodology />
      <Disclaimer />
    </div>
  );
}

export function Dashboard({ contestConfig }: Props) {
  const configured = useMemo(() => isContestConfigured(contestConfig), [contestConfig]);

  const [prices, setPrices] = useState<Prices | null>(null);
  const [historyResponse, setHistoryResponse] = useState<MarketHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isFresh, setIsFresh] = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>('pct');

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [pricesRes, histRes] = await Promise.all([
        fetch('/api/market-data', { cache: 'no-store' }),
        fetch('/api/market-history', { cache: 'no-store' }),
      ]);

      const pricesData: MarketDataResponse = await pricesRes.json();
      if (pricesData.error && !pricesRes.ok) {
        setError(pricesData.error);
      } else {
        setPrices(pricesData.prices);
        setIsFresh(pricesData.isFresh);
        setLastUpdated(pricesData.timestamp);
      }

      if (histRes.ok) {
        const histData: MarketHistoryResponse = await histRes.json();
        setHistoryResponse(histData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch market data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (configured) fetchData();
    else setIsLoading(false);
  }, [configured, fetchData]);

  // Compute portfolio states
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

  // Build history series client-side from raw daily prices
  const historySeries = useMemo<HistoryPoint[] | null>(() => {
    if (!configured || !historyResponse || historyResponse.dates.length === 0) return null;

    const { dailyPrices, dates } = historyResponse;

    // Asset class lookup for forward-fill
    const assetClasses: Record<string, 'stock' | 'crypto'> = {};
    for (const p of PORTFOLIOS) {
      for (const h of p.holdings) assetClasses[h.apiSymbol] = h.assetClass;
    }
    assetClasses[BENCHMARK.apiSymbol] = 'stock';

    const filled = forwardFillPrices(dailyPrices, assetClasses, dates);

    // Append current quote as last point if today is after last date
    const today = new Date().toISOString().split('T')[0];
    const allDates = dates.includes(today) ? dates : [...dates, today];

    // Ensure current prices are in filled for today
    if (prices && !dates.includes(today)) {
      for (const [sym, price] of Object.entries(prices)) {
        if (!filled[sym]) filled[sym] = {};
        filled[sym][today] = price;
      }
    }

    const masterDates = buildMasterTimeline(dates[0], today);
    const refilled = forwardFillPrices(filled, assetClasses, masterDates);

    // Insert day-0 as all-zero series point
    const startDate = dates[0];
    const series = buildHistorySeries(allDates, refilled, PORTFOLIOS, contestConfig);

    // Force the first point (contest start) to 0%
    const startIdx = series.findIndex((p) => p.date === startDate);
    if (startIdx >= 0) {
      series[startIdx] = { date: startDate, chatgpt: 0, claude: 0, gemini: 0, spy: 0 };
    }

    return series;
  }, [configured, historyResponse, prices, contestConfig]);

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
        <SetupBanner />
      </>
    );
  }

  return (
    <>
      <Hero
        contestConfig={contestConfig}
        lastUpdated={lastUpdated}
        isFresh={isFresh}
        isLoading={isLoading}
        onRefresh={fetchData}
      />

      <div className="main-content">
        {error && (
          <div className="error-banner" role="alert">
            <span>⚠ {error}</span>
            <button className="retry-btn" onClick={fetchData}>Retry</button>
          </div>
        )}

        <Leaderboard
          portfolios={portfolioStates}
          benchmark={benchmarkState}
          isLoading={isLoading && !portfolioStates}
        />

        <PerformanceChart
          series={historySeries}
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

        <SharedPicks portfolios={PORTFOLIOS} />
        <Methodology />
        <Disclaimer />
      </div>
    </>
  );
}
