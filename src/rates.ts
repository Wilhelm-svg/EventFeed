import { z } from 'zod';
import { j, newId, p, type Db } from './db.js';
import { ApiError, agentId, idempotencyKey, type Ctx, type OpResult } from './registry.js';
import { FieldError } from './schema.js';
import * as n from './normalize.js';
import { resolveOne } from './glossary.js';
import { loadRecord } from './records.js';

/** How long a rate stays valid, by where it was seen. Rates are observations, never bookable prices. */
const VALIDITY_HOURS = { live_quote: 24, property_website: 72, published_rates: 24 * 30 } as const;

export const rateInput = z.strictObject({
  agentId,
  idempotencyKey,
  propertyId: z.string(),
  stayStart: z.string(),
  stayEnd: z.string(),
  adults: z.number().int().min(1).max(20),
  childrenAges: z.array(z.number().int().min(0).max(17)).max(10).optional(),
  roomType: z.string().min(2).max(100).optional(),
  price: z.string().describe('Price text with currency as shown, e.g. "R4 200", "from ZAR 3,500"'),
  basis: z.string().describe('What the price covers, e.g. "per person sharing", "per room per night" (glossary domain rate-basis)'),
  mealPlan: z.string().optional().describe('e.g. "B&B", "full board" (glossary domain meal-plan)'),
  conditions: z.string().max(500).optional(),
  rateType: z.enum(['public', 'promotional', 'rack', 'contracted', 'net']),
  sourceType: z.enum(['live_quote', 'property_website', 'rate_sheet', 'published_rates']),
  statedValidUntil: z.string().optional().describe('Required for rate_sheet: the validity end date printed on the sheet'),
  evidence: z.strictObject({ snapshotId: z.string(), excerpt: z.string().min(3).max(500) }),
  dryRun: z.boolean().optional(),
});

