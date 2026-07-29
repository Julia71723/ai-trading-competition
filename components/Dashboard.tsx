'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { ContestConfig, HistoryPoint } from '@/lib/types';
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

// Chart.js requires browser canvas APIs — load client-only.
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
}

type ChartMode = 'pct' | 'value';

export function Dashboard({ contestConfig, snapshot, isStale }: Props) {
  const configured = useMemo(() => isContestConfigured(contestConfig), [contestConfig]);
  const [chartMode, setChartMode] = useState<ChartMode>('pct');

  // Baseline series used before any real data is available.
  const startDateStr = useMemo(
    () => new Date(contestConfig.officialPurchaseTimestamp).toISOString().split('T')[0],
    [contestConfig.officialPurchaseTimestamp],
  );
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

  // ── No snapshot yet ──────────────────────────────────────────────────────

  if (!snapshot) {
    return (
      <>
        <Hero contestConfig={contestConfig} snapshot={null} isStale={false} />
        <div className="main-content" style={{ paddingTop: 32 }}>
          <PerformanceChart
            series={baselineSeries}
            mode={chartMode}
            onModeChange={setChartMode}
            isLoading={false}
          />
          <div className="setup-banner">
            <h2>⏳ Waiting for first market-close snapshot</h2>
            <p>
              The daily snapshot has not been generated yet. It will be created automatically
              at approximately 4:20 PM ET on the next trading day. To generate it immediately,
              call{' '}
              <code>GET /api/cron/refresh-market-snapshot</code> with your{' '}
              <code>CRON_SECRET</code> header.
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

  const displaySeries = snapshot.chartData.length > 0 ? snapshot.chartData : baselineSeries;

  return (
    <>
      <Hero contestConfig={contestConfig} snapshot={snapshot} isStale={isStale} />

      <div className="main-content">
        {isStale && (
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

        <Leaderboard
          portfolios={snapshot.portfolios}
          benchmark={snapshot.benchmark}
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
            state={snapshot.portfolios.find((s) => s.portfolio.id === p.id) ?? null}
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
