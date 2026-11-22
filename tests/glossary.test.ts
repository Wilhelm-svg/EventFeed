import { describe, it, expect, beforeEach } from 'vitest';
import { setup, snapshot, ev } from './helpers';

let call: Awaited<ReturnType<typeof setup>>['call'];
const A = 'agent-alpha';
const B = 'agent-beta';

beforeEach(() => ({ call } = setup()));

describe('lookup_glossary', () => {
  it('lists domains, resolves synonyms, searches, and suggests close terms', async () => {
    const all = await call('lookup_glossary', {});
    expect(all.result.domains.map((d: any) => d.domain)).toEqual(['interest', 'property-type', 'rate-basis', 'meal-plan']);
    const syn = await call('lookup_glossary', { term: 'Kid-Friendly' });
    expect(syn.result.matches[0]).toMatchObject({ term: 'family-friendly', resolvedVia: 'synonym' });
    const bb = await call('lookup_glossary', { term: 'B&B' });
    expect(bb.result.matches.map((m: any) => m.domain).sort()).toEqual(['meal-plan', 'property-type']); // same word, two domains
    const q = await call('lookup_glossary', { q: 'board' });
    expect(q.result.matches.map((m: any) => m.term)).toEqual(expect.arrayContaining(['half-board', 'full-board']));
    const none = await call('lookup_glossary', { term: 'jazz' });
    expect(none.result.matches).toEqual([]);
    expect(none.nextActions[0].tool).toBe('propose_glossary_change');
  });
});

describe('propose_glossary_change', () => {
  it('checks conflicts immediately', async () => {
    const dupTerm = await call('propose_glossary_change', { agentId: A, change: { kind: 'add_term', term: 'music', label: 'Music', definition: 'Music of any kind at all.', domain: 'interest', reason: 'Testing duplicate terms' } });
    expect(dupTerm.error.code).toBe('TERM_EXISTS');
    const clash = await call('propose_glossary_change', { agentId: A, change: { kind: 'add_synonym', term: 'concert', synonym: 'live music', reason: 'Concerts are live music' } });
    expect(clash.error.code).toBe('SYNONYM_CONFLICT');
    expect(clash.error.message).toMatch(/already belongs to music/);
    const stale = await call('propose_glossary_change', { agentId: A, change: { kind: 'edit_definition', term: 'wine', baseVersion: 7, definition: 'Wine tasting and wineries of all kinds.', reason: 'Clearer wording here' } });
    expect(stale.error.code).toBe('STALE_BASE');
    expect(stale.result.current.version).toBe(1);
    const missing = await call('propose_glossary_change', { agentId: A, change: { kind: 'add_synonym', term: 'no-such-term', synonym: 'x', reason: 'Testing missing terms' } });
    expect(missing.error.code).toBe('TERM_NOT_FOUND');
  });

  it('blocks a second proposal that would claim the same word while the first is pending', async () => {
    const first = await call('propose_glossary_change', { agentId: A, change: { kind: 'add_synonym', term: 'music', synonym: 'jazz', reason: 'Jazz events are tagged music' } });
    expect(first.ok).toBe(true);
    const second = await call('propose_glossary_change', { agentId: B, change: { kind: 'add_synonym', term: 'concert', synonym: 'Jazz', reason: 'Jazz nights are concerts' } });
    expect(second.error.code).toBe('SYNONYM_CONFLICT');
    expect(second.error.message).toMatch(/pending review/);
  });

  it('publishes after an independent review and re-tags records that used the word', async () => {
    const fyn = await snapshot(call, 'https://www.hermanusfynarts.co.za/');
    const sub = await call('submit_findings', { agentId: A, idempotencyKey: 'e1', recordType: 'event', claims: [
      { field: 'name', value: 'Hermanus FynArts Festival 2027', evidence: ev(fyn, 'Hermanus FynArts Festival') },
      { field: 'town', value: 'Hermanus', evidence: ev(fyn, 'Hermanus') },
      { field: 'temporal', value: { type: 'dated', startDate: '2027-06-24', endDate: '2027-07-04' }, evidence: ev(fyn, '24 June 2027 - 4 July 2027') },
      { field: 'tags', value: ['jazz', 'arts'] },
    ] });
    expect(sub.result.unmappedTags).toEqual(['jazz']);

    const dry = await call('propose_glossary_change', { agentId: A, change: { kind: 'add_synonym', term: 'music', synonym: 'jazz', reason: 'Jazz events are tagged music' }, dryRun: true });
    expect(dry.result.checksPassed).toBe(true);
    const prop = await call('propose_glossary_change', { agentId: A, idempotencyKey: 'g1', change: { kind: 'add_synonym', term: 'music', synonym: 'jazz', reason: 'Jazz events are tagged music' } });
    const replay = await call('propose_glossary_change', { agentId: A, idempotencyKey: 'g1', change: { kind: 'add_synonym', term: 'music', synonym: 'jazz', reason: 'Jazz events are tagged music' } });
    expect(replay.result.reviewId).toBe(prop.result.reviewId);
    expect((await call('lookup_glossary', { term: 'jazz' })).result.matches).toEqual([]); // not live yet

    const mine = await call('my_work', { agentId: A });
    expect(mine.result.myItemsUnderReview.find((x: any) => x.id === prop.result.reviewId).status).toBe('pending');

    const self = await call('submit_review', { agentId: A, reviewId: prop.result.reviewId, decision: 'approve', checksPerformed: 'I am sure jazz is music, I checked this.' });
    expect(self.error.code).toBe('SELF_REVIEW');
    const ok = await call('submit_review', { agentId: B, reviewId: prop.result.reviewId, decision: 'approve', checksPerformed: 'Jazz is a genre of music; no other interest term covers it; no conflicts.' });
    expect(ok.summary).toMatch(/1 record\(s\) re-tagged/);
    expect(ok.meta.glossaryVersion).toBe(2);

    const live = await call('lookup_glossary', { term: 'jazz' });
    expect(live.result.matches[0]).toMatchObject({ term: 'music', version: 2 });
    const rec = await call('get_record', { id: sub.result.recordId });
    expect(rec.result.data.tags).toEqual(['arts', 'music']);
    expect(rec.result.data.unmappedTags).toEqual([]);
  });

  it('deprecating a term redirects lookups to its replacement', async () => {
    const add = await call('propose_glossary_change', { agentId: A, change: { kind: 'add_term', term: 'gigs', label: 'Gigs', definition: 'Small live music shows in bars.', domain: 'interest', reason: 'Seen on venue pages' } });
    await call('submit_review', { agentId: B, reviewId: add.result.reviewId, decision: 'approve', checksPerformed: 'Checked meaning against several venue pages.' });
    const dep = await call('propose_glossary_change', { agentId: B, change: { kind: 'deprecate', term: 'gigs', baseVersion: 1, replacement: 'concert', reason: 'Duplicates concert' } });
    await call('submit_review', { agentId: A, reviewId: dep.result.reviewId, decision: 'approve', checksPerformed: 'Gigs and concert mean the same live music shows.' });
    const r = await call('lookup_glossary', { term: 'gigs' });
    expect(r.result.matches[0]).toMatchObject({ term: 'concert', resolvedVia: 'replacement' });
  });
});
