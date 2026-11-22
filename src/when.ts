import * as chrono from 'chrono-node';

export type DateRange = { start: string; end: string }; // inclusive, YYYY-MM-DD
export type WhenResult =
  | { ok: true; range: DateRange; assumptions: string[] }
  | { ok: false; message: string; suggestions: string[] };

const EXAMPLES = ['August 2027', '2027-08-15', 'this Saturday', 'next week', '1 June 2027 to 15 June 2027', 'December 2026 to February 2027'];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (d: Date) => ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Turns one chrono date component into a range: a whole month if no day was given, else a single day.
// A weekday ("this Saturday") pins a day even though chrono marks the day itself as implied.
function componentRange(c: chrono.ParsedComponents): DateRange {
  const y = c.get('year')!;
  const m = c.get('month')!;
  if (c.isCertain('day') || c.isCertain('weekday')) {
    const d = ymd(y, m, c.get('day')!);
    return { start: d, end: d };
  }
  return { start: ymd(y, m, 1), end: ymd(y, m, lastDay(y, m)) };
}

/** Weeks, weekends and whole years, which chrono turns into a single day or month. */
function relativeRange(text: string, now: Date): DateRange | null {
  const t = text.trim().toLowerCase();
  const year = t.match(/^(\d{4})$/)?.[1] ?? (t === 'this year' ? String(now.getFullYear()) : t === 'next year' ? String(now.getFullYear() + 1) : null);
  if (year) return { start: `${year}-01-01`, end: `${year}-12-31` };

  const m = t.match(/^(this|next)\s+(week|weekend)$/);
  if (!m) return null;
  const monday = addDays(now, -((now.getDay() + 6) % 7) + (m[1] === 'next' ? 7 : 0));
  return m[2] === 'week'
    ? { start: iso(monday), end: iso(addDays(monday, 6)) }
    : { start: iso(addDays(monday, 5)), end: iso(addDays(monday, 6)) };
}

/** Parses natural-language `when` text. `now` is injected so results are predictable in tests. */
export function parseWhen(text: string, now: Date): WhenResult {
  const season = text.match(/\b(summer|winter|autumn|fall|spring)\b/i);
  if (season) {
    return {
      ok: false,
      message: `"${text}" uses a season, which is ambiguous here. Hermanus is in the southern hemisphere, where summer is December to February and winter is June to August. Please give months instead.`,
      suggestions: ['December 2026 to February 2027', 'June 2027 to August 2027', 'August 2027'],
    };
  }

  const done = (range: DateRange, assumptions: string[]): WhenResult => ({
    ok: true,
    range,
    assumptions: [...assumptions, `Interpreted "${text}" as ${range.start} to ${range.end}.`],
  });

  const rel = relativeRange(text, now);
  if (rel) return done(rel, []);

  const results = chrono.parse(text, now, { forwardDate: true });
  if (results.length === 0) {
    const looksLikeDate = /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
    return {
      ok: false,
      message: looksLikeDate
        ? `"${text}" is not a real calendar date.`
        : `I couldn't understand the date "${text}". Use a month and year, a specific date, or a range.`,
      suggestions: EXAMPLES,
    };
  }

  const r = results[0];
  // chrono already puts reversed ranges in order; the "Interpreted ..." note makes that visible.
  const start = componentRange(r.start);
  const end = r.end ? componentRange(r.end) : start;
  const assumptions: string[] = [];
  if (!r.start.isCertain('year') && r.start.isCertain('month')) {
    assumptions.push(`No year was given, so I assumed the next upcoming one: ${start.start.slice(0, 4)}.`);
  }
  if (!r.start.isCertain('day') && !r.start.isCertain('weekday') && !r.start.isCertain('month')) {
    assumptions.push('This is a relative date, so I searched the whole month it falls in.');
  }
  return done({ start: start.start, end: end.end }, assumptions);
}
