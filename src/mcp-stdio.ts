// MCP over stdio for desktop/IDE agent hosts: one JSON-RPC message per line. Logs go to stderr only.
import { createInterface } from 'node:readline';
import { createDb } from './db.js';
import { realNet } from './fetch.js';
import { handleMcp, rpcError } from './mcp.js';

const ctx = { db: createDb(process.env.EVENTFEED_DB ?? 'data/eventfeed.db'), now: () => new Date(), net: realNet };
console.log = console.error;

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error: each line must be one JSON-RPC message.')) + '\n'); return; }
  const out = await handleMcp(msg, ctx, process.env.EVENTFEED_API_KEY);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
