import type { Temporal } from './schema.js';
import type { DateRange } from './when.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);

/** Months (1-12) touched by the range, at most 12. */
function rangeMonths(r: DateRange): Set<number> {
  const out = new Set<number>();
  let [y, m] = r.start.split('-').map(Number);
  const [ey, em] = r.end.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.size < 12) {
    out.add(m);
    m === 12 ? ((m = 1), y++) : m++;
  }
  return out;
}

/** Months covered by a season, including seasons that wrap past December. */
export function seasonMonths(start: number, end: number): number[] {
  const out: number[] = [];
  for (let m = start; ; m = (m % 12) + 1) {
    out.push(m);
    if (m === end) return out;
  }
}

/** Returns why the event falls in the range, or null if it doesn't. */
export function matchWhen(t: Temporal, r: DateRange): string | null {
  if (t.type === 'dated') {
    const end = t.endDate ?? t.startDate;
    return t.startDate <= r.end && end >= r.start ? `Takes place within your dates (${t.startDate}${t.endDate ? ` to ${t.endDate}` : ''})` : null;
  }

  const months = rangeMonths(r);
  if (t.type === 'seasonal' || t.frequency === 'annual') {
    const eventMonths = t.type === 'seasonal' ? seasonMonths(t.startMonth, t.endMonth) : t.months!;
    const hit = eventMonths.filter((m) => months.has(m));
    if (!hit.length) return null;
    const names = hit.map((m) => MONTHS[m - 1]).join(', ');
    return t.type === 'seasonal'
      ? `In season every year in ${names}, which overlaps your dates`
      : `Held every year at some point in ${eventMonths.map((m) => MONTHS[m - 1]).join(' or ')}; your dates include ${names}, but may not cover the actual festival days. Check whenText.`;
  }

  // weekly: list the matching dates inside the range
  const dates: string[] = [];
  for (let d = toUtc(r.start); d <= toUtc(r.end); d.setUTCDate(d.getUTCDate() + 1)) {
    if (t.daysOfWeek!.includes(WEEKDAYS[d.getUTCDay()] as any)) dates.push(d.toISOString().slice(0, 10));
  }
  if (!dates.length) return null;
  const shown = dates.slice(0, 5).join(', ') + (dates.length > 5 ? ', ...' : '');
  return `Happens every ${t.daysOfWeek!.join(' and ')}: ${dates.length} date(s) fall within your dates (${shown})`;
}
