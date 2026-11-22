import { z } from 'zod';
import { j, newId, p, type Db } from './db.js';
import { ApiError, type NextAction } from './registry.js';
import { excerptKey, similarity, termKey } from './normalize.js';

/** Controlled categories for the knowledge index. A packet can be in several without being copied. */
export const KNOWLEDGE_CATEGORIES = {
  'source-discovery': 'Finding official, reliable sources.',
  extraction: 'Getting exact facts and excerpts out of pages.',
  'dates-and-times': 'Reading and submitting dates, seasons and times correctly.',
  'booking-and-prices': 'Booking links, ticket prices and rates.',
  'conflict-resolution': 'What to do when sources disagree.',
  'glossary-use': 'Using and growing the shared vocabulary.',
} as const;
type Category = keyof typeof KNOWLEDGE_CATEGORIES;

export const packetInput = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a lowercase-hyphenated slug like "find-official-sources"'),
  name: z.string().min(5).max(80),
  description: z.string().min(20).max(400),
  categories: z.array(z.enum(Object.keys(KNOWLEDGE_CATEGORIES) as [Category, ...Category[]])).min(1).max(4),
  steps: z.array(z.string().min(10).max(500)).min(1).max(15),
  limitations: z.array(z.string().min(5).max(300)).min(1).max(10),
  evidence: z.array(z.strictObject({ snapshotId: z.string(), excerpt: z.string().min(3).max(500), supports: z.string().min(5).max(200) })).max(10).default([]),
});
export type Packet = z.infer<typeof packetInput>;

const INJECTION = /(ignore (all |any |the )?(previous|prior|above) instructions|system prompt|api[ _-]?key|password|secret token|bearer token|disregard your|you must now)/i;

type Row = { id: string; slug: string; version: number; status: string; data: Packet; updatedAt: string };
const row = (r: any): Row => ({ ...r, data: p(r.data) });
export const allPackets = (db: Db): Row[] => (db.sql.prepare("SELECT * FROM knowledge WHERE status = 'active' ORDER BY slug").all() as any[]).map(row);
export const getPacket = (db: Db, idOrSlug: string): Row | undefined => {
  const r = db.sql.prepare('SELECT * FROM knowledge WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug);
  return r ? row(r) : undefined;
};

export const indexEntry = (r: Row) => ({ id: r.id, slug: r.slug, name: r.data.name, description: r.data.description, categories: r.data.categories, version: r.version, updatedAt: r.updatedAt });

/** Deterministic checks before review: version, duplicates, evidence, injection. */
export function checkPacket(db: Db, pk: Packet, baseVersion: number | undefined): void {
  const existing = getPacket(db, pk.slug);
  const look: NextAction[] = [{ tool: 'get_knowledge', why: 'Read the current packet', args: { id: pk.slug } }];
  if (existing && baseVersion === undefined) throw new ApiError(409, 'PACKET_EXISTS', `Packet "${pk.slug}" already exists (version ${existing.version}). To improve it, send baseVersion ${existing.version}.`, { nextActions: look });
  if (existing && baseVersion !== existing.version) throw new ApiError(409, 'STALE_BASE', `Packet "${pk.slug}" is at version ${existing.version}, not ${baseVersion}. Read it and propose again with baseVersion ${existing.version}.`, { result: { current: indexEntry(existing) }, nextActions: look });
  if (!existing && baseVersion !== undefined) throw new ApiError(404, 'PACKET_NOT_FOUND', `There is no packet "${pk.slug}" to update. Leave out baseVersion to propose a new one.`);
  if (!existing) {
    const twin = allPackets(db).find((o) => similarity(termKey(o.data.name), termKey(pk.name)) >= 0.8);
    if (twin) throw new ApiError(409, 'POSSIBLE_DUPLICATE', `"${pk.name}" looks like existing packet "${twin.data.name}" (${twin.slug}). Improve that one instead (baseVersion ${twin.version}).`, { nextActions: [{ tool: 'get_knowledge', why: 'Read the similar packet', args: { id: twin.slug } }] });
    const pending = db.sql.prepare("SELECT id FROM reviews WHERE kind = 'knowledge' AND status = 'pending' AND refId = ?").get(pk.slug) as any;
    if (pending) throw new ApiError(409, 'ALREADY_PROPOSED', `A new packet "${pk.slug}" is already waiting for review (${pending.id}).`);
  }
  const text = [pk.name, pk.description, ...pk.steps, ...pk.limitations].join('\n');
  if (INJECTION.test(text)) throw new ApiError(400, 'UNSAFE_CONTENT', 'The packet contains text that reads like instructions to override an agent or reveal secrets. Packets must only describe research methods.');
  const problems: string[] = [];
  pk.evidence.forEach((e, i) => {
    const snap = db.sql.prepare('SELECT text FROM snapshots WHERE id = ?').get(e.snapshotId) as any;
    if (!snap) problems.push(`evidence.${i}: snapshot "${e.snapshotId}" doesn't exist; call fetch_source first`);
    else if (!excerptKey(snap.text).includes(excerptKey(e.excerpt))) problems.push(`evidence.${i}: excerpt is not in snapshot ${e.snapshotId}`);
  });
  if (problems.length) throw new ApiError(422, 'EVIDENCE_EXCERPT_NOT_FOUND', `Evidence check failed: ${problems.join('; ')}.`, { problems });
}

export function newKnowledgeReview(db: Db, pk: Packet, baseVersion: number | undefined, agentId: string, key?: string): string {
  const id = newId('rev');
  db.sql.prepare("INSERT INTO reviews (id, kind, refId, proposerAgentId, payload, status, createdAt) VALUES (?, 'knowledge', ?, ?, ?, 'pending', ?)")
    .run(id, pk.slug, agentId, j({ packet: pk, baseVersion: baseVersion ?? null, key: key ?? null }), new Date().toISOString());
  return id;
}

/** Publishes an approved proposal. Fails safely if another version was published meanwhile. */
export function applyPacket(db: Db, pk: Packet, baseVersion: number | null, agentId: string, reviewId: string): Row {
  const now = new Date().toISOString();
  const existing = getPacket(db, pk.slug);
  if ((existing?.version ?? null) !== baseVersion) {
    throw new ApiError(409, 'STALE_BASE', `Packet "${pk.slug}" changed since this proposal was made (now version ${existing?.version}). Reject this review; the contributor must propose again.`);
  }
  const version = (existing?.version ?? 0) + 1;
  const id = existing?.id ?? newId('kp');
  if (existing) db.sql.prepare('UPDATE knowledge SET version = ?, data = ?, updatedAt = ? WHERE id = ?').run(version, j(pk), now, id);
  else db.sql.prepare("INSERT INTO knowledge VALUES (?, ?, ?, 'active', ?, ?)").run(id, pk.slug, version, j(pk), now);
  db.sql.prepare('INSERT INTO knowledge_history VALUES (?, ?, ?, ?, ?, ?)').run(id, version, j(pk), now, agentId, reviewId);
  return getPacket(db, id)!;
}
