#!/usr/bin/env python3
"""
LEGACY — superseded by the Next.js API routes (app/api/market-data and
app/api/market-history), which fetch prices server-side via Twelve Data
on every request with CDN caching.

This script was used during the original static-site phase and is kept
only for historical reference. It should not be run against the current
project.

Original description:
Reads portfolios.json, fetches current prices via yfinance,
computes total portfolio values, appends to history.json.
Skips gracefully if market is closed or no new data.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

ROOT = Path(__file__).parent.parent
PORTFOLIOS_FILE = ROOT / "data" / "portfolios.json"
HISTORY_FILE = ROOT / "data" / "history.json"


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def get_prices(tickers: list[str]) -> dict[str, float]:
    if not tickers:
        return {}
    data = yf.download(tickers, period="2d", interval="1d", progress=False, auto_adjust=True)
    prices = {}
    if data.empty:
        return prices
    close = data["Close"] if len(tickers) > 1 else data[["Close"]]
    latest = close.iloc[-1]
    for ticker in tickers:
        try:
            val = latest[ticker] if len(tickers) > 1 else latest.iloc[0]
            if val and not (val != val):  # skip NaN
                prices[ticker] = float(val)
        except (KeyError, IndexError):
            pass
    return prices


def compute_portfolio_value(portfolio: dict, prices: dict[str, float]) -> float | None:
    total = portfolio.get("cash", 0)
    for holding in portfolio.get("holdings", []):
        ticker = holding["ticker"]
        shares = holding["shares"]
        price = prices.get(ticker)
        if price is None:
            print(f"  Warning: no price for {ticker}, skipping portfolio")
            return None
        total += shares * price
    return total


def spy_equivalent(starting_cash: float, spy_price_then: float, spy_price_now: float) -> float:
    shares = starting_cash / spy_price_then
    return shares * spy_price_now


def last_timestamp(history: dict) -> str | None:
    entries = history.get("entries", [])
    if not entries:
        return None
    return entries[-1].get("timestamp")


def main():
    portfolios = load_json(PORTFOLIOS_FILE)
    history = load_json(HISTORY_FILE)

    # Collect all tickers across all portfolios + SPY
    all_tickers = {"SPY"}
    for p in portfolios.values():
        for h in p.get("holdings", []):
            all_tickers.add(h["ticker"])

    tickers_list = sorted(all_tickers)
    print(f"Fetching prices for: {', '.join(tickers_list)}")
    prices = get_prices(tickers_list)

    if not prices:
        print("No price data returned — market may be closed or network error. Skipping.")
        sys.exit(0)

    if "SPY" not in prices:
        print("SPY price unavailable. Skipping.")
        sys.exit(0)

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Avoid duplicate entries within the same minute
    last_ts = last_timestamp(history)
    if last_ts and last_ts[:16] == now_iso[:16]:
        print(f"Already have an entry for {now_iso[:16]}, skipping duplicate.")
        sys.exit(0)

    entry = {"timestamp": now_iso, "spy": round(prices["SPY"], 4)}

    for key, portfolio in portfolios.items():
        value = compute_portfolio_value(portfolio, prices)
        if value is None:
            print(f"Skipping entry — missing price for {key} portfolio.")
            sys.exit(0)
        entry[key] = round(value, 4)
        print(f"  {portfolio['name']}: ${value:,.2f}")

    print(f"  SPY price: ${prices['SPY']:.2f}")

    history.setdefault("entries", []).append(entry)

    # Store SPY start price on first entry so we can compute SPY % return
    if len(history["entries"]) == 1:
        history["spy_start"] = round(prices["SPY"], 4)

    save_json(HISTORY_FILE, history)
    print(f"Appended entry for {now_iso}")


if __name__ == "__main__":
    main()
