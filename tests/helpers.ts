import request from 'supertest';
import { createApp } from '../src/app';
import { createDb } from '../src/db';
import type { Net } from '../src/fetch';

// Frozen clock: Sunday 22 November 2026, 10:00 UTC.
export const NOW = new Date('2026-11-22T10:00:00Z');

const html = (title: string, body: string) => `<html><head><title>${title}</title><script>var x = "ignore me";</script></head><body>${body}</body></html>`;

export const PAGES: Record<string, { status?: number; contentType?: string; body: string; location?: string; tooLarge?: boolean }> = {
  'https://www.hermanusfynarts.co.za/': {
    body: html('Hermanus FynArts', '<h1>Hermanus FynArts Festival</h1><p>FynArts Festival:<br>24 June 2027 &ndash; 4 July 2027</p><p>Since 2013, Hermanus FynArts has been celebrating South African creativity.</p><p>FynArts Old Harbour Sunset Concert: 6 March 2027</p>'),
  },
  'https://www.sa-venues.com/events/fynarts': {
    body: html('FynArts listing', '<p>Hermanus FynArts Festival runs 23 June 2027 to 4 July 2027 in Hermanus.</p><p>Tickets from R150 per show.</p>'),
  },
  'https://hermanuscountrymarket.co.za/': {
    body: html('Hermanus Country Market', '<p>Open every Saturday from 9am to 2pm</p><p>You will find us at the Hermanus Cricket Club at the corner of Fairways Avenue &amp; Jose Burman Drive.</p><p>Pet-friendly. Family-friendly. Kiddies corner.</p>'),
  },
  'https://www.hermanusfynarts.co.za/tickets': {
    body: html('Tickets', '<p>Festival passes cost R1 200 and single tickets R250. Book at https://www.hermanusfynarts.co.za/tickets</p><p>The festival now runs 24 June 2027 &ndash; 5 July 2027.</p>'),
  },
  'https://old.example.org/moved': { status: 301, location: 'https://www.hermanusfynarts.co.za/', body: '' },
  'https://evil.example.org/redirect': { status: 302, location: 'http://internal.test/admin', body: '' },
  'https://big.example.org/': { body: '', tooLarge: true },
  'https://pdf.example.org/brochure.pdf': { contentType: 'application/pdf', body: '%PDF-1.4' },
  'https://lodge.example.co.za/': {
    body: html('Walker Bay Lodge', '<h1>Walker Bay Lodge</h1><p>A luxury guest house in Hermanus overlooking the bay.</p><p>Children aged 12 and older are welcome.</p><p>Book online at https://lodge.example.co.za/book</p><p>Winter special: R4 200 per person sharing, B&amp;B, valid 1 June to 30 September 2027.</p>'),
  },
};

export const fakeNet: Net = {
  resolve: async (host) => (host === 'internal.test' ? ['10.0.0.5'] : host === 'nowhere.test' ? Promise.reject(new Error('ENOTFOUND')) : ['93.184.216.34']),
  get: async (url) => {
    const p = PAGES[url];
    if (!p) return { status: 404, contentType: 'text/html', body: 'not found', tooLarge: false };
    return { status: p.status ?? 200, location: p.location, contentType: p.contentType ?? 'text/html; charset=utf-8', body: p.body, tooLarge: !!p.tooLarge };
  },
};

export function setup() {
  const db = createDb(':memory:');
  const app = createApp({ db, now: () => NOW, net: fakeNet });
  let id = 1;
  const keys: Record<string, string> = {};
  const raw = async (name: string, args: Record<string, unknown>, key?: string) => {
    const req = request(app).post('/mcp');
    if (key) req.set('Authorization', `Bearer ${key}`);
    const res = await req.send({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    if (res.body.error) throw new Error(JSON.stringify(res.body.error));
    return res.body.result.structuredContent;
  };
  /** API key for an agent; each test agent is registered on first use, in its own organisation. */
  const keyFor = async (agent: string) => {
    keys[agent] ??= (await raw('register_agent', { agentId: agent, organisation: `org-${agent}` })).result.apiKey;
    return keys[agent];
  };
  /** Calls a tool through MCP as args.agentId (default agent-alpha) and returns the envelope. */
  const call = async (name: string, args: Record<string, unknown>) =>
    raw(name, args, name === 'register_agent' ? undefined : await keyFor(typeof args.agentId === 'string' ? args.agentId : 'agent-alpha'));
  return { db, app, call, raw, keyFor };
}

export async function snapshot(call: (n: string, a: any) => Promise<any>, url: string) {
  const r = await call('fetch_source', { url });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.result.snapshotId as string;
}

export const ev = (snapshotId: string, excerpt: string) => ({ snapshotId, excerpt });
