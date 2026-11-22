import express, { type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db.js';
import { realNet, type Net } from './fetch.js';
import { handleMcp, jsonSchemaOf, rpcError } from './mcp.js';
import { OPS } from './ops.js';
import { API_VERSION, runOp, type Ctx } from './registry.js';

const bearer = (req: Request) => req.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? req.get('x-api-key') ?? undefined;

/** Query strings are text; turn them into the types the tool's schema expects. */
function coerceQuery(query: Record<string, unknown>, schema: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    const t = schema.properties?.[k]?.type;
    if (typeof v !== 'string') out[k] = v;
    else if (t === 'boolean') out[k] = v === 'true' ? true : v === 'false' ? false : v;
    else if (t === 'integer' || t === 'number') out[k] = v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v;
    else out[k] = v;
  }
  return out;
}

function openapi() {
  const paths: Record<string, any> = {};
  for (const op of OPS) {
    const path = op.path.replace(/:(\w+)/g, '{$1}');
    const schema = jsonSchemaOf(op.input);
    const pathParams = [...op.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const params = pathParams.map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } }));
    const entry: any = { operationId: op.name, summary: op.description, responses: { default: { description: 'Envelope: { ok, result, summary, warnings, error?, nextActions, meta }' } } };
    if (op.method === 'GET') {
      entry.parameters = [...params, ...Object.entries(schema.properties ?? {}).filter(([n]) => !pathParams.includes(n))
        .map(([n, s]) => ({ name: n, in: 'query', required: (schema.required ?? []).includes(n), schema: s }))];
    } else {
      entry.parameters = params;
      entry.requestBody = { required: true, content: { 'application/json': { schema, example: op.example } } };
    }
    (paths[path] ??= {})[op.method.toLowerCase()] = entry;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'EventFeed', version: API_VERSION, description: 'Same operations as the MCP server at POST /mcp. Start with GET /api/instructions.' },
    servers: [{ url: process.env.PUBLIC_URL ?? 'http://127.0.0.1:3000' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'API key from POST /api/agents (register_agent). Reads need no key.' } } },
    paths,
  };
}

export function createApp({ db, now = () => new Date(), net = realNet }: { db: Db; now?: () => Date; net?: Net }) {
  const ctx: Ctx = { db, now, net };
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get(['/', '/api'], (_req, res) => res.redirect('/api/instructions'));
  app.get('/openapi.json', (_req, res) => res.json(openapi()));

  app.post('/mcp', async (req, res) => {
    const out = await handleMcp(req.body, ctx, bearer(req));
    out === null ? res.status(202).end() : res.json(out);
  });
  app.all('/mcp', (_req, res) => res.status(405).json(rpcError(null, -32000, 'Use POST /mcp with a JSON-RPC body. Server-sent event streams are not offered.')));

  for (const op of OPS) {
    const handler = async (req: Request, res: Response) => {
      const schema = jsonSchemaOf(op.input);
      const input = op.method === 'GET' ? { ...coerceQuery(req.query as any, schema), ...req.params } : { ...(req.body ?? {}), ...req.params };
      const key = req.get('Idempotency-Key');
      if (key && op.method === 'POST' && input.idempotencyKey === undefined) input.idempotencyKey = key;
      const { status, body } = await runOp(op, input, ctx, bearer(req));
      res.status(status).json(body);
    };
    op.method === 'GET' ? app.get(op.path, handler) : app.post(op.path, handler);
  }

  const list = OPS.map((o) => `${o.method} ${o.path} (${o.name})`);
  const envelopeError = (code: string, message: string, suggestions: string[]) => ({
    ok: false, result: null, summary: message, warnings: [], error: { code, message, problems: [], suggestions }, nextActions: [{ tool: 'get_instructions', why: 'See all tools', args: {} }],
    meta: { apiVersion: API_VERSION, glossaryVersion: db.glossaryVersion(), tool: null },
  });
  app.use((req, res) => {
    const known = OPS.some((o) => new RegExp(`^${o.path.replace(/:\w+/g, '[^/]+')}$`).test(req.path));
    res.status(known ? 405 : 404).json(envelopeError(known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', `${req.method} ${req.path} is not an EventFeed operation. There is no delete; records are retired with a status claim.`, list));
  });
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json(envelopeError('JSON_INVALID', 'The request body is not valid JSON.', ['Send Content-Type: application/json with a JSON object']));
    if (err.type === 'entity.too.large') return res.status(413).json(envelopeError('BODY_TOO_LARGE', 'The request body is over 1 MB.', ['Send fewer claims per submission']));
    console.error(err);
    res.status(500).json(envelopeError('INTERNAL', 'Something went wrong on the server.', ['Retry with the same idempotencyKey']));
  });
  return app;
}
