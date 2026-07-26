// NYSE market holiday dates (ISO YYYY-MM-DD, Eastern Time).
// Only dates from the contest start (2026-07-24) onward are needed.
const MARKET_HOLIDAYS = new Set([
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
  '2027-01-01', // New Year's Day
]);

/**
 * Returns true if `now` falls on a US stock market trading day
 * (Monday–Friday ET, excluding NYSE holidays).
 *
 * Crypto trades 24/7 — Wave 2 always runs regardless of this function.
 */
export function isMarketDay(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});

  const { weekday, year, month, day } = parts;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !MARKET_HOLIDAYS.has(`${year}-${month}-${day}`);
}
