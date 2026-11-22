import { describe, it, expect, beforeEach } from 'vitest';
import { setup, snapshot, ev, NOW } from './helpers';

let ctx: ReturnType<typeof setup>;
let snp: string;
let propertyId: string;
const rate = (over: object = {}) => ({
  agentId: 'agent-alpha', idempotencyKey: 'r1', propertyId, stayStart: '14 August 2027', stayEnd: '16 August 2027', adults: 2,
  price: 'R4 200', basis: 'per person sharing', mealPlan: 'B&B', rateType: 'public', sourceType: 'property_website',
  evidence: ev(snp, 'R4 200 per person sharing'), ...over,
});

beforeEach(async () => {
  ctx = setup();
  snp = await snapshot(ctx.call, 'https://lodge.example.co.za/');
  const r = await ctx.call('submit_findings', { agentId: 'agent-alpha', idempotencyKey: 'p1', recordType: 'property', claims: [
    { field: 'name', value: 'Walker Bay Lodge', evidence: ev(snp, 'Walker Bay Lodge') },
    { field: 'town', value: 'Hermanus', evidence: ev(snp, 'in Hermanus') },
    { field: 'propertyType', value: 'guest house', evidence: ev(snp, 'luxury guest house') },
  ] });
  propertyId = r.result.recordId;
});

describe('submit_rate', () => {
  it('normalises price, basis and meal plan through the glossary and sets an expiry', async () => {
    const r = await ctx.call('submit_rate', rate());
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ price: { amountMinor: 420000, currency: 'ZAR', qualifier: 'exact' }, basis: 'per-person-night', mealPlan: 'breakfast', nights: 2 });
    expect(r.result.validUntil).toBe(new Date(NOW.getTime() + 72 * 3600000).toISOString());
    const rec = await ctx.call('get_record', { id: propertyId });
    expect(rec.result.currentRates).toHaveLength(1);
    const again = await ctx.call('submit_rate', rate({ idempotencyKey: 'r2' }));
    expect(again.result.duplicate).toBe(true);
  });

  it('uses the stated validity for rate sheets and hides expired rates unless asked', async () => {
    const r = await ctx.call('submit_rate', rate({ sourceType: 'rate_sheet', statedValidUntil: '30 September 2027' }));
    expect(r.result.validityBasis).toBe('stated on the rate sheet');
    // Seen long ago: insert an already-expired observation directly.
    ctx.db.sql.prepare("INSERT INTO rates VALUES ('rat_old', ?, 'x', 'agent-alpha', '{}', 'old', '2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z')").run(propertyId);
    const plain = await ctx.call('get_record', { id: propertyId });
    expect(plain.result.currentRates.map((x: any) => x.rateId)).not.toContain('rat_old');
    expect(plain.result.historicalIndications).toBeUndefined();
    const all = await ctx.call('get_record', { id: propertyId, includeExpired: true });
    expect(all.result.historicalIndications[0].rateId).toBe('rat_old');
  });

  it('refuses confidential rates, bad values, fake evidence and unknown properties', async () => {
    expect((await ctx.call('submit_rate', rate({ rateType: 'net' }))).error.code).toBe('RATE_NOT_PUBLIC');
    const bad = await ctx.call('submit_rate', rate({ stayEnd: '13 August 2027', basis: 'per goat', evidence: ev(snp, 'R9 999 per night') }));
    expect(bad.error.code).toBe('RATE_INVALID');
    expect(bad.error.problems).toHaveLength(3);
    expect((await ctx.call('submit_rate', rate({ sourceType: 'rate_sheet' }))).error.problems[0]).toMatch(/statedValidUntil is required/);
    expect((await ctx.call('submit_rate', rate({ propertyId: 'prp_nope' }))).error.code).toBe('PROPERTY_NOT_FOUND');
  });
});
