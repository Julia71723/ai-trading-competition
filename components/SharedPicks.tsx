import type { Portfolio } from '@/lib/types';
import { findSharedHoldings } from '@/lib/calculations';

interface Props {
  portfolios: Portfolio[];
}

const PORTFOLIO_COLORS: Record<string, string> = {
  chatgpt: '#22c55e',
  claude: '#f97316',
  gemini: '#3b82f6',
};

export function SharedPicks({ portfolios }: Props) {
  const shared = findSharedHoldings(portfolios);

  // Group by how many portfolios hold it: all 3 vs 2
  const allThree = shared.filter((s) => s.portfolioIds.length === 3);
  const twoOf = shared.filter((s) => s.portfolioIds.length === 2);

  // Exclusive holdings (held by only one portfolio)
  const allApiSymbols = portfolios.flatMap((p) => p.holdings.map((h) => h.apiSymbol));
  const sharedSymbols = new Set(shared.map((s) => s.apiSymbol));
  const exclusiveByPortfolio = portfolios.map((p) => ({
    portfolio: p,
    holdings: p.holdings.filter((h) => !sharedSymbols.has(h.apiSymbol)),
  })).filter((x) => x.holdings.length > 0);

  // Suppress unused variable warning
  void allApiSymbols;

  return (
    <div className="card">
      <div className="card-header">
        <span className="section-label">Where the AIs agree</span>
      </div>

      {allThree.length > 0 && (
        <div>
          <div style={{ padding: '12px 22px 8px', fontSize: '0.7rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            All three picked
          </div>
          <div className="shared-picks-grid" style={{ paddingTop: 0 }}>
            {allThree.map((s) => (
              <div key={s.apiSymbol} className="shared-pick-card">
                <div className="shared-pick-symbol">{s.ticker}</div>
                <div className="shared-pick-name">{s.name}</div>
                <div className="shared-pick-holders">
                  {s.portfolioIds.map((id, i) => (
                    <span
                      key={id}
                      className="holder-chip"
                      style={{
                        background: PORTFOLIO_COLORS[id] + '18',
                        color: PORTFOLIO_COLORS[id],
                        border: `1px solid ${PORTFOLIO_COLORS[id]}30`,
                      }}
                    >
                      {s.portfolioNames[i]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {twoOf.length > 0 && (
        <div>
          <div style={{ padding: '12px 22px 8px', fontSize: '0.7rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', borderTop: '1px solid var(--border)' }}>
            Two models agree
          </div>
          <div className="shared-picks-grid" style={{ paddingTop: 0 }}>
            {twoOf.map((s) => (
              <div key={s.apiSymbol} className="shared-pick-card">
                <div className="shared-pick-symbol">{s.ticker}</div>
                <div className="shared-pick-name">{s.name}</div>
                <div className="shared-pick-holders">
                  {s.portfolioIds.map((id, i) => (
                    <span
                      key={id}
                      className="holder-chip"
                      style={{
                        background: PORTFOLIO_COLORS[id] + '18',
                        color: PORTFOLIO_COLORS[id],
                        border: `1px solid ${PORTFOLIO_COLORS[id]}30`,
                      }}
                    >
                      {s.portfolioNames[i]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {exclusiveByPortfolio.length > 0 && (
        <div>
          <div style={{ padding: '12px 22px 8px', fontSize: '0.7rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', borderTop: '1px solid var(--border)' }}>
            Exclusive picks
          </div>
          <div className="exclusive-grid">
            {exclusiveByPortfolio.map(({ portfolio, holdings }) => (
              <div key={portfolio.id} className="exclusive-card">
                <div className="exclusive-card-header">
                  <div style={{ width: 9, height: 9, borderRadius: '50%', background: portfolio.color, boxShadow: `0 0 5px ${portfolio.color}`, flexShrink: 0 }} />
                  <span className="exclusive-card-title" style={{ color: portfolio.color }}>{portfolio.name} only</span>
                </div>
                {holdings.map((h) => (
                  <div key={h.apiSymbol} className="exclusive-holding">
                    <span className="exclusive-ticker">{h.ticker}</span>
                    <span className="exclusive-alloc">${h.allocation.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
