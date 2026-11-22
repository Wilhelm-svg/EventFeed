// Live smoke test against a running server and the real web, via MCP over HTTP.
// Writes nothing: the submission is a dry run. Run: npm.cmd run smoke
export {};
const BASE = process.env.EVENTFEED_URL ?? 'http://127.0.0.1:3000';
let id = 0;
let key = process.env.EVENTFEED_API_KEY ?? '';
async function call(name: string, args: object) {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const body: any = await res.json();
  const env = body.result.structuredContent;
  console.log(`${env.ok ? 'ok  ' : 'FAIL'} ${name}: ${env.summary}`);
  return env;
}

const url = 'https://www.hermanusfynarts.co.za/';
await call('get_instructions', {});
if (!key) key = (await call('register_agent', { agentId: `smoke-${Date.now()}`, organisation: 'EventFeed smoke test' })).result.apiKey;
await call('lookup_glossary', { term: 'kid friendly' });
const page = await call('fetch_source', { url, find: 'June 2027' });
if (!page.ok) process.exit(1);
const m: string | undefined = page.result.matches?.[0];
const dates = m?.match(/\d{1,2} june 2027 - \d{1,2} july 2027/)?.[0];
console.log(`     found on the live page: ${dates ?? '(no June-July 2027 range; the page has changed)'}`);
if (dates) {
  const [start, end] = dates.split(' - ');
  const sub = await call('submit_findings', {
    idempotencyKey: `smoke-${Date.now()}`, recordType: 'event', dryRun: true,
    claims: [
      { field: 'name', value: 'Hermanus FynArts Festival 2027', evidence: { snapshotId: page.result.snapshotId, excerpt: 'FynArts Festival' } },
      { field: 'town', value: 'Hermanus', evidence: { snapshotId: page.result.snapshotId, excerpt: 'Hermanus' } },
      { field: 'temporal', value: { type: 'dated', startDate: start, endDate: end }, evidence: { snapshotId: page.result.snapshotId, excerpt: dates } },
      { field: 'tags', value: ['arts', 'music', 'food'] },
    ],
  });
  if (!sub.ok) process.exit(1);
}
await call('search_records', { location: 'Hermanus' });
console.log('DONE');
