import type { Db } from './db.js';
import { FieldError, type RecordType } from './schema.js';
import * as n from './normalize.js';
import { resolveOne } from './glossary.js';

export type FieldCtx = { db: Db; now: Date; timezone: string };
export type Normalized = { value: unknown; notes?: string[] };
export type FieldDef = {
  /** Decision-critical: first value is provisional until reviewed, later changes wait for review. */
  critical?: boolean;
  /** Evidence (snapshotId + excerpt) required. Default true. */
  evidence?: boolean;
  /** Field is merged (union) instead of replaced. */
  merge?: boolean;
  help: string;
  normalize: (raw: unknown, c: FieldCtx) => Normalized;
};

const v = (f: (raw: unknown) => unknown) => (raw: unknown): Normalized => ({ value: f(raw) });
const oneOf = (allowed: string[]) => (raw: unknown): Normalized => {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!allowed.includes(s)) throw new FieldError('VALUE_INVALID', `must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
  return { value: s };
};

const tags: FieldDef = {
  evidence: false,
  merge: true,
  help: 'List of interest tags, e.g. ["family friendly", "music"]. Mapped to glossary terms (domain "interest"); unknown words are kept as unmappedTags.',
  normalize(raw, c) {
    const words = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null);
    if (!words || !words.every((w) => typeof w === 'string')) throw new FieldError('VALUE_INVALID', 'must be a list of words, e.g. ["music", "family friendly"]');
    const mapped = new Set<string>();
    const unmapped = new Set<string>();
    for (const w of words.map((x) => x.trim()).filter(Boolean)) {
      const term = resolveOne(c.db, w, 'interest');
      term ? mapped.add(term) : unmapped.add(w.toLowerCase());
    }
    return { value: { tags: [...mapped].sort(), unmappedTags: [...unmapped].sort() } };
  },
};

const shared: Record<string, FieldDef> = {
  name: { help: 'Official name, e.g. "Hermanus FynArts Festival 2027".', normalize: v((r) => n.text(r, 200)) },
  description: { help: 'One to three sentences, supported by the excerpt.', normalize: v((r) => n.text(r, 2000)) },
  town: {
    help: 'Town name, e.g. "Hermanus". Region and country are filled in for known towns.',
    normalize(raw) {
      const pl = n.place(raw);
      return { value: pl.town, notes: pl.known ? [] : [`"${pl.town}" is not in the place list yet; stored as given`] };
    },
  },
  region: { help: 'Province or region, e.g. "Western Cape".', normalize: v((r) => n.text(r, 100)) },
  country: { help: 'Country, e.g. "South Africa".', normalize: v((r) => n.text(r, 100)) },
  address: { help: 'Street address.', normalize: v((r) => n.text(r, 300)) },
  officialUrl: { help: 'The official website for this event or property.', normalize: v(n.url) },
  bookingUrl: { critical: true, help: 'Where travellers book or buy tickets (official site or booking engine).', normalize: v(n.url) },
  tags,
};

export const FIELDS: Record<RecordType, Record<string, FieldDef>> = {
  event: {
    ...shared,
    venue: { help: 'Venue name, e.g. "Hermanus Cricket Club".', normalize: v((r) => n.text(r, 200)) },
    temporal: {
      critical: true,
      help: 'When it happens. One of: {"type":"dated","startDate":"24 June 2027","endDate":"4 July 2027","startTime":"19:00"} | {"type":"seasonal","startMonth":"June","endMonth":"November","peakMonths":[9,10]} | {"type":"recurring","frequency":"weekly","daysOfWeek":["saturday"],"startTime":"9am","endTime":"2pm"} | {"type":"recurring","frequency":"annual","months":[9,10],"typicalDates":"late September or early October"}.',
      normalize: (raw, c) => n.temporal(raw, c.now, c.timezone),
    },
    datesConfirmed: { evidence: false, help: 'true if the organiser has published firm dates, false if dates are expected or typical.', normalize: v(n.bool) },
    ticketPrice: { critical: true, help: 'Price text with currency, e.g. "R150", "from R350", "free".', normalize: v(n.money) },
    status: { critical: true, help: 'One of "scheduled", "postponed", "cancelled", "ended".', normalize: oneOf(['scheduled', 'postponed', 'cancelled', 'ended']) },
    whatToExpect: { help: 'Caveats travellers must know, e.g. "sightings are not guaranteed".', normalize: v((r) => n.text(r, 1000)) },
  },
  property: {
    ...shared,
    propertyType: {
      help: 'Kind of accommodation, mapped through the glossary (domain "property-type"), e.g. "lodge", "guest house", "B&B".',
      normalize(raw, c) {
        const term = typeof raw === 'string' ? resolveOne(c.db, raw, 'property-type') : null;
        if (!term) throw new FieldError('NOT_IN_GLOSSARY', `"${raw}" is not a known property type. Use lookup_glossary with domain "property-type", or propose it with propose_glossary_change.`);
        return { value: term };
      },
    },
    childPolicy: { critical: true, help: 'The property\'s rule on children, e.g. "Children aged 12 and older welcome."', normalize: v((r) => n.text(r, 500)) },
    status: { critical: true, help: 'One of "open", "closed".', normalize: oneOf(['open', 'closed']) },
  },
};

export const CORE: Record<RecordType, string[]> = { event: ['name', 'town', 'temporal'], property: ['name', 'town', 'propertyType'] };