export function submitRate(input: z.infer<typeof rateInput>, ctx: Ctx): OpResult {
  const { db } = ctx;
  const now = ctx.now();
  const prop = loadRecord(db, input.propertyId);
  if (!prop || prop.type !== 'property') throw new ApiError(404, 'PROPERTY_NOT_FOUND', `"${input.propertyId}" is not a property. Create the property with submit_findings (recordType "property") first.`, { nextActions: [{ tool: 'search_records', why: 'Find the property id', args: { location: 'Hermanus', type: 'property' } }] });
  if (input.rateType === 'contracted' || input.rateType === 'net') throw new ApiError(400, 'RATE_NOT_PUBLIC', 'Only public, promotional or published rack rates may be submitted. Contracted and net rates are confidential.');

  const problems: string[] = [];
  const get = <T>(label: string, f: () => T): T | undefined => { try { return f(); } catch (e) { if (e instanceof FieldError) { problems.push(`${label}: ${e.message}`); return undefined; } throw e; } };
  const start = get('stayStart', () => n.date(input.stayStart, now).value);
  const end = get('stayEnd', () => n.date(input.stayEnd, now).value);
  if (start && end && end <= start) problems.push('stayEnd must be after stayStart');
  const money = get('price', () => n.money(input.price));
  const basis = resolveOne(db, input.basis, 'rate-basis');
  if (!basis) problems.push(`basis: "${input.basis}" is not in the glossary (domain rate-basis). Use lookup_glossary with domain "rate-basis".`);
  const mealPlan = input.mealPlan ? resolveOne(db, input.mealPlan, 'meal-plan') : undefined;
  if (input.mealPlan && !mealPlan) problems.push(`mealPlan: "${input.mealPlan}" is not in the glossary (domain meal-plan).`);
  let validUntil: string | undefined;
  let validityBasis = `default for ${input.sourceType}`;
  if (input.sourceType === 'rate_sheet') {
    const v = input.statedValidUntil ? get('statedValidUntil', () => n.date(input.statedValidUntil, now).value) : undefined;
    if (!input.statedValidUntil) problems.push('statedValidUntil is required for rate_sheet: give the validity end date printed on the sheet');
    if (v) { validUntil = `${v}T23:59:59.000Z`; validityBasis = 'stated on the rate sheet'; }
  } else validUntil = new Date(now.getTime() + VALIDITY_HOURS[input.sourceType] * 3600000).toISOString();

  const snap = db.sql.prepare('SELECT finalUrl, text FROM snapshots WHERE id = ?').get(input.evidence.snapshotId) as any;
  if (!snap) problems.push(`evidence: snapshot "${input.evidence.snapshotId}" doesn't exist; call fetch_source first`);
  else if (!n.excerptKey(snap.text).includes(n.excerptKey(input.evidence.excerpt))) problems.push(`evidence: the excerpt is not in snapshot ${input.evidence.snapshotId}`);
  if (problems.length) throw new ApiError(400, 'RATE_INVALID', `The rate was not saved. Problems: ${problems.join('; ')}`, { problems, nextActions: [{ tool: 'get_instructions', why: 'See the rate format', args: { tool: 'submit_rate' } }] });
  if (validUntil! <= now.toISOString()) throw new ApiError(400, 'RATE_EXPIRED', `This rate's validity ended ${validUntil}. Only current rates can be submitted.`);

  const data = {
    snapshotId: input.evidence.snapshotId,
    stayStart: start, stayEnd: end, nights: Math.round((Date.parse(end!) - Date.parse(start!)) / 86400000),
    adults: input.adults, childrenAges: input.childrenAges ?? [], roomType: input.roomType ?? null,
    price: money, rawPrice: input.price, basis, mealPlan: mealPlan ?? null, conditions: input.conditions ?? null,
    rateType: input.rateType, sourceType: input.sourceType, source: snap.finalUrl, excerpt: input.evidence.excerpt, validityBasis,
  };
  const dedupeKey = j([input.propertyId, data.roomType, start, end, input.adults, data.childrenAges, money, basis, snap.finalUrl]);
  const dup = db.sql.prepare('SELECT id FROM rates WHERE dedupeKey = ? AND observedAt > ?').get(dedupeKey, new Date(now.getTime() - 3600000).toISOString()) as any;
  if (dup) return { result: { rateId: dup.id, duplicate: true }, summary: `Same rate already recorded within the last hour (${dup.id}). Nothing new saved.` };
  const id = newId('rat');
  const summary = `${input.dryRun ? 'Dry run, nothing saved. Would record' : 'Recorded'} ${id}: ${(money!.amountMinor / 100).toFixed(2)} ${money!.currency} ${basis}${mealPlan ? `, ${mealPlan}` : ''}, ${data.nights} night(s) from ${start}, valid until ${validUntil}.`;
  if (!input.dryRun) {
    db.sql.prepare('INSERT INTO rates VALUES (?,?,?,?,?,?,?,?)').run(id, input.propertyId, input.idempotencyKey, input.agentId, j(data), dedupeKey, now.toISOString(), validUntil);
    db.audit(input.agentId, 'submit_rate', 'rate', id, { propertyId: input.propertyId });
  }
  return {
    status: input.dryRun ? 200 : 201,
    result: { rateId: input.dryRun ? null : id, ...data, observedAt: now.toISOString(), validUntil },
    summary,
    warnings: ['A rate is an observation at a point in time, not a guaranteed or bookable price.'],
    nextActions: [{ tool: 'get_record', why: 'See the property with its current rates', args: { id: input.propertyId } }],
  };
}

/** Current (unexpired) rates for a property; expired ones only when asked, labelled as historical. */
export function ratesFor(db: Db, propertyId: string, now: Date, includeExpired: boolean) {
  const rows = (db.sql.prepare('SELECT id, data, observedAt, validUntil FROM rates WHERE propertyId = ? ORDER BY observedAt DESC').all(propertyId) as any[])
    .map((r) => ({ rateId: r.id, ...p(r.data), observedAt: r.observedAt, validUntil: r.validUntil }));
  const t = now.toISOString();
  return {
    currentRates: rows.filter((r) => r.validUntil > t),
    ...(includeExpired ? { historicalIndications: rows.filter((r) => r.validUntil <= t).map((r) => ({ ...r, note: 'Expired observation. Not a current price.' })) } : {}),
  };
}
