import * as chrono from 'chrono-node';
import { FieldError, type Money, type Temporal, type Weekday } from './schema.js';
import { DEFAULT_TIMEZONE, GAZETTEER } from './seed-data.js';

const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Comparison form for excerpts and page text: case, quotes, dashes and whitespace don't matter. */
export function excerptKey(s: string): string {
  return ws(
    s.toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u00a0/g, ' '),
  );
}

/** Lookup form for glossary terms and synonyms: "Kid-Friendly" and "kid friendly" are the same key. */
export function termKey(s: string): string {
  return ws(s.toLowerCase().replace(/[_\-/]+/g, ' ').replace(/[^a-z0-9& ]/g, ''));
}

/** Dedup key for record names: no case, accents, punctuation, years or the town name. */
export function matchKey(name: string, town: string): string {
  const t = town.toLowerCase();
  return ws(
    name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(19|20)\d\d\b/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ').filter((w) => w && w !== t && !t.split(' ').includes(w)).join(' '),
  );
}

/** Dice coefficient on character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => { const g: string[] = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; };
  const ga = grams(a), gb = grams(b);
  if (!ga.length || !gb.length) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of ga) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of gb) { const c = counts.get(g) ?? 0; if (c) { hits++; counts.set(g, c - 1); } }
  return (2 * hits) / (ga.length + gb.length);
}

export function text(raw: unknown, max = 2000): string {
  if (typeof raw !== 'string' || !ws(raw)) throw new FieldError('VALUE_INVALID', 'must be non-empty text');
  const v = ws(raw);
  if (v.length > max) throw new FieldError('VALUE_INVALID', `must be at most ${max} characters`);
  return v;
}

export function bool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 'yes') return true;
  if (raw === 'false' || raw === 'no') return false;
  throw new FieldError('VALUE_INVALID', 'must be true or false');
}

export function place(raw: unknown): { town: string; known: boolean; region?: string; country?: string; timezone: string } {
  const v = text(raw, 100);
  const g = GAZETTEER[v.toLowerCase()];
  if (g) return { ...g, known: true };
  return { town: v.replace(/\b\w/g, (c) => c.toUpperCase()), known: false, timezone: DEFAULT_TIMEZONE };
}

const pad = (n: number) => String(n).padStart(2, '0');
const realDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** One calendar day. Accepts ISO, "24 June 2027", "Sat 6 March 2027", and unambiguous numeric dates. */
export function date(raw: unknown, now: Date): { value: string; notes: string[] } {
  if (typeof raw !== 'string' || !raw.trim()) throw new FieldError('DATE_INVALID', 'must be a date such as "2027-06-24" or "24 June 2027"');
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = m.slice(1).map(Number);
    if (!realDate(y, mo, d)) throw new FieldError('DATE_INVALID', `"${s}" is not a real calendar date`);
    return { value: s, notes: [] };
  }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) {
    const [a, b, y] = m.slice(1).map(Number);
    if (a <= 12 && b <= 12 && a !== b) {
      throw new FieldError('DATE_AMBIGUOUS', `"${s}" could be ${a} ${MONTH_NAMES[b - 1]} or ${b} ${MONTH_NAMES[a - 1]}. Send an ISO date like "${y}-${pad(b)}-${pad(a)}" or write the month name.`);
    }
    const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    if (!realDate(y, mo, d)) throw new FieldError('DATE_INVALID', `"${s}" is not a real calendar date`);
    return { value: `${y}-${pad(mo)}-${pad(d)}`, notes: [`Read "${s}" as ${y}-${pad(mo)}-${pad(d)}`] };
  }
  const r = chrono.parse(s, now, { forwardDate: true })[0];
  if (!r || !r.start.isCertain('day') || !r.start.isCertain('month')) {
    throw new FieldError('DATE_INVALID', `couldn't read "${s}" as one specific day. Use "2027-06-24" or "24 June 2027".`);
  }
  const c = r.start;
  const value = `${c.get('year')}-${pad(c.get('month')!)}-${pad(c.get('day')!)}`;
  const notes = [`Read "${s}" as ${value}`];
  if (!c.isCertain('year')) notes.push(`No year was given, so I assumed ${c.get('year')}`);
  return { value, notes };
}

/** "7pm", "7:30 pm", "19h00", "19:00", "9am" → "HH:MM". */
export function time(raw: unknown): string {
  if (typeof raw !== 'string') throw new FieldError('TIME_INVALID', 'must be a time such as "19:00" or "7pm"');
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})(?:[:h.](\d{2}))?(am|pm)?$/);
  if (!m) throw new FieldError('TIME_INVALID', `couldn't read "${raw}" as a time. Use "19:00" or "7pm".`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) { if (h < 1 || h > 12) throw new FieldError('TIME_INVALID', `"${raw}" is not a real time`); h = (h % 12) + (m[3] === 'pm' ? 12 : 0); }
  else if (m[2] === undefined) throw new FieldError('TIME_INVALID', `"${raw}" needs minutes or am/pm, e.g. "19:00" or "7pm"`);
  if (h > 23 || min > 59) throw new FieldError('TIME_INVALID', `"${raw}" is not a real time`);
  return `${pad(h)}:${pad(min)}`;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function month(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 12) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
    const i = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(raw.trim().toLowerCase().slice(0, 3)));
    if (raw.trim().length >= 3 && i >= 0) return i + 1;
  }
  throw new FieldError('MONTH_INVALID', `"${raw}" is not a month. Use 1-12 or a month name.`);
}

const WEEKDAYS: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export function weekday(raw: unknown): Weekday {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const d = WEEKDAYS.find((w) => s.length >= 3 && w.startsWith(s.slice(0, 3)));
  if (!d) throw new FieldError('WEEKDAY_INVALID', `"${raw}" is not a day of the week`);
  return d;
}

