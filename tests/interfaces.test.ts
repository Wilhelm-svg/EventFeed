import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup } from './helpers';

const rpc = (app: any, method: string, params?: any, notification = false) =>
  request(app).post('/mcp').send({ jsonrpc: '2.0', ...(notification ? {} : { id: 1 }), method, params });

describe('MCP', () => {
  it('initialize → notifications/initialized → tools/list', async () => {
    const { app } = setup();
    const init = await rpc(app, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'eventfeed' }, capabilities: { tools: {} } });
    expect((await rpc(app, 'notifications/initialized', undefined, true)).status).toBe(202);
    const list = await rpc(app, 'tools/list');
    const names = list.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['register_agent', 'get_instructions', 'search_records', 'get_record', 'fetch_source', 'submit_findings', 'submit_rate', 'lookup_glossary', 'propose_glossary_change', 'browse_knowledge', 'get_knowledge', 'propose_knowledge', 'list_pending_reviews', 'submit_review', 'my_work']);
    for (const t of list.body.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('returns tool errors as isError results the model can read, and protocol errors as JSON-RPC errors', async () => {
    const { app } = setup();
    const bad = await rpc(app, 'tools/call', { name: 'get_record', arguments: { id: 'evt_nope' } });
    expect(bad.body.result.isError).toBe(true);
    expect(JSON.parse(bad.body.result.content[0].text).error.code).toBe('RECORD_NOT_FOUND');
    expect((await rpc(app, 'tools/call', { name: 'delete_everything' })).body.error.code).toBe(-32602);
    expect((await rpc(app, 'resources/list')).body.error.code).toBe(-32601);
  });

  it('get_instructions explains the rules and every tool, with full schemas on request', async () => {
    const { call } = setup();
    const r = await call('get_instructions', {});
    expect(r.result.tools).toHaveLength(15);
    expect(r.result.rules.join(' ')).toMatch(/exact words/);
    const one = await call('get_instructions', { tool: 'submit_findings' });
    expect(one.result.inputSchema.properties.claims).toBeDefined();
    expect(one.result.fields.event.temporal).toMatch(/decision-critical/);
  });
});

describe('REST and MCP are the same operations', () => {
  it('gives identical results for the same call', async () => {
    const { app, call } = setup();
    const viaMcp = await call('lookup_glossary', { term: 'pp sharing' });
    const viaRest = (await request(app).get('/api/glossary').query({ term: 'pp sharing' })).body;
    expect(viaRest).toEqual(viaMcp);
    const searchRest = (await request(app).get('/api/records/search').query({ location: 'Hermanus', limit: '5', interests: 'kid friendly,music' })).body;
    const searchMcp = await call('search_records', { location: 'Hermanus', limit: 5, interests: ['kid friendly', 'music'] });
    expect(searchRest).toEqual(searchMcp);
  });

  it('REST writes work with path params and the Idempotency-Key header', async () => {
    const { app, keyFor } = setup();
    const r = await request(app).post('/api/glossary/proposals').set('Idempotency-Key', 'h1').set('Authorization', `Bearer ${await keyFor('agent-alpha')}`)
      .send({ change: { kind: 'add_synonym', term: 'music', synonym: 'jazz', reason: 'Jazz events are tagged music' } });
    expect(r.status).toBe(202);
    const rev = await request(app).post(`/api/reviews/${r.body.result.reviewId}`).set('Authorization', `Bearer ${await keyFor('agent-beta')}`)
      .send({ decision: 'approve', checksPerformed: 'Jazz is a genre of music; checked for conflicts.' });
    expect(rev.status).toBe(200);
    expect(rev.body.ok).toBe(true);
  });

  it('unknown routes, wrong methods and bad JSON get envelopes with guidance', async () => {
    const { app } = setup();
    const del = await request(app).delete('/api/records/evt_1');
    expect(del.status).toBe(405);
    expect(del.body.error.message).toMatch(/no delete/);
    expect((await request(app).get('/nope')).status).toBe(404);
    const json = await request(app).post('/api/submissions').set('Content-Type', 'application/json').send('{bad');
    expect(json.body.error.code).toBe('JSON_INVALID');
  });

  it('serves an OpenAPI spec generated from the same operations', async () => {
    const { app } = setup();
    const spec = (await request(app).get('/openapi.json')).body;
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/submissions', '/api/records/{id}', '/api/glossary/proposals']));
    expect(spec.paths['/api/records/search'].get.parameters.find((p: any) => p.name === 'location').required).toBe(true);
  });
});

describe('MCP over stdio (desktop and IDE agent hosts)', () => {
  it('answers initialize and tools/call line by line', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp-stdio.ts'], { env: { ...process.env, EVENTFEED_DB: ':memory:' } });
    const lines: any[] = [];
    let buf = '';
    const done = new Promise<void>((resolve) => child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
      if (lines.length >= 3) resolve();
    }));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    child.stdin.write('not json\n');
    await done;
    child.kill();
    const byId = (i: number | null) => lines.find((l) => l.id === i);
    expect(byId(1).result.serverInfo.name).toBe('eventfeed');
    expect(byId(2).result.tools).toHaveLength(15);
    expect(byId(null).error.code).toBe(-32700);
  }, 20000);
});
