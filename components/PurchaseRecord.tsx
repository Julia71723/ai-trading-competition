import type { ContestConfig } from '@/lib/types';
import { PORTFOLIOS } from '@/lib/portfolios';

const CRYPTO_SYMBOLS = new Set(['BTC/USD', 'ETH/USD', 'SOL/USD']);

interface Props {
  contestConfig: ContestConfig;
}

function fmtDollar(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPrice(n: number): string {
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQty(qty: number): string {
  return qty >= 1 ? qty.toFixed(6) : qty.toFixed(8);
}

export function PurchaseRecord({ contestConfig }: Props) {
  const { startPrices, startPriceMeta, startingValue } = contestConfig;
  const allPricesSet = Object.values(startPrices).every((p) => p !== null);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <span className="section-label">Official Purchase Record</span>
          <p style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 4 }}>
            All 15 positions were entered simultaneously using the official Friday, July 24, 2026
            regular-session closing prices for US stocks and SPY. Cryptocurrency positions use prices
            recorded at the same 4:00 PM ET timestamp.
          </p>
        </div>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 12px', borderRadius: 999,
            border: '1px solid var(--border-mid)',
            background: 'var(--surface2)',
            fontSize: '0.65rem', fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            whiteSpace: 'nowrap',
          }}
        >
          🔒 Read-only
        </span>
      </div>

      {!allPricesSet && (
        <div style={{
          padding: '10px 22px',
          fontSize: '0.75rem',
          color: 'var(--muted)',
          background: 'var(--surface2)',
          borderBottom: '1px solid var(--border)',
        }}>
          ⏳ Purchase prices pending — quantities will appear once official prices are recorded in <code>contest.config.json</code>.
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="holdings-table" style={{ fontSize: '0.78rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>#</th>
              <th style={{ textAlign: 'left' }}>AI</th>
              <th style={{ textAlign: 'left' }}>Asset</th>
              <th style={{ textAlign: 'left' }}>Symbol</th>
              <th style={{ textAlign: 'left' }}>Class</th>
              <th>Allocation</th>
              <th>Weight</th>
              <th>Purchase price</th>
              <th>Quantity</th>
            </tr>
          </thead>
          <tbody>
            {PORTFOLIOS.flatMap((portfolio, pi) =>
              portfolio.holdings.map((h, hi) => {
                const rowNum = pi * 5 + hi + 1;
                const startPrice = startPrices[h.apiSymbol] ?? null;
                const qty = startPrice !== null ? h.allocation / startPrice : null;

                return (
                  <tr key={`${portfolio.id}-${h.apiSymbol}`}>
                    <td style={{ color: 'var(--muted)', fontFamily: 'var(--num-font)', fontSize: '0.72rem' }}>
                      {rowNum}
                    </td>
                    <td style={{ fontFamily: 'inherit' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '2px 9px', borderRadius: 5,
                        background: portfolio.color + '18',
                        color: portfolio.color,
                        border: `1px solid ${portfolio.color}30`,
                        fontSize: '0.68rem', fontWeight: 600,
                      }}>
                        {portfolio.name}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'inherit', color: 'var(--text)', fontWeight: 600 }}>
                      {h.name}
                    </td>
                    <td style={{ fontFamily: 'inherit', color: 'var(--muted-mid)', fontWeight: 600, letterSpacing: '0.03em' }}>
                      {h.ticker}
                    </td>
                    <td>
                      <span className={`asset-class-badge ${h.assetClass}`}>{h.assetClass}</span>
                    </td>
                    <td>{fmtDollar(h.allocation)}</td>
                    <td>{(h.weight * 100).toFixed(0)}%</td>
                    <td>
                      {startPrice !== null ? (
                        <span title={startPriceMeta?.[h.apiSymbol]?.actualDatetime ?? undefined}
                          style={{ color: 'var(--text)', cursor: CRYPTO_SYMBOLS.has(h.apiSymbol) ? 'help' : undefined }}>
                          {fmtPrice(startPrice)}
                          {CRYPTO_SYMBOLS.has(h.apiSymbol) && (
                            <span style={{ fontSize: '0.6rem', color: 'var(--muted)', marginLeft: 4 }}>4PM ET</span>
                          )}
                        </span>
                      ) : <span className="neu">—</span>}
                    </td>
                    <td>
                      {qty !== null
                        ? <span style={{ color: 'var(--text)' }}>{fmtQty(qty)}</span>
                        : <span className="neu">—</span>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border-mid)' }}>
              <td colSpan={5} style={{ color: 'var(--muted)', fontFamily: 'inherit', paddingTop: 10 }}>
                Total — 3 portfolios × 5 positions = 15 purchases
              </td>
              <td style={{ fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--num-font)' }}>
                {fmtDollar(startingValue * PORTFOLIOS.length)}
              </td>
              <td style={{ color: 'var(--muted)' }}>100%</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{
        padding: '10px 22px',
        fontSize: '0.72rem',
        color: 'var(--muted)',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}>
        <span>No positions may be sold, replaced, added to, or rebalanced.</span>
        <span style={{ color: 'var(--border-mid)' }}>|</span>
        <span>US stocks &amp; SPY: official regular-session close.</span>
        <span style={{ color: 'var(--border-mid)' }}>|</span>
        <span>Crypto: nearest 1-min bar to 4:00 PM ET.</span>
        <span style={{ color: 'var(--border-mid)' }}>|</span>
        <span>Fractional shares throughout.</span>
      </div>
    </div>
  );
}
