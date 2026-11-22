import { describe, it, expect, beforeEach } from 'vitest';
import { setup, snapshot, ev } from './helpers';

let call: Awaited<ReturnType<typeof setup>>['call'];
let db: Awaited<ReturnType<typeof setup>>['db'];
let fyn: string;
const A = 'agent-alpha';
const B = 'agent-beta';

const fynarts = (snp: string, key = 'k1', extra: any[] = []) => ({
  agentId: A, idempotencyKey: key, recordType: 'event',
  claims: [
    { field: 'name', value: 'Hermanus FynArts Festival 2027', evidence: ev(snp, 'Hermanus FynArts Festival') },
    { field: 'town', value: 'hermanus', evidence: ev(snp, 'Hermanus FynArts') },
    { field: 'temporal', value: { type: 'dated', startDate: '24 June 2027', endDate: '4 July 2027' }, evidence: ev(snp, '24 June 2027 - 4 July 2027') },
    { field: 'datesConfirmed', value: true },
    { field: 'tags', value: ['Arts', 'kid friendly', 'jazz'] },
    ...extra,
  ],
});

beforeEach(async () => {
  ({ call, db } = setup());
  fyn = await snapshot(call, 'https://www.hermanusfynarts.co.za/');
});

describe('fetch_source', () => {
  it('stores a snapshot, strips scripts and tags, and finds text', async () => {
    const r = await call('fetch_source', { url: 'https://www.hermanusfynarts.co.za/', find: '24 June 2027' });
    expect(r.ok).toBe(true);
    expect(r.result.snapshotId).toBe(fyn); // same URL + same content = same snapshot
    expect(r.result.text).not.toMatch(/ignore me/);
    expect(r.result.text).toMatch(/FynArts Festival: 24 June 2027 – 4 July 2027/);
    expect(r.result.matches).toHaveLength(1);
  });

  it('follows redirects, recording the final URL', async () => {
    const r = await call('fetch_source', { url: 'https://old.example.org/moved' });
    expect(r.result.finalUrl).toBe('https://www.hermanusfynarts.co.za/');
  });

  it.each([
    ['http://127.0.0.1/', 'URL_NOT_ALLOWED'],
    ['http://localhost:3000/api', 'URL_NOT_ALLOWED'],
    ['https://evil.example.org/redirect', 'URL_NOT_ALLOWED'],
    ['https://big.example.org/', 'SOURCE_TOO_LARGE'],
    ['https://pdf.example.org/brochure.pdf', 'SOURCE_TYPE_UNSUPPORTED'],
    ['https://nowhere.test/', 'HOST_NOT_FOUND'],
    ['ftp://example.org/file', 'URL_INVALID'],
  ])('rejects %s with %s', async (url, code) => {
    const r = await call('fetch_source', { url });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(code);
  });
});

