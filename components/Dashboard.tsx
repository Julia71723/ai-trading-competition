'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { ContestConfig, HistoryPoint, PortfolioState, BenchmarkState } from '@/lib/types';
import type { MarketSnapshot } from '@/lib/snapshot';
import { isContestConfigured } from '@/lib/calculations';
import { PORTFOLIOS } from '@/lib/portfolios';
import { Hero } from './Hero';
import { Leaderboard } from './Leaderboard';
import { PortfolioPanel } from './PortfolioPanel';
import { SharedPicks } from './SharedPicks';
import { Methodology } from './Methodology';
import { Disclaimer } from './Disclaimer';
import { PurchaseRecord } from './PurchaseRecord';

const PerformanceChart = dynamic(
  () => import('./PerformanceChart').then((m) => ({ default: m.PerformanceChart })),
  { ssr: false },
);

interface Props {
  contestConfig: ContestConfig;
  /** The pre-computed daily snapshot, or null if none has been generated yet. */
  snapshot: MarketSnapshot | null;
  /** True when the snapshot is older than the most recent expected market close. */
  isStale: boolean;
  /** Baseline states computed from official start prices; provided when snapshot is null. */
  baselinePortfolios?: PortfolioState[];
  baselineBenchmark?: BenchmarkState;
}

type ChartMode = 'pct' | 'value';

export function Dashboard({
  contestConfig,
  snapshot,
  isStale,
  baselinePortfolios,
  baselineBenchmark,
}: Props) {
  const configured = useMemo(() => isContestConfigured(contestConfig), [contestConfig]);
  const [chartMode, setChartMode] = useState<ChartMode>('pct');

  const startDateStr = useMemo(
    () => new Date(contestConfig.officialPurchaseTimestamp).toISOString().split('T')[0],
    [contestConfig.officialPurchaseTimestamp],
  );

  // Single-point baseline series: July 24 purchase at 0% for all portfolios.
  const baselineSeries = useMemo<HistoryPoint[]>(
    () => [{ date: startDateStr, chatgpt: 0, claude: 0, gemini: 0, spy: 0 }],
    [startDateStr],
  );

  // ── Pre-contest / not-yet-configured view ────────────────────────────────

  if (!configured) {
    return (
      <>
        <Hero contestConfig={contestConfig} snapshot={null} isStale={false} />
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

  // ── Live contest view — render from snapshot ─────────────────────────────

  // When a snapshot is available, use its data. When not yet available, use
  // the baseline (start prices → 0% returns everywhere).
  const portfolios: PortfolioState[] | null = snapshot?.portfolios ?? baselinePortfolios ?? null;
  const benchmark: BenchmarkState | null = snapshot?.benchmark ?? baselineBenchmark ?? null;
  const displaySeries =
    snapshot && snapshot.chartData.length > 0 ? snapshot.chartData : baselineSeries;

  return (
    <>
      <Hero contestConfig={contestConfig} snapshot={snapshot} isStale={isStale} />

      <div className="main-content">
        {/* Stale snapshot warning */}
        {snapshot && isStale && (
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
            ⚠ Snapshot is from {snapshot.asOfLabel}. The daily refresh for the most recent
            session has not completed yet — this data will update automatically.
          </div>
        )}

        {/* Awaiting first snapshot banner */}
        {!snapshot && (
          <div className="setup-banner" style={{ marginBottom: 20 }}>
            <h2>⏳ Awaiting first market-close snapshot</h2>
            <p>
              Values below use the official July 24, 2026 purchase prices as a baseline
              (0% return). Live returns will appear automatically after the next market-close
              snapshot is generated at approximately 4:20 PM ET on the next trading day.
            </p>
          </div>
        )}

        <Leaderboard
          portfolios={portfolios}
          benchmark={benchmark}
          isLoading={false}
        />

        <PerformanceChart
          series={displaySeries}
          mode={chartMode}
          onModeChange={setChartMode}
          isLoading={false}
        />

        {PORTFOLIOS.map((p) => (
          <PortfolioPanel
            key={p.id}
            portfolio={p}
            state={portfolios?.find((s) => s.portfolio.id === p.id) ?? null}
            isLoading={false}
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
