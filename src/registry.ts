import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import type { Net } from './fetch.js';

export const API_VERSION = '1.0';

export type Ctx = { db: Db; now: () => Date; net: Net };
export type NextAction = { tool: string; why: string; args?: Record<string, unknown> };
export type OpResult = { result: unknown; summary: string; warnings?: string[]; nextActions?: NextAction[]; status?: number };

/** One operation, defined once. REST routes, MCP tools and OpenAPI are all generated from this. */
export type Op = {
  name: string;
  description: string;
  method: 'GET' | 'POST';
  path: string;
  readOnly: boolean;
  input: z.ZodType;
  example: Record<string, unknown>;
  run: (input: any, ctx: Ctx) => OpResult | Promise<OpResult>;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: { problems?: string[]; suggestions?: string[]; nextActions?: NextAction[]; validExample?: unknown; result?: unknown } = {},
  ) {
    super(message);
  }
}

export type Envelope = {
  ok: boolean;
  result: unknown;
  summary: string;
  warnings: string[];
  error?: { code: string; message: string; problems: string[]; suggestions: string[]; validExample?: unknown };
  nextActions: NextAction[];
  meta: { apiVersion: string; glossaryVersion: number; tool: string };
};

/** Rewrites a Zod issue as one plain-language sentence about one field. */
export function plainIssue(i: any, input: any): string {
  const field = i.path.join('.') || 'input';
  const value = i.path.reduce((o: any, k: any) => (o == null ? undefined : o[k]), input);
  if (i.code === 'unrecognized_keys') return `unknown field(s) ${i.keys.join(', ')}: remove them`;
  if (value === undefined && i.code === 'invalid_type') return `${field} is required`;
  if (i.code === 'invalid_type') return `${field} must be ${i.expected === 'array' ? 'a list' : `a ${i.expected}`}, but got ${JSON.stringify(value)}`;
  if (i.code === 'too_big') return `${field} must be at most ${i.maximum}${i.origin === 'string' ? ' characters' : ''}`;
  if (i.code === 'too_small') return i.origin === 'array' ? `${field} needs at least ${i.minimum} item(s)` : `${field} must be at least ${i.minimum}${i.origin === 'string' ? ' characters' : ''}`;
  if (i.code === 'invalid_value') return `${field} must be one of ${i.values.map((v: any) => JSON.stringify(v)).join(', ')}, but got ${JSON.stringify(value)}`;
  return `${field}: ${i.message}`;
}

/** Reading is open. Writing, reviewing and anything personal needs an API key from register_agent. */
export const needsAuth = (op: Op) => op.name !== 'register_agent' && (!op.readOnly || 'agentId' in ((op.input as any).shape ?? {}));

const RATE_LIMITS: Record<string, number> = { fetch_source: 30 };
const DEFAULT_WRITE_LIMIT = 120;
const rateWindowsByDb = new WeakMap<object, Map<string, { start: number; n: number }>>();

/** Runs one operation for either interface and always returns the same envelope. */
export async function runOp(op: Op, rawInput: unknown, ctx: Ctx, headerKey?: string): Promise<{ status: number; body: Envelope }> {
  const meta = { apiVersion: API_VERSION, glossaryVersion: ctx.db.glossaryVersion(), tool: op.name };
  const fail = (status: number, e: ApiError) => ({
    status,
    body: {
      ok: false,
      result: e.extra.result ?? null,
      summary: e.message,
      warnings: [],
      error: { code: e.code, message: e.message, problems: e.extra.problems ?? [], suggestions: e.extra.suggestions ?? [], validExample: e.extra.validExample },
      nextActions: e.extra.nextActions ?? [],
      meta,
    },
  });

  // Authentication: header (Authorization: Bearer ...) or an apiKey argument for clients that can't set headers.
  let input: any = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? { ...(rawInput as object) } : rawInput ?? {};
  const argKey = typeof input.apiKey === 'string' ? input.apiKey : undefined;
  if (input && typeof input === 'object') delete input.apiKey;
  if (needsAuth(op)) {
    const register = [{ tool: 'register_agent', why: 'Get an API key (one call, no approval needed)', args: { agentId: 'your-agent-id', organisation: 'Your organisation' } }];
    const key = headerKey ?? argKey;
    if (!key) return fail(401, new ApiError(401, 'AUTH_REQUIRED', `${op.name} needs an API key. Call register_agent once to get one, then send it as "Authorization: Bearer <apiKey>" or as an "apiKey" argument.`, { nextActions: register }));
    const agent = ctx.db.sql.prepare("SELECT id, status FROM agents WHERE keyHash = ?").get(createHash('sha256').update(key).digest('hex')) as any;
    if (!agent) return fail(401, new ApiError(401, 'AUTH_INVALID', 'That API key is not valid. Check it was copied exactly, or register a new agent.', { nextActions: register }));
    if (agent.status !== 'active') return fail(403, new ApiError(403, 'AGENT_SUSPENDED', `Agent ${agent.id} is suspended and cannot write.`));
    if ('agentId' in ((op.input as any).shape ?? {})) {
      if (input.agentId !== undefined && input.agentId !== agent.id) {
        return fail(403, new ApiError(403, 'AGENT_MISMATCH', `agentId "${input.agentId}" does not match your API key (${agent.id}). Leave agentId out or send "${agent.id}".`));
      }
      input.agentId = agent.id;
    }
    const limit = RATE_LIMITS[op.name] ?? DEFAULT_WRITE_LIMIT;
    const k = `${agent.id}:${op.name}`;
    const nowMs = Date.now();
    let rateWindows = rateWindowsByDb.get(ctx.db);
    if (!rateWindows) rateWindowsByDb.set(ctx.db, (rateWindows = new Map()));
    const w = rateWindows.get(k);
    if (!w || nowMs - w.start >= 60000) rateWindows.set(k, { start: nowMs, n: 1 });
    else if (++w.n > limit) {
      const wait = Math.ceil((w.start + 60000 - nowMs) / 1000);
      return fail(429, new ApiError(429, 'RATE_LIMITED', `Too many ${op.name} calls (limit ${limit} per minute). Wait ${wait} seconds, then retry with the same idempotencyKey.`, { result: { retryAfterSeconds: wait } }));
    }
  }
  rawInput = input;

  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => plainIssue(i, rawInput));
    return fail(400, new ApiError(400, 'INPUT_INVALID', `The ${op.name} input is invalid: ${problems.join('; ')}`, {
      problems,
      suggestions: ['Fix the fields listed in problems and call again', 'validExample is a valid input for this tool'],
      validExample: op.example,
      nextActions: [{ tool: 'get_instructions', why: `See the full input schema for ${op.name}`, args: { tool: op.name } }],
    }));
  }
  try {
    const r = await op.run(parsed.data, ctx);
    return {
      status: r.status ?? 200,
      body: { ok: true, result: r.result, summary: r.summary, warnings: r.warnings ?? [], nextActions: r.nextActions ?? [], meta: { ...meta, glossaryVersion: ctx.db.glossaryVersion() } },
    };
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e);
    console.error(e);
    return fail(500, new ApiError(500, 'INTERNAL', 'Something went wrong on the server. Nothing was saved by this call.', { suggestions: ['Retry with the same idempotencyKey'] }));
  }
}

/** Shared input pieces. */
export const agentId = z.string().regex(/^[A-Za-z0-9._:-]{3,64}$/, 'must be 3-64 letters, digits or ._:- (e.g. "acme-researcher-1")')
  .describe('Your agent id. Filled in from your API key; if you send it, it must match.');
export const idempotencyKey = z.string().min(1).max(100);
