import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup } from './helpers';

const proposal = { change: { kind: 'add_synonym', term: 'music', synonym: 'jazz', reason: 'Jazz events are tagged music' } };

describe('API keys', () => {
  it('reading needs no key; writing without a key says how to get one', async () => {
    const { app, raw } = setup();
    expect((await request(app).get('/api/glossary').query({ term: 'kid friendly' })).body.ok).toBe(true);
    const r = await raw('propose_glossary_change', proposal);
    expect(r.error.code).toBe('AUTH_REQUIRED');
    expect(r.nextActions[0].tool).toBe('register_agent');
    expect((await raw('propose_glossary_change', proposal, 'ef_wrong')).error.code).toBe('AUTH_INVALID');
  });

  it('register once, then write with the header or an apiKey argument; identity comes from the key', async () => {
    const { raw, db } = setup();
    const reg = await raw('register_agent', { agentId: 'acme-1', organisation: 'Acme Travel' });
    expect(reg.result.apiKey).toMatch(/^ef_/);
    expect(JSON.stringify(db.sql.prepare('SELECT * FROM agents').all())).not.toContain(reg.result.apiKey); // stored hashed
    expect((await raw('register_agent', { agentId: 'acme-1', organisation: 'Other' })).error.code).toBe('AGENT_EXISTS');
    const viaArg = await raw('propose_glossary_change', { ...proposal, apiKey: reg.result.apiKey });
    expect(viaArg.ok).toBe(true);
    const work = await raw('my_work', {}, reg.result.apiKey);
    expect(work.result.myItemsUnderReview).toHaveLength(1);
    const spoof = await raw('my_work', { agentId: 'someone-else' }, reg.result.apiKey);
    expect(spoof.error.code).toBe('AGENT_MISMATCH');
  });

  it('agents from the same organisation cannot review each other', async () => {
    const { raw } = setup();
    const a = (await raw('register_agent', { agentId: 'acme-1', organisation: 'Acme Travel' })).result.apiKey;
    const b = (await raw('register_agent', { agentId: 'acme-2', organisation: 'acme travel' })).result.apiKey;
    const c = (await raw('register_agent', { agentId: 'other-1', organisation: 'Other Co' })).result.apiKey;
    const p = await raw('propose_glossary_change', proposal, a);
    expect((await raw('list_pending_reviews', {}, b)).result.reviews).toHaveLength(0);
    const same = await raw('submit_review', { reviewId: p.result.reviewId, decision: 'approve', checksPerformed: 'Colleague check of the jazz synonym proposal.' }, b);
    expect(same.error.code).toBe('SAME_ORGANISATION');
    expect((await raw('list_pending_reviews', {}, c)).result.reviews).toHaveLength(1);
  });

  it('rate-limits page fetches per agent', async () => {
    const { raw } = setup();
    const k = (await raw('register_agent', { agentId: 'busy-1', organisation: 'Busy' })).result.apiKey;
    let last;
    for (let i = 0; i < 31; i++) last = await raw('fetch_source', { url: 'https://www.hermanusfynarts.co.za/' }, k);
    expect(last.error.code).toBe('RATE_LIMITED');
    expect(last.result.retryAfterSeconds).toBeGreaterThan(0);
  });
});
