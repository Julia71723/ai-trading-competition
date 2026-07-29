// NYSE market holiday dates (ISO YYYY-MM-DD, Eastern Time).
// Only dates from the contest start (2026-07-24) onward are needed.
const MARKET_HOLIDAYS = new Set([
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
  '2027-01-01', // New Year's Day
]);

// ── ET date / time helpers ────────────────────────────────────────────────────

const ET_DTF_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

const ET_DTF_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
});

function partsToObj(dtf: Intl.DateTimeFormat, d: Date): Record<string, string> {
  return dtf.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

/** Returns the current date in America/New_York as "YYYY-MM-DD". */
export function getEasternDateStr(now: Date = new Date()): string {
  const p = partsToObj(ET_DTF_DATE, now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Returns hour (0–23) and minute (0–59) in America/New_York. */
function getETHourMinute(now: Date): { hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const p = partsToObj(dtf, now);
  return { hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10) };
}

/**
 * Returns true if the current ET time is at or past 4:20 PM
 * (20 minutes after regular-session close — enough time for data to settle).
 */
export function isAfterMarketClose(now: Date = new Date()): boolean {
  const { hour, minute } = getETHourMinute(now);
  return hour > 16 || (hour === 16 && minute >= 20);
}

// ── Market day checks ─────────────────────────────────────────────────────────

/**
 * Returns true if `now` falls on a US stock market trading day
 * (Monday–Friday ET, excluding NYSE holidays).
 */
export function isMarketDay(now: Date = new Date()): boolean {
  const { weekday, year, month, day } = partsToObj(ET_DTF_PARTS, now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !MARKET_HOLIDAYS.has(`${year}-${month}-${day}`);
}

/**
 * Returns the YYYY-MM-DD of the most recent completed market session
 * (i.e. a market day whose 4:20 PM ET has already passed).
 *
 * Returns null if the contest hasn't started or no market day can be found
 * within 14 calendar days.
 */
export function getLatestCompletedMarketDate(now: Date = new Date()): string | null {
  const candidate = new Date(now.getTime());

  for (let i = 0; i < 14; i++) {
    if (isMarketDay(candidate)) {
      if (i === 0) {
        // Today: only counts if close has passed
        if (isAfterMarketClose(now)) return getEasternDateStr(now);
      } else {
        // Past market day — close has definitely passed
        return getEasternDateStr(candidate);
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return null;
}
