'use client';

const RULES = [
  'All three models received the exact same prompt.',
  'Each prompt was submitted in a new saved conversation.',
  'The first complete response became the official entry.',
  'No model saw another model\'s portfolio.',
  'Every portfolio began with $10,000.',
  'Fractional shares are used — quantities are exact.',
  'All official purchase prices use Friday, July 24, 2026: US stocks and SPY use the official regular-session closing price (4:00 PM ET); crypto positions (BTC, ETH, SOL) use the price at or nearest to 4:00 PM ET.',
  'No position can be sold, replaced, added to or rebalanced.',
  'Holdings remain fixed through December 31, 2026.',
  'The S&P 500 comparison uses SPY as a price-return proxy (dividends excluded).',
  'The experiment is paper traded and is not financial advice.',
];

const PROMPT = `There is a paper-trading investment contest running from the official purchase date through December 31, 2026.

You have exactly $10,000 to allocate across a maximum of five publicly traded stocks and/or cryptocurrencies. Fractional shares are allowed.

Rules:
- Your allocations must total exactly $10,000.
- You may choose stocks and cryptocurrencies only.
- No ETFs, mutual funds, options, leverage, short positions, or stablecoins.
- Every selected asset must be held through December 31, 2026.
- You may not sell, rebalance, replace, or add to any position after the portfolio is submitted.
- All contestants' portfolios will be entered using market prices from the same official purchase timestamp.
- The winner will be the portfolio with the highest total percentage return.
- Performance will also be compared against the S&P 500 over the same period.

Using current publicly available information, choose your final portfolio.

For each asset, provide:
1. Asset name and ticker or crypto symbol
2. Dollar allocation
3. Percentage allocation
4. Brief explanation of why you selected it
5. The primary risk to the investment

Submit one final portfolio only. Do not provide alternative portfolios or ask follow-up questions. Your first complete answer will become your permanent official entry and cannot be changed.`;

export function Methodology() {
  return (
    <div className="card">
      <details className="methodology-details">
        <summary className="methodology-summary">
          <span className="section-label" style={{ display: 'inline' }}>Methodology &amp; Prompt</span>
          <span className="methodology-chevron">▶</span>
        </summary>

        <div className="methodology-body">
          <div>
            <p className="methodology-section-title">How the contest works</p>
            <ul className="methodology-rules">
              {RULES.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>

          <div>
            <p className="methodology-section-title">The exact prompt used</p>
            <pre className="prompt-block">{PROMPT}</pre>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.65 }}>
            <strong>Benchmark note:</strong> The S&P 500 benchmark is tracked using SPY (SPDR S&P 500 ETF Trust)
            as a price-return proxy. SPY does not include dividend reinvestment.
            Past performance is not indicative of future results.
          </div>
        </div>
      </details>
    </div>
  );
}
