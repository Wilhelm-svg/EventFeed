import { z } from 'zod';
import { OPS } from './ops.js';
import { API_VERSION, runOp, type Ctx } from './registry.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const jsonSchemaOf = (schema: z.ZodType) => {
  const s: any = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  delete s.$schema;
  return s;
};

export const mcpTools = () => OPS.map((op) => ({
  name: op.name,
  description: op.description,
  inputSchema: jsonSchemaOf(op.input),
  annotations: { readOnlyHint: op.readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: op.name === 'fetch_source' },
}));

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/** Minimal MCP server over JSON-RPC: initialize, ping, tools/list, tools/call. Shared by HTTP and stdio. */
export async function handleMcp(msg: Msg | Msg[], ctx: Ctx, apiKey?: string): Promise<object | object[] | null> {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMcp(m, ctx, apiKey)))).filter(Boolean) as object[];
    return out.length ? out : null;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return rpcError(null, -32600, 'Invalid request: expected a JSON-RPC object with "method".');
  if (msg.id === undefined) return null; // notification, e.g. notifications/initialized
  const ok = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'eventfeed', version: API_VERSION },
        instructions: 'EventFeed: an agent-orchestrated research pipeline. Call get_instructions first. Reading is open; to write, call register_agent once and send the apiKey (Authorization header, or an apiKey argument on each tool call).',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: mcpTools() });
    case 'tools/call': {
      const op = OPS.find((o) => o.name === msg.params?.name);
      if (!op) return rpcError(msg.id, -32602, `Unknown tool "${msg.params?.name}". Tools: ${OPS.map((o) => o.name).join(', ')}.`);
      const { body } = await runOp(op, msg.params?.arguments ?? {}, ctx, apiKey);
      // Errors are tool results (isError) so the model can read them and fix its call.
      return ok({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: !body.ok });
    }
    default:
      return rpcError(msg.id, -32601, `Method "${msg.method}" is not supported. Supported: initialize, ping, tools/list, tools/call.`);
  }
}

export const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
