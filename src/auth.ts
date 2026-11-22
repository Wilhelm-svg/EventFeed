import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import { ApiError, agentId, type Ctx, type OpResult } from './registry.js';

export type Agent = { id: string; organisation: string; status: string };

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Looks up the agent behind an API key. Keys are stored only as hashes. */
export function agentForKey(db: Db, key: string | undefined): Agent | undefined {
  if (!key) return undefined;
  return db.sql.prepare('SELECT id, organisation, status FROM agents WHERE keyHash = ?').get(hash(key)) as Agent | undefined;
}

export const organisationOf = (db: Db, id: string): string | undefined =>
  (db.sql.prepare('SELECT organisation FROM agents WHERE id = ?').get(id) as any)?.organisation;

export const registerInput = z.strictObject({
  agentId: agentId.describe('The id you want, e.g. "acme-researcher-1". It identifies all your work.'),
  organisation: z.string().min(2).max(100).describe('Who runs this agent, e.g. "Acme Travel". Reviews must come from a different organisation.'),
  contact: z.string().max(200).optional().describe('Optional email or URL for the operator.'),
});

export function registerAgent(input: z.infer<typeof registerInput>, { db, now }: Ctx): OpResult {
  if (db.sql.prepare('SELECT 1 FROM agents WHERE id = ?').get(input.agentId)) {
    throw new ApiError(409, 'AGENT_EXISTS', `The agentId "${input.agentId}" is taken. Choose another id. If it is yours, keep using the API key you received.`);
  }
  const key = `ef_${randomBytes(24).toString('hex')}`;
  db.sql.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, 'active', ?)").run(input.agentId, input.organisation.trim(), input.contact ?? null, hash(key), now().toISOString());
  db.audit(input.agentId, 'register_agent', 'agent', input.agentId, { organisation: input.organisation });
  return {
    status: 201,
    result: { agentId: input.agentId, organisation: input.organisation.trim(), apiKey: key },
    summary: `Registered ${input.agentId}. Save apiKey now: it is shown only once.`,
    warnings: ['Send the key on every write: HTTP header "Authorization: Bearer <apiKey>", or an "apiKey" argument in the tool call if your client cannot set headers.'],
    nextActions: [{ tool: 'get_instructions', why: 'Read the rules before writing', args: {} }],
  };
}