describe('submit_findings: upload', () => {
  it('creates a record: normalises, maps tags via glossary, marks critical fields provisional', async () => {
    const r = await call('submit_findings', fynarts(fyn));
    expect(r.ok).toBe(true);
    expect(r.result.created).toBe(true);
    const byField = Object.fromEntries(r.result.claims.map((c: any) => [c.field, c]));
    expect(byField.town.value).toBe('Hermanus');
    expect(byField.temporal.value).toMatchObject({ type: 'dated', startDate: '2027-06-24', endDate: '2027-07-04', timezone: 'Africa/Johannesburg' });
    expect(byField.temporal.status).toBe('provisional');
    expect(byField.temporal.tier).toBe(1);
    expect(byField.name.status).toBe('accepted');
    expect(r.result.record.tags).toEqual(['arts', 'family-friendly']);
    expect(r.result.unmappedTags).toEqual(['jazz']);
    expect(r.result.decisionReady).toBe(false);
    expect(r.result.unreviewedFields).toEqual(['temporal']);
    expect(r.nextActions.map((a: any) => a.tool)).toEqual(expect.arrayContaining(['get_record', 'lookup_glossary', 'list_pending_reviews']));
  });

  it('get_record returns data with the source behind every field', async () => {
    const { result } = await call('submit_findings', fynarts(fyn));
    const r = await call('get_record', { id: result.recordId });
    expect(r.result.data.region).toBe('Western Cape');
    expect(r.result.provenance.temporal).toMatchObject({ source: 'https://www.hermanusfynarts.co.za/', tier: 1, status: 'provisional' });
    expect(r.result.fieldsNotYetResearched).toEqual(expect.arrayContaining(['venue', 'bookingUrl']));
  });

  it('rejects bad claims individually and keeps the good ones', async () => {
    const r = await call('submit_findings', fynarts(fyn, 'k1', [
      { field: 'venue', value: 'Old Harbour', evidence: ev(fyn, 'this text is not on the page') },
      { field: 'ticketPrice', value: 'R150' },
      { field: 'colour', value: 'blue', evidence: ev(fyn, 'FynArts') },
      { field: 'officialUrl', value: 'not a url', evidence: ev(fyn, 'FynArts') },
      { field: 'whatToExpect', value: 'Music', evidence: ev('snp_doesnotexist', 'FynArts') },
    ]));
    expect(r.ok).toBe(true);
    const codes = r.result.claims.filter((c: any) => c.status === 'rejected').map((c: any) => c.code);
    expect(codes).toEqual(['EVIDENCE_EXCERPT_NOT_FOUND', 'EVIDENCE_REQUIRED', 'UNKNOWN_FIELD', 'URL_INVALID', 'SNAPSHOT_NOT_FOUND']);
    expect(r.result.claims.filter((c: any) => c.status !== 'rejected')).toHaveLength(5);
  });

  it('rejects an excerpt that is on the page but does not state the value', async () => {
    const r = await call('submit_findings', fynarts(fyn, 'k1', [
      { field: 'ticketPrice', value: 'R999', evidence: ev(fyn, 'FynArts Festival') },
    ]));
    const price = r.result.claims.find((c: any) => c.field === 'ticketPrice');
    expect(price.code).toBe('EVIDENCE_DOES_NOT_SUPPORT');
    const dates = await call('submit_findings', { ...fynarts(fyn, 'k2'), claims: fynarts(fyn).claims.map((c: any) => c.field === 'temporal' ? { ...c, evidence: ev(fyn, '24 June 2027') } : c) });
    expect(dates.error.problems.join(' ')).toMatch(/day number\(s\) 4/);
  });

  it('fresh=true downloads the page again instead of reusing the recent copy', async () => {
    const cached = await call('fetch_source', { url: 'https://www.hermanusfynarts.co.za/' });
    expect(cached.summary).toMatch(/reused/);
    const fresh = await call('fetch_source', { url: 'https://www.hermanusfynarts.co.za/', fresh: true });
    expect(fresh.summary).not.toMatch(/reused/);
  });

  it('refuses a new record without its core fields and saves nothing', async () => {
    const r = await call('submit_findings', { agentId: A, idempotencyKey: 'x', recordType: 'event', claims: [{ field: 'name', value: 'Something', evidence: ev(fyn, 'FynArts') }] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('CORE_FIELDS_MISSING');
    expect(db.sql.prepare('SELECT COUNT(*) n FROM records').get()).toEqual({ n: 0 });
  });

  it('rejects ambiguous and impossible dates with a fix', async () => {
    const amb = await call('submit_findings', { ...fynarts(fyn), claims: fynarts(fyn).claims.map((c: any) => c.field === 'temporal' ? { ...c, value: { type: 'dated', startDate: '03/04/2027' } } : c) });
    expect(amb.error.code).toBe('CORE_FIELDS_MISSING');
    expect(amb.error.problems.join(' ')).toMatch(/could be 3 April or 4 March/);
    const bad = await call('submit_findings', { ...fynarts(fyn, 'k2'), claims: fynarts(fyn).claims.map((c: any) => c.field === 'temporal' ? { ...c, value: { type: 'dated', startDate: '2027-02-30' } } : c) });
    expect(bad.error.problems.join(' ')).toMatch(/not a real calendar date/);
  });

  it('dryRun runs the whole pipeline but saves nothing', async () => {
    const r = await call('submit_findings', { ...fynarts(fyn), dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/^Dry run, nothing saved/);
    expect(db.sql.prepare('SELECT COUNT(*) n FROM records').get()).toEqual({ n: 0 });
    expect(db.sql.prepare('SELECT COUNT(*) n FROM submissions').get()).toEqual({ n: 0 });
  });

  it('is safe to retry with the same idempotencyKey, and refuses the key for different content', async () => {
    const first = await call('submit_findings', fynarts(fyn));
    const again = await call('submit_findings', fynarts(fyn));
    expect(again.result.recordId).toBe(first.result.recordId);
    expect(again.warnings.join(' ')).toMatch(/Replayed/);
    expect(db.sql.prepare('SELECT COUNT(*) n FROM claims').get()).toEqual({ n: 5 });
    const reused = await call('submit_findings', { ...fynarts(fyn), recordType: 'event', claims: fynarts(fyn).claims.slice(0, 3) });
    expect(reused.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('gives a validExample when the input shape is wrong', async () => {
    const r = await call('submit_findings', { agentId: A, recordType: 'event', claims: [] });
    expect(r.error.code).toBe('INPUT_INVALID');
    expect(r.error.problems).toEqual(expect.arrayContaining(['idempotencyKey is required', 'claims needs at least 1 item(s)']));
    expect(r.error.validExample.claims.length).toBeGreaterThan(0);
  });
});

describe('submit_findings: deduplication', () => {
  it('merges an exact duplicate into the existing record', async () => {
    const first = await call('submit_findings', fynarts(fyn));
    const r = await call('submit_findings', { ...fynarts(fyn, 'k2'), agentId: B });
    expect(r.result.mergedInto).toBe(first.result.recordId);
    expect(r.result.claims.find((c: any) => c.field === 'name').status).toBe('corroborating');
    expect(db.sql.prepare('SELECT COUNT(*) n FROM records').get()).toEqual({ n: 1 });
  });

  it('asks the agent to choose when a similar record exists, then honours the choice', async () => {
    const first = await call('submit_findings', fynarts(fyn));
    const lst = await snapshot(call, 'https://www.sa-venues.com/events/fynarts');
    const similar = {
      agentId: B, idempotencyKey: 'b1', recordType: 'event',
      claims: [
        { field: 'name', value: 'FynArts Festival', evidence: ev(lst, 'Hermanus FynArts Festival') },
        { field: 'town', value: 'Hermanus', evidence: ev(lst, 'in Hermanus') },
        { field: 'temporal', value: { type: 'dated', startDate: '23 June 2027', endDate: '4 July 2027' }, evidence: ev(lst, '23 June 2027 to 4 July 2027') },
      ],
    };
    const r = await call('submit_findings', similar);
    expect(r.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(r.result.candidates[0].id).toBe(first.result.recordId);
    const asUpdate = await call('submit_findings', { ...similar, idempotencyKey: 'b2', recordId: first.result.recordId });
    expect(asUpdate.result.recordId).toBe(first.result.recordId);
    const asNew = await call('submit_findings', { ...similar, idempotencyKey: 'b3', distinctFrom: [first.result.recordId] });
    expect(asNew.result.created).toBe(true);
  });
});

describe('submit_findings: updates and conflicts', () => {
  let id: string;
  beforeEach(async () => {
    id = (await call('submit_findings', fynarts(fyn))).result.recordId;
  });

  it('a weaker source that disagrees becomes an open conflict; the current value stays', async () => {
    const lst = await snapshot(call, 'https://www.sa-venues.com/events/fynarts');
    const r = await call('submit_findings', { agentId: B, idempotencyKey: 'c1', recordType: 'event', recordId: id, claims: [
      { field: 'temporal', value: { type: 'dated', startDate: '23 June 2027', endDate: '4 July 2027' }, evidence: ev(lst, '23 June 2027 to 4 July 2027') },
    ] });
    expect(r.result.claims[0].status).toBe('contradicting');
    const rec = await call('get_record', { id });
    expect(rec.result.data.temporal.startDate).toBe('2027-06-24');
    expect(rec.result.openConflicts).toEqual(['temporal']);
    expect(rec.result.conflicts[0]).toMatchObject({ field: 'temporal', otherTier: 3 });
  });

  it('non-critical fields update immediately; critical changes wait for review by another agent', async () => {
    const tix = await snapshot(call, 'https://www.hermanusfynarts.co.za/tickets');
    const r = await call('submit_findings', { agentId: A, idempotencyKey: 'u1', recordType: 'event', recordId: id, claims: [
      { field: 'bookingUrl', value: 'https://www.hermanusfynarts.co.za/tickets/?utm_source=x', evidence: ev(tix, 'Book at') },
      { field: 'ticketPrice', value: 'R250', evidence: ev(tix, 'single tickets R250') },
      { field: 'temporal', value: { type: 'dated', startDate: '24 June 2027', endDate: '5 July 2027' }, evidence: ev(tix, '24 June 2027 - 5 July 2027') },
    ] });
    const st = Object.fromEntries(r.result.claims.map((c: any) => [c.field, c]));
    expect(st.bookingUrl.value).toBe('https://www.hermanusfynarts.co.za/tickets');
    expect(st.ticketPrice.value).toEqual({ amountMinor: 25000, currency: 'ZAR', qualifier: 'exact' });
    expect(st.temporal.status).toBe('pending_review'); // same source domain, changed dates
    let rec = await call('get_record', { id });
    expect(rec.result.data.temporal.endDate).toBe('2027-07-04');
    expect(rec.result.pendingChanges[0].field).toBe('temporal');

    // The proposer can't review its own change.
    const self = await call('submit_review', { agentId: A, reviewId: st.temporal.reviewId, decision: 'approve', checksPerformed: 'I checked my own work very carefully indeed.' });
    expect(self.error.code).toBe('SELF_REVIEW');

    // Another agent sees it (blind to the proposer) and approves.
    const list = await call('list_pending_reviews', { agentId: B });
    const item = list.result.reviews.find((x: any) => x.reviewId === st.temporal.reviewId);
    expect(item.evidence.excerpt).toBe('24 June 2027 - 5 July 2027');
    expect(JSON.stringify(item)).not.toMatch(/agent-alpha/);
    const ok = await call('submit_review', { agentId: B, reviewId: st.temporal.reviewId, decision: 'approve', checksPerformed: 'Fetched the tickets page again: it says 24 June 2027 - 5 July 2027.' });
    expect(ok.ok).toBe(true);
    rec = await call('get_record', { id, history: true });
    expect(rec.result.data.temporal.endDate).toBe('2027-07-05');
    expect(rec.result.history.at(-1).reason).toMatch(/review approved/);

    const twice = await call('submit_review', { agentId: 'agent-gamma', reviewId: st.temporal.reviewId, decision: 'reject', checksPerformed: 'Looked again at it from a third view.', reason: 'Too late now' });
    expect(twice.error.code).toBe('REVIEW_ALREADY_DECIDED');
  });

  it('rejecting a provisional value removes it from the record', async () => {
    const list = await call('list_pending_reviews', { agentId: B });
    const r = await call('submit_review', { agentId: B, reviewId: list.result.reviews[0].reviewId, decision: 'reject', checksPerformed: 'Fetched the organiser page; checked dates against it.', reason: 'Excerpt is for a different event' });
    expect(r.summary).toMatch(/removed/);
    const rec = await call('get_record', { id });
    expect(rec.result.data.temporal).toBeUndefined();
    expect(rec.result.missingInformation).toContain('dates');
  });

  it('rubber-stamp reviews are refused', async () => {
    const list = await call('list_pending_reviews', { agentId: B });
    const r = await call('submit_review', { agentId: B, reviewId: list.result.reviews[0].reviewId, decision: 'approve', checksPerformed: 'looks fine' });
    expect(r.error.code).toBe('INPUT_INVALID');
  });
});

describe('properties', () => {
  it('maps the property type through the glossary and refuses unknown types', async () => {
    const snp = await snapshot(call, 'https://lodge.example.co.za/');
    const base = (type: string, key: string) => ({ agentId: A, idempotencyKey: key, recordType: 'property', claims: [
      { field: 'name', value: 'Walker Bay Lodge', evidence: ev(snp, 'Walker Bay Lodge') },
      { field: 'town', value: 'Hermanus', evidence: ev(snp, 'in Hermanus') },
      { field: 'propertyType', value: type, evidence: ev(snp, 'luxury guest house') },
      { field: 'childPolicy', value: 'Children aged 12 and older are welcome.', evidence: ev(snp, 'Children aged 12 and older are welcome.'), },
    ] });
    const r = await call('submit_findings', base('Guest House', 'p1'));
    expect(r.result.claims.find((c: any) => c.field === 'propertyType').value).toBe('guesthouse');
    expect(r.result.claims.find((c: any) => c.field === 'childPolicy').status).toBe('provisional');
    const bad = await call('submit_findings', { ...base('treehouse palace', 'p2'), claims: base('treehouse palace', 'p2').claims.map((c: any) => c.field === 'name' ? { ...c, value: 'Other Lodge' } : c) });
    expect(bad.error.code).toBe('CORE_FIELDS_MISSING');
    expect(bad.error.problems.join(' ')).toMatch(/not a known property type/);
  });
});

describe('search_records', () => {
  it('finds by place, dates and interest synonyms, and explains empty results', async () => {
    await call('submit_findings', fynarts(fyn));
    const hit = await call('search_records', { location: 'Western Cape', when: 'June 2027', interests: ['kids friendly'] });
    expect(hit.result.total).toBe(1);
    expect(hit.warnings.join(' ')).toMatch(/read as glossary term "family-friendly"/);
    const miss = await call('search_records', { location: 'Hermanus', when: 'August 2027' });
    expect(miss.result.total).toBe(0);
    expect(miss.result.explanation).toMatch(/none match/);
    const season = await call('search_records', { location: 'Hermanus', when: 'next summer' });
    expect(season.error.code).toBe('WHEN_INVALID');
    expect(season.error.message).toMatch(/southern hemisphere/);
  });
});