const list = (raw: unknown) => (Array.isArray(raw) ? raw : raw === undefined ? undefined : [raw]);

/** Raw temporal object (lenient) → canonical Temporal. */
export function temporal(raw: unknown, now: Date, timezone: string): { value: Temporal; notes: string[] } {
  if (!raw || typeof raw !== 'object') throw new FieldError('TEMPORAL_INVALID', 'must be an object with type "dated", "seasonal" or "recurring" (see the example in get_instructions for submit_findings)');
  const r = raw as Record<string, any>;
  const notes: string[] = [];
  const optTime = (k: string) => (r[k] === undefined ? undefined : time(r[k]));
  if (r.type === 'dated') {
    const s = date(r.startDate, now); notes.push(...s.notes);
    const e = r.endDate === undefined ? undefined : date(r.endDate, now);
    if (e) notes.push(...e.notes);
    if (e && e.value < s.value) throw new FieldError('TEMPORAL_INVALID', `endDate ${e.value} is before startDate ${s.value}`);
    const value: Temporal = { type: 'dated', startDate: s.value, timezone };
    if (e && e.value !== s.value) value.endDate = e.value;
    const st = optTime('startTime'); if (st) { value.startTime = st; value.startUtc = toUtc(s.value, st, timezone); }
    const et = optTime('endTime'); if (et) value.endTime = et;
    return { value, notes };
  }
  if (r.type === 'seasonal') {
    const value: Temporal = { type: 'seasonal', startMonth: month(r.startMonth), endMonth: month(r.endMonth), timezone };
    const peaks = list(r.peakMonths); if (peaks) value.peakMonths = peaks.map(month);
    return { value, notes };
  }
  if (r.type === 'recurring') {
    if (r.frequency !== 'weekly' && r.frequency !== 'annual') throw new FieldError('TEMPORAL_INVALID', 'recurring needs frequency "weekly" or "annual"');
    const value: Temporal = { type: 'recurring', frequency: r.frequency, timezone };
    if (r.frequency === 'weekly') {
      const days = list(r.daysOfWeek);
      if (!days?.length) throw new FieldError('TEMPORAL_INVALID', 'weekly events need daysOfWeek, e.g. ["saturday"]');
      value.daysOfWeek = [...new Set(days.map(weekday))];
    } else {
      const months = list(r.months);
      if (!months?.length) throw new FieldError('TEMPORAL_INVALID', 'annual events need months, e.g. [9, 10]');
      value.months = [...new Set(months.map(month))].sort((a, b) => a - b);
      if (r.typicalDates !== undefined) value.typicalDates = text(r.typicalDates, 300);
    }
    const st = optTime('startTime'); if (st) value.startTime = st;
    const et = optTime('endTime'); if (et) value.endTime = et;
    return { value, notes };
  }
  throw new FieldError('TEMPORAL_INVALID', `temporal.type must be "dated", "seasonal" or "recurring", got ${JSON.stringify(r.type)}`);
}

/** Local date + time in a timezone → UTC ISO string. */
function toUtc(day: string, hhmm: string, timezone: string): string {
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(guess).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
  const mins = m ? (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - mins * 60000).toISOString();
}

const CURRENCIES: [RegExp, string][] = [[/\bZAR\b|\bR(?=\s?\d)/i, 'ZAR'], [/\bUSD\b|US\$|\$/i, 'USD'], [/\bEUR\b|€/i, 'EUR'], [/\bGBP\b|£/i, 'GBP']];

/** "R4 200", "ZAR 4,200.00", "from R150", "free" → Money. */
export function money(raw: unknown): Money {
  if (typeof raw === 'number') throw new FieldError('PRICE_INVALID', 'include the currency, e.g. "R150" or "ZAR 150"');
  if (typeof raw !== 'string' || !raw.trim()) throw new FieldError('PRICE_INVALID', 'must be a price such as "R150" or "from ZAR 4,200"');
  const s = raw.trim();
  if (/^free( entry| admission)?$/i.test(s)) return { amountMinor: 0, currency: 'NONE', qualifier: 'exact' };
  const currency = CURRENCIES.find(([re]) => re.test(s))?.[1] ?? s.match(/\b([A-Z]{3})\b/)?.[1];
  if (!currency) throw new FieldError('PRICE_INVALID', `no currency found in "${s}". Write it like "R150" or "ZAR 150".`);
  const n = s.match(/\d[\d\s,]*(\.\d{1,2})?/);
  if (!n) throw new FieldError('PRICE_INVALID', `no amount found in "${s}"`);
  const amount = Number(n[0].replace(/[\s,]/g, ''));
  if (!Number.isFinite(amount)) throw new FieldError('PRICE_INVALID', `couldn't read the amount in "${s}"`);
  return { amountMinor: Math.round(amount * 100), currency, qualifier: /\bfrom\b/i.test(s) ? 'from' : 'exact' };
}

const TRACKING = /^(utm_.*|fbclid|gclid|mc_eid|mc_cid|_ga)$/i;
/** Lowercase host, no tracking params, no fragment, no trailing slash. */
export function url(raw: unknown): string {
  if (typeof raw !== 'string') throw new FieldError('URL_INVALID', 'must be a full URL like "https://example.com/page"');
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new FieldError('URL_INVALID', `"${raw}" is not a full URL. Include https://`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FieldError('URL_INVALID', 'must start with http:// or https://');
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  const path = u.pathname.replace(/\/+$/, '');
  const qs = u.searchParams.toString();
  return `${u.protocol}//${u.host.toLowerCase()}${path}${qs ? `?${qs}` : ''}`;
}

export const domainOf = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
