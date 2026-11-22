import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Db } from './db.js';
import { ApiError } from './registry.js';
import { excerptKey } from './normalize.js';

/** Network access, injectable so tests never touch the internet. */
export type Net = {
  resolve: (host: string) => Promise<string[]>;
  get: (url: string) => Promise<{ status: number; location?: string; contentType: string; body: string; tooLarge: boolean }>;
};

export const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const CACHE_MINUTES = 10;
const ALLOWED_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/json|application\/xml|text\/xml)/i;

export const realNet: Net = {
  resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  async get(url) {
    await politeWait(new URL(url).host);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'EventFeedBot/1.0 (evidence snapshots)' } });
    const contentType = res.headers.get('content-type') ?? '';
    const location = res.headers.get('location') ?? undefined;
    if (!res.body || (res.status >= 300 && res.status < 400)) return { status: res.status, location, contentType, body: '', tooLarge: false };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); return { status: res.status, contentType, body: '', tooLarge: true }; }
      chunks.push(value);
    }
    return { status: res.status, contentType, body: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
  },
};

function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function assertPublic(net: Net, u: URL) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ApiError(400, 'URL_INVALID', 'Only http and https URLs can be fetched.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new ApiError(400, 'URL_NOT_ALLOWED', 'Only public internet addresses can be fetched.');
  let ips: string[];
  try { ips = isIP(host) ? [host] : await net.resolve(host); }
  catch { throw new ApiError(400, 'HOST_NOT_FOUND', `Couldn't find the host "${host}". Check the URL.`); }
  if (!ips.length || ips.some(isPrivate)) throw new ApiError(400, 'URL_NOT_ALLOWED', 'Only public internet addresses can be fetched.');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é' };

/** HTML → readable text. Tags become spaces so words never run together. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
  const text = decode(
    html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
  return { title: title ? decode(title).trim() : null, text };
}

const lastHit = new Map<string, number>();
const politeWait = async (host: string) => {
  const wait = (lastHit.get(host) ?? 0) + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
};

export type Snapshot = { id: string; url: string; finalUrl: string; fetchedAt: string; contentType: string; title: string | null; text: string; hash: string };

/** Fetches a public page, stores an evidence snapshot (deduplicated by URL + content) and returns it. */
export async function fetchSource(db: Db, net: Net, rawUrl: string, now: Date, fresh = false): Promise<{ snapshot: Snapshot; cached: boolean }> {
  let u: URL;
  try { u = new URL(rawUrl.trim()); } catch { throw new ApiError(400, 'URL_INVALID', `"${rawUrl}" is not a full URL. Include https://`); }
  const recent = fresh ? undefined : db.sql.prepare('SELECT * FROM snapshots WHERE url = ? AND fetchedAt > ? ORDER BY fetchedAt DESC LIMIT 1')
    .get(u.href, new Date(now.getTime() - CACHE_MINUTES * 60000).toISOString()) as Snapshot | undefined;
  if (recent) return { snapshot: recent, cached: true };

  let current = u;
  for (let hop = 0; ; hop++) {
    if (hop > 5) throw new ApiError(502, 'TOO_MANY_REDIRECTS', 'The page redirected more than 5 times.');
    await assertPublic(net, current);
    let res;
    try { res = await net.get(current.href); }
    catch { throw new ApiError(502, 'FETCH_FAILED', `Couldn't load ${current.href} (timeout or connection error). Try again later or use another source.`); }
    if (res.status >= 300 && res.status < 400 && res.location) { current = new URL(res.location, current); continue; }
    if (res.tooLarge) throw new ApiError(413, 'SOURCE_TOO_LARGE', `The page is larger than ${MAX_BYTES / 1024 / 1024} MB. Cite a more specific page.`);
    if (res.status >= 400) throw new ApiError(502, 'SOURCE_HTTP_ERROR', `${current.href} returned HTTP ${res.status}. Use another source, or check the URL.`);
    if (!ALLOWED_TYPES.test(res.contentType)) {
      throw new ApiError(415, 'SOURCE_TYPE_UNSUPPORTED', `Content type "${res.contentType || 'unknown'}" can't be used as evidence yet (PDF and images aren't supported). Find an HTML page with the same information.`);
    }
    const { title, text } = /html|xml/i.test(res.contentType) ? htmlToText(res.body) : { title: null, text: res.body.replace(/\s+/g, ' ').trim() };
    if (text.length < 20) throw new ApiError(422, 'SOURCE_EMPTY', 'The page has almost no readable text (it may need JavaScript). Try another page or source.');
    const hash = createHash('sha256').update(text).digest('hex');
    const id = `snp_${createHash('sha256').update(`${u.href}\n${hash}`).digest('hex').slice(0, 16)}`;
    const existing = db.sql.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Snapshot | undefined;
    if (existing) {
      db.sql.prepare('UPDATE snapshots SET fetchedAt = ? WHERE id = ?').run(now.toISOString(), id);
      return { snapshot: { ...existing, fetchedAt: now.toISOString() }, cached: false };
    }
    const snapshot: Snapshot = { id, url: u.href, finalUrl: current.href, fetchedAt: now.toISOString(), contentType: res.contentType, title, text, hash };
    db.sql.prepare('INSERT INTO snapshots VALUES (@id, @url, @finalUrl, @fetchedAt, @contentType, @title, @text, @hash)').run(snapshot);
    return { snapshot, cached: false };
  }
}

/** Up to `max` places where `needle` appears in the snapshot, with surrounding text. */
export function findInText(text: string, needle: string, max = 5): string[] {
  const hay = excerptKey(text);
  const k = excerptKey(needle);
  const out: string[] = [];
  for (let i = hay.indexOf(k); i >= 0 && out.length < max; i = hay.indexOf(k, i + k.length)) {
    out.push(hay.slice(Math.max(0, i - 150), i + k.length + 150));
  }
  return out;
}
