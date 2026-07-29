'use client';

import { useEffect, useState } from 'react';
import type { ContestConfig } from '@/lib/types';
import type { MarketSnapshot } from '@/lib/snapshot';
import { isContestConfigured } from '@/lib/calculations';

interface HeroProps {
  contestConfig: ContestConfig;
  snapshot: MarketSnapshot | null;
  isStale: boolean;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Contest ended';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${d}d ${h}h ${m}m`;
}

function formatDateTime(isoStr: string): string {
  return new Date(isoStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

export function Hero({ contestConfig, snapshot, isStale }: HeroProps) {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    function tick() {
      const end = new Date(contestConfig.endTimestamp).getTime();
      setCountdown(formatCountdown(end - Date.now()));
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [contestConfig.endTimestamp]);

  const configured = isContestConfigured(contestConfig);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <div className="site-header-brand">
          <h1>{contestConfig.contestName}</h1>
          <span className="paper-badge">Paper trading</span>
        </div>
        <div className="header-meta">
          {snapshot && (
            <span style={{ color: isStale ? 'var(--muted)' : 'var(--muted-mid)' }}>
              {snapshot.asOfLabel}
            </span>
          )}
        </div>
      </div>

      <div className="main-content" style={{ paddingBottom: 0, paddingTop: 28 }}>
        <div className="hero">
          <div>
            <h2 className="hero-title">{contestConfig.contestName}</h2>
            <p className="hero-subtitle" style={{ marginTop: 10 }}>
              ChatGPT vs. Claude vs. Gemini: three locked $10,000 paper portfolios
              competing through December 31, 2026.
            </p>
          </div>

          <div className="hero-meta">
            <div className="hero-meta-item">
              <span className="hero-meta-label">Status</span>
              <span className="hero-meta-value">
                {configured ? (
                  <>
                    <span className="status-dot" aria-hidden="true" />
                    Contest in progress
                  </>
                ) : (
                  'Starting soon'
                )}
              </span>
            </div>

            <div className="hero-meta-item">
              <span className="hero-meta-label">Official purchase date</span>
              <span className="hero-meta-value">
                {formatDateTime(contestConfig.officialPurchaseTimestamp)}
              </span>
            </div>

            <div className="hero-meta-item">
              <span className="hero-meta-label">Time remaining</span>
              <span className="hero-meta-value countdown">{countdown || '—'}</span>
            </div>

            {snapshot && (
              <div className="hero-meta-item">
                <span className="hero-meta-label">Data</span>
                <span
                  className="hero-meta-value"
                  style={{ color: isStale ? 'var(--muted)' : 'var(--green)' }}
                >
                  {isStale ? 'Stale — pending refresh' : 'Market-close snapshot'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
