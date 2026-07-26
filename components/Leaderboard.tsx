import type { PortfolioState, BenchmarkState } from '@/lib/types';

interface Props {
  portfolios: PortfolioState[] | null;
  benchmark: BenchmarkState | null;
  isLoading: boolean;
}

function fmtDollar(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number, decimals = 2): string {
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(decimals) + '%';
}

function fmtDiff(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return sign + fmtDollar(n);
}

function ReturnCell({ value, loading }: { value: number | null; loading: boolean }) {
  if (loading) return <span className="skeleton skeleton-num" />;
  if (value === null) return <span className="neu">—</span>;
  return <span className={value >= 0 ? 'pos' : 'neg'}>{fmtPct(value)}</span>;
}

function ValueCell({ value, loading }: { value: number | null; loading: boolean }) {
  if (loading) return <span className="skeleton skeleton-num" />;
  if (value === null) return <span className="neu">—</span>;
  return <span>{fmtDollar(value)}</span>;
}

export function Leaderboard({ portfolios, benchmark, isLoading }: Props) {
  const leader = portfolios?.[0];
  const second = portfolios?.[1];
  const gap =
    leader?.returnPct != null && second?.returnPct != null
      ? leader.returnPct - second.returnPct
      : null;

  return (
    <div className="card">
      <div className="card-header">
        <span className="section-label">Leaderboard</span>
        {gap !== null && (
          <div className="gap-bar" style={{ border: 'none', background: 'none', padding: '0', fontSize: '0.72rem' }}>
            <span style={{ color: 'var(--muted)' }}>1st–2nd gap:</span>
            <span className="pos" style={{ fontFamily: 'var(--num-font)', fontWeight: 700 }}>
              {fmtPct(gap)}
            </span>
          </div>
        )}
      </div>

      <div style={{ padding: '0 0 4px' }}>
        {/* Column headers */}
        <div className="leaderboard-header-row" style={{ marginTop: 4 }}>
          <span>#</span>
          <span>AI</span>
          <span style={{ textAlign: 'right' }}>Value</span>
          <span style={{ textAlign: 'right' }}>Gain/Loss</span>
          <span style={{ textAlign: 'right' }}>Return</span>
          <span style={{ textAlign: 'right' }}>vs S&amp;P 500</span>
          <span>Best / Worst holding</span>
        </div>

        <div className="leaderboard" style={{ padding: '8px 0 4px' }}>
          {isLoading && !portfolios
            ? [0, 1, 2].map((i) => (
                <div key={i} className="leaderboard-row" style={{ gap: '8px' }}>
                  <span className="skeleton skeleton-text short" />
                  <span className="skeleton skeleton-text medium" />
                  <span className="skeleton skeleton-num" style={{ marginLeft: 'auto' }} />
                  <span className="skeleton skeleton-num" style={{ marginLeft: 'auto' }} />
                  <span className="skeleton skeleton-num" style={{ marginLeft: 'auto' }} />
                  <span className="skeleton skeleton-num" style={{ marginLeft: 'auto' }} />
                  <span className="skeleton skeleton-text medium" />
                </div>
              ))
            : portfolios?.map((ps) => (
                <div
                  key={ps.portfolio.id}
                  className={`leaderboard-row${ps.rank === 1 ? ' leader' : ''}`}
                  style={{ '--accent': ps.portfolio.color } as React.CSSProperties}
                >
                  <span className="lb-rank">
                    {ps.rank === 1 && <span className="crown" aria-label="Leader">👑</span>}
                    {ps.rank !== 1 && ps.rank}
                  </span>

                  <div className="lb-name">
                    <div className="lb-dot" style={{ background: ps.portfolio.color, '--accent': ps.portfolio.color } as React.CSSProperties} />
                    <span className="lb-name-text">{ps.portfolio.name}</span>
                  </div>

                  <span className="lb-num primary">
                    <ValueCell value={ps.totalValue} loading={isLoading} />
                  </span>

                  <span className="lb-num" style={{ color: ps.gainLoss !== null ? (ps.gainLoss >= 0 ? 'var(--green)' : 'var(--red)') : undefined }}>
                    {isLoading ? <span className="skeleton skeleton-num" /> : ps.gainLoss !== null ? fmtDiff(ps.gainLoss) : '—'}
                  </span>

                  <span className="lb-num">
                    <ReturnCell value={ps.returnPct} loading={isLoading} />
                  </span>

                  <span className="lb-num">
                    {isLoading ? (
                      <span className="skeleton skeleton-num" />
                    ) : ps.vsSpyPct !== null ? (
                      <span className={ps.vsSpyPct >= 0 ? 'pos' : 'neg'}>
                        {fmtPct(ps.vsSpyPct)}
                      </span>
                    ) : '—'}
                  </span>

                  <div className="lb-highlights">
                    {ps.bestHolding && (
                      <span className="best">▲ {ps.bestHolding.holding.ticker} {ps.bestHolding.returnPct !== null ? fmtPct(ps.bestHolding.returnPct) : ''}</span>
                    )}
                    {ps.worstHolding && (
                      <span className="worst">▼ {ps.worstHolding.holding.ticker} {ps.worstHolding.returnPct !== null ? fmtPct(ps.worstHolding.returnPct) : ''}</span>
                    )}
                    {!ps.bestHolding && !isLoading && <span style={{ color: 'var(--muted)' }}>—</span>}
                  </div>
                </div>
              ))
          }

          {/* Benchmark row */}
          {benchmark && (
            <div className="leaderboard-benchmark">
              <span className="lb-rank neu">—</span>
              <div className="lb-name">
                <div className="lb-spy-dot" />
                <span className="lb-name-text" style={{ color: 'var(--muted-mid)', fontSize: '0.82rem' }}>
                  S&amp;P 500
                </span>
              </div>
              <span className="lb-num">
                {benchmark.totalValue !== null ? fmtDollar(benchmark.totalValue) : '—'}
              </span>
              <span className="lb-num" style={{ color: benchmark.returnPct !== null ? (benchmark.returnPct >= 0 ? 'var(--green)' : 'var(--red)') : undefined }}>
                {benchmark.totalValue !== null
                  ? fmtDiff(benchmark.totalValue - 10000)
                  : '—'}
              </span>
              <span className="lb-num">
                {benchmark.returnPct !== null ? (
                  <span className={benchmark.returnPct >= 0 ? 'pos' : 'neg'}>
                    {fmtPct(benchmark.returnPct)}
                  </span>
                ) : '—'}
              </span>
              <span className="lb-num neu">benchmark</span>
              <span className="lb-highlights" />
            </div>
          )}
        </div>
      </div>

      <div className="benchmark-note">
        <div className="lb-spy-dot" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--spy)', marginRight: 4 }} />
        S&amp;P 500 benchmark — tracked using SPY (price return only, dividends excluded)
      </div>
    </div>
  );
}
