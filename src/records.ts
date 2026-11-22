import { p, type Db } from './db.js';
import type { RecordType, Temporal } from './schema.js';
import { MONTHS, seasonMonths } from './match.js';
import { FIELDS } from './fields.js';

export type RecordRow = { id: string; type: RecordType; version: number; data: Record<string, any>; matchKey: string; town: string; createdAt: string; updatedAt: string };
export type ClaimRow = {
  id: string; recordId: string; submissionId: string; agentId: string; field: string; raw: unknown; canonical: unknown;
  snapshotId: string | null; excerpt: string | null; sourceUrl: string | null; tier: number; tierBasis: string; status: string; note: string | null; createdAt: string;
};

export const LIVE = ['accepted', 'provisional'];

export function loadRecord(db: Db, id: string): RecordRow | undefined {
  const r = db.sql.prepare('SELECT * FROM records WHERE id = ?').get(id) as any;
  return r ? { ...r, data: p(r.data) } : undefined;
}

export function claimsFor(db: Db, recordId: string): ClaimRow[] {
  return (db.sql.prepare('SELECT * FROM claims WHERE recordId = ? ORDER BY createdAt, rowid').all(recordId) as any[])
    .map((c) => ({ ...c, raw: p(c.raw), canonical: p(c.canonical) }));
}

/** The claim currently backing a field (latest live claim). */
export const liveClaim = (claims: ClaimRow[], field: string) => [...claims].reverse().find((c) => c.field === field && LIVE.includes(c.status));

const displayDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const months = (ms: number[]) => ms.map((m) => MONTHS[m - 1]).join(', ');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function whenText(t: Temporal | undefined, datesConfirmed?: boolean): string | null {
  if (!t) return null;
  let s: string;
  if (t.type === 'dated') {
    s = t.endDate ? `${displayDate(t.startDate)} to ${displayDate(t.endDate)}` : displayDate(t.startDate);
    if (t.startTime) s += `, from ${t.startTime}${t.endTime ? ` to ${t.endTime}` : ''}`;
  } else if (t.type === 'seasonal') {
    s = `${MONTHS[t.startMonth - 1]} to ${MONTHS[t.endMonth - 1]} each year (${seasonMonths(t.startMonth, t.endMonth).length} months)`;
    if (t.peakMonths?.length) s += `, peak ${months(t.peakMonths)}`;
  } else if (t.frequency === 'weekly') {
    s = `Every ${t.daysOfWeek!.map(cap).join(' and ')}`;
    if (t.startTime) s += `, ${t.startTime}${t.endTime ? `–${t.endTime}` : ''}`;
  } else {
    s = `Every year in ${months(t.months!)}`;
    if (t.typicalDates) s += `. ${t.typicalDates}`;
  }
  s += ` (local time, ${t.timezone})`;
  return datesConfirmed === false ? `${s}. Dates not yet confirmed.` : s;
}

/** Decision-ready = a planner can act on it. Returns what is still missing. */
export function quality(rec: RecordRow, claims: ClaimRow[]): { decisionReady: boolean; missingInformation: string[]; unreviewedFields: string[]; openConflicts: string[] } {
  const d = rec.data;
  const missing: string[] = [];
  const has = (f: string) => d[f] !== undefined;
  if (rec.type === 'event') {
    if (!has('temporal')) missing.push('dates');
    if (!has('datesConfirmed')) missing.push('whether the dates are confirmed');
    if (!has('venue')) missing.push('venue');
    if (!has('bookingUrl') && !has('officialUrl')) missing.push('official website or booking link');
    const tc = liveClaim(claims, 'temporal');
    if (tc && tc.tier > 2) missing.push('dates from an official or tourism-body source');
  } else {
    if (!has('officialUrl')) missing.push('official website');
    if (!has('bookingUrl')) missing.push('booking link');
    if (!has('childPolicy')) missing.push('children policy');
  }
  const unreviewedFields = [...new Set(claims.filter((c) => c.status === 'provisional').map((c) => c.field))];
  const openConflicts = [...new Set(claims.filter((c) => c.status === 'contradicting').map((c) => c.field))];
  const decisionReady = missing.length === 0 && unreviewedFields.length === 0 && openConflicts.length === 0;
  return { decisionReady, missingInformation: missing, unreviewedFields, openConflicts };
}

/** Optional fields with no value yet, so agents know what to research next. */
export const emptyFields = (rec: RecordRow) => Object.keys(FIELDS[rec.type]).filter((f) => rec.data[f] === undefined || (f === 'tags' && !rec.data.tags?.length));

export function present(db: Db, rec: RecordRow, detail: 'summary' | 'full', matchReasons: string[] = []) {
  const claims = claimsFor(db, rec.id);
  const q = quality(rec, claims);
  const d = rec.data;
  const summary = {
    id: rec.id,
    type: rec.type,
    version: rec.version,
    name: d.name,
    town: d.town,
    whenText: rec.type === 'event' ? whenText(d.temporal, d.datesConfirmed) : undefined,
    propertyType: d.propertyType,
    tags: d.tags ?? [],
    decisionReady: q.decisionReady,
    missingInformation: q.missingInformation,
    unreviewedFields: q.unreviewedFields,
    openConflicts: q.openConflicts,
    matchReasons,
  };
  if (detail === 'summary') return summary;
  const field = (f: string) => {
    const c = liveClaim(claims, f);
    if (c) return { source: c.sourceUrl, tier: c.tier, tierBasis: c.tierBasis, excerpt: c.excerpt, status: c.status, observedAt: c.createdAt };
    if (f === 'region' || f === 'country') return { derivedFrom: 'town', note: 'Filled in by the platform from its place list for the town.' };
    return null;
  };
  return {
    ...summary,
    data: d,
    provenance: Object.fromEntries(Object.keys(d).filter((f) => FIELDS[rec.type][f]).map((f) => [f, field(f)])),
    conflicts: claims.filter((c) => c.status === 'contradicting').map((c) => ({
      field: c.field, currentValue: d[c.field], otherValue: c.canonical, otherSource: c.sourceUrl, otherTier: c.tier, excerpt: c.excerpt,
    })),
    pendingChanges: claims.filter((c) => c.status === 'pending_review').map((c) => ({ field: c.field, proposedValue: c.canonical, source: c.sourceUrl, tier: c.tier })),
    fieldsNotYetResearched: emptyFields(rec),
    updatedAt: rec.updatedAt,
  };
}
