import { createApp } from './app.js';
import { createDb } from './db.js';

const app = createApp({ db: createDb(process.env.EVENTFEED_DB ?? 'data/eventfeed.db') });
app.set('trust proxy', true);

// Reads are open; every write needs an API key (register_agent), so the server can listen publicly.
// HOST=127.0.0.1 keeps it on this machine only. Put it behind HTTPS (a reverse proxy) when public.
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
app.listen(port, host, () => console.log(`EventFeed on ${host}:${port} · REST /api/instructions · MCP POST /mcp · spec /openapi.json`));
