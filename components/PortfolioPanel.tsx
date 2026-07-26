import type { PortfolioState } from '@/lib/types';
import type { Portfolio } from '@/lib/types';

interface Props {
  portfolio: Portfolio;
  state: PortfolioState | null;
  isLoading: boolean;
}

function fmtDollar(n: number, decimals = 2): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtQty(n: number): string {
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtPrice(n: number): string {
  if (n >= 1000) return fmtDollar(n, 2);
  if (n >= 1) return fmtDollar(n, 2);
  return fmtDollar(n, 4);
}

const HOLDING_COLORS = [
  '#f97316', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b',
];

export function PortfolioPanel({ portfolio, state, isLoading }: Props) {
  const totalValue = state?.totalValue ?? null;
  const returnPct = state?.returnPct ?? null;
  const vsSpyPct = state?.vsSpyPct ?? null;
  const gainLoss = state?.gainLoss ?? null;
  const rank = state?.rank ?? null;

  const ordinal = (n: number) => ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`;

  return (
    <div
      className="portfolio-panel"
      style={{ '--accent': portfolio.color } as React.CSSProperties}
    >
      {/* Panel header */}
      <div className="panel-header">
        <div>
          <div className="panel-title">
            <div className="panel-dot" style={{ background: portfolio.color }} />
            <span className="panel-name">{portfolio.name}</span>
          </div>
          {rank && (
            <div className="panel-rank-badge" style={{ marginLeft: 20, marginTop: 4 }}>
              {ordinal(rank)} place
            </div>
          )}
        </div>

        <div className="panel-stats">
          <div className="panel-stat">
            <div className="panel-stat-label">Total value</div>
            <div className="panel-stat-value large" style={{ color: 'var(--text)' }}>
              {isLoading ? <span className="skeleton skeleton-num" style={{ width: 100, height: 22, display: 'inline-block' }} /> : totalValue !== null ? fmtDollar(totalValue) : '—'}
            </div>
          </div>
          <div className="panel-stat">
            <div className="panel-stat-label">Total return</div>
            <div
              className="panel-stat-value"
              style={{ color: returnPct !== null ? (returnPct >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--muted)' }}
            >
              {isLoading ? <span className="skeleton skeleton-num" style={{ width: 70, display: 'inline-block' }} /> : returnPct !== null ? fmtPct(returnPct) : '—'}
            </div>
          </div>
          <div className="panel-stat">
            <div className="panel-stat-label">vs S&amp;P 500</div>
            <div
              className="panel-stat-value"
              style={{ color: vsSpyPct !== null ? (vsSpyPct >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--muted)' }}
            >
              {isLoading ? <span className="skeleton skeleton-num" style={{ width: 70, display: 'inline-block' }} /> : vsSpyPct !== null ? fmtPct(vsSpyPct) : '—'}
            </div>
          </div>
          <div className="panel-stat">
            <div className="panel-stat-label">Gain / Loss</div>
            <div
              className="panel-stat-value"
              style={{ color: gainLoss !== null ? (gainLoss >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--muted)' }}
            >
              {isLoading ? <span className="skeleton skeleton-num" style={{ width: 80, display: 'inline-block' }} /> : gainLoss !== null ? (gainLoss >= 0 ? '+' : '') + fmtDollar(gainLoss) : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Holdings table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Class</th>
              <th>Alloc.</th>
              <th>Wt</th>
              <th>Start $</th>
              <th>Qty</th>
              <th>Current $</th>
              <th>Value</th>
              <th>Return</th>
              <th>Contribution</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.holdings.map((h, i) => {
              const hs = state?.holdings[i];
              return (
                <tr key={h.apiSymbol}>
                  <td>{h.name}<br /><span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontFamily: 'var(--num-font)', fontWeight: 600 }}>{h.ticker}</span></td>
                  <td>
                    <span className={`asset-class-badge ${h.assetClass}`}>{h.assetClass}</span>
                  </td>
                  <td style={{ fontFamily: 'var(--num-font)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtDollar(h.allocation, 0)}
                  </td>
                  <td>{(h.weight * 100).toFixed(0)}%</td>
                  <td>
                    {hs?.startPrice != null ? fmtPrice(hs.startPrice) : <span className="neu">—</span>}
                  </td>
                  <td>
                    {hs?.quantity != null ? fmtQty(hs.quantity) : <span className="neu">—</span>}
                  </td>
                  <td>
                    {isLoading ? <span className="skeleton skeleton-num" style={{ width: 60, display: 'inline-block' }} />
                      : hs?.currentPrice != null ? fmtPrice(hs.currentPrice) : <span className="neu">—</span>}
                  </td>
                  <td>
                    {isLoading ? <span className="skeleton skeleton-num" style={{ width: 70, display: 'inline-block' }} />
                      : hs?.positionValue != null ? fmtDollar(hs.positionValue) : <span className="neu">—</span>}
                  </td>
                  <td>
                    {isLoading ? <span className="skeleton skeleton-num" style={{ width: 55, display: 'inline-block' }} />
                      : hs?.returnPct != null
                        ? <span className={hs.returnPct >= 0 ? 'pos' : 'neg'}>{fmtPct(hs.returnPct)}</span>
                        : <span className="neu">—</span>}
                  </td>
                  <td>
                    {isLoading ? <span className="skeleton skeleton-num" style={{ width: 55, display: 'inline-block' }} />
                      : hs?.portfolioContribution != null
                        ? <span className={hs.portfolioContribution >= 0 ? 'pos' : 'neg'}>{fmtPct(hs.portfolioContribution)}</span>
                        : <span className="neu">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Allocation bar */}
      <div className="allocation-bar-row">
        <div className="allocation-bar-label">Original allocation</div>
        <div className="allocation-bar">
          {portfolio.holdings.map((h, i) => (
            <div
              key={h.apiSymbol}
              className="allocation-segment"
              style={{
                width: (h.weight * 100) + '%',
                background: HOLDING_COLORS[i % HOLDING_COLORS.length],
              }}
              title={`${h.ticker}: ${(h.weight * 100).toFixed(0)}%`}
            />
          ))}
        </div>
        <div className="allocation-legend">
          {portfolio.holdings.map((h, i) => (
            <div key={h.apiSymbol} className="allocation-legend-item">
              <div className="allocation-legend-dot" style={{ background: HOLDING_COLORS[i % HOLDING_COLORS.length] }} />
              <span>{h.ticker} {(h.weight * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>

        {/* Current allocation drift */}
        {totalValue !== null && state && (
          <>
            <div className="allocation-bar-label" style={{ marginTop: 12 }}>Current allocation (drift)</div>
            <div className="allocation-bar">
              {portfolio.holdings.map((h, i) => {
                const hs = state.holdings[i];
                const currentWeight = hs?.positionValue != null && totalValue > 0
                  ? (hs.positionValue / totalValue) * 100
                  : h.weight * 100;
                return (
                  <div
                    key={h.apiSymbol}
                    className="allocation-segment"
                    style={{
                      width: currentWeight + '%',
                      background: HOLDING_COLORS[i % HOLDING_COLORS.length],
                      opacity: 0.65,
                    }}
                    title={`${h.ticker}: ${currentWeight.toFixed(1)}%`}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
