import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { SEED_GLOSSARY, SEED_PACKETS, SEED_SOURCES } from './seed-data.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (domain TEXT PRIMARY KEY, tier INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, finalUrl TEXT NOT NULL, fetchedAt TEXT NOT NULL,
  contentType TEXT, title TEXT, text TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, tool TEXT NOT NULL, idempotencyKey TEXT NOT NULL,
  receivedAt TEXT NOT NULL, raw TEXT NOT NULL, status TEXT NOT NULL, response TEXT,
  UNIQUE (agentId, tool, idempotencyKey));
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
  matchKey TEXT NOT NULL, town TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS record_versions (
  recordId TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY (recordId, version));
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, recordId TEXT NOT NULL, submissionId TEXT NOT NULL, agentId TEXT NOT NULL, field TEXT NOT NULL,
  raw TEXT, canonical TEXT, snapshotId TEXT, excerpt TEXT, sourceUrl TEXT, tier INTEGER NOT NULL, tierBasis TEXT NOT NULL,
  status TEXT NOT NULL, note TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rates (
  id TEXT PRIMARY KEY, propertyId TEXT NOT NULL, submissionId TEXT NOT NULL, agentId TEXT NOT NULL, data TEXT NOT NULL,
  dedupeKey TEXT NOT NULL, observedAt TEXT NOT NULL, validUntil TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS glossary (
  term TEXT PRIMARY KEY, label TEXT NOT NULL, definition TEXT NOT NULL, domain TEXT NOT NULL, synonyms TEXT NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL, replacedBy TEXT, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS glossary_history (
  term TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, agentId TEXT NOT NULL, reviewId TEXT,
  PRIMARY KEY (term, version));
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, refId TEXT, proposerAgentId TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, reviewerAgentId TEXT, checksPerformed TEXT, reason TEXT, createdAt TEXT NOT NULL, decidedAt TEXT);
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_history (
  id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, agentId TEXT NOT NULL, reviewId TEXT,
  PRIMARY KEY (id, version));
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, organisation TEXT NOT NULL, contact TEXT, keyHash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agentId TEXT NOT NULL, action TEXT NOT NULL,
  entity TEXT NOT NULL, entityId TEXT NOT NULL, detail TEXT);
`;

export type Db = ReturnType<typeof createDb>;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const j = (v: unknown) => JSON.stringify(v);
export const p = (s: string | null | undefined) => (s == null ? null : JSON.parse(s));

export function createDb(path: string) {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.pragma('busy_timeout = 5000'); // the HTTP server and a stdio MCP process can share one file
  sql.exec(SCHEMA);

  const now = new Date().toISOString();
  if (!sql.prepare('SELECT 1 FROM glossary LIMIT 1').get()) {
    const ins = sql.prepare('INSERT INTO glossary VALUES (?,?,?,?,?,1,?,NULL,?)');
    const hist = sql.prepare('INSERT INTO glossary_history VALUES (?,1,?,?,?,NULL)');
    sql.transaction(() => {
      for (const g of SEED_GLOSSARY) {
        ins.run(g.term, g.label, g.definition, g.domain, j(g.synonyms), 'active', now);
        hist.run(g.term, j(g), now, 'platform-seed');
      }
      sql.prepare("INSERT OR REPLACE INTO meta VALUES ('glossaryVersion', '1')").run();
    })();
  }
  if (!sql.prepare('SELECT 1 FROM knowledge LIMIT 1').get()) {
    for (const [i, pk] of SEED_PACKETS.entries()) {
      const id = `kp_seed${i + 1}`;
      sql.prepare("INSERT INTO knowledge VALUES (?, ?, 1, 'active', ?, ?)").run(id, pk.slug, j(pk), now);
      sql.prepare('INSERT INTO knowledge_history VALUES (?, 1, ?, ?, ?, NULL)').run(id, j(pk), now, 'platform-seed');
    }
  }
  // Retention: page snapshots nothing refers to are deleted after 30 days. Referenced ones are kept as evidence.
  sql.prepare(`DELETE FROM snapshots WHERE fetchedAt < ?
    AND id NOT IN (SELECT snapshotId FROM claims WHERE snapshotId IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM rates WHERE instr(rates.data, snapshots.id) > 0)
    AND NOT EXISTS (SELECT 1 FROM knowledge WHERE instr(knowledge.data, snapshots.id) > 0)
    AND NOT EXISTS (SELECT 1 FROM reviews WHERE instr(reviews.payload, snapshots.id) > 0)`)
    .run(new Date(Date.now() - 30 * 86400000).toISOString());
  const src = sql.prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?,?)');
  for (const s of SEED_SOURCES) src.run(s.domain, s.tier, s.kind, s.note);

  return {
    sql,
    glossaryVersion(): number {
      const row = sql.prepare("SELECT value FROM meta WHERE key = 'glossaryVersion'").get() as any;
      return row ? Number(row.value) : 0;
    },
    bumpGlossaryVersion() {
      sql.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'glossaryVersion'").run();
    },
    audit(agentId: string, action: string, entity: string, entityId: string, detail?: unknown) {
      sql.prepare('INSERT INTO audit (at, agentId, action, entity, entityId, detail) VALUES (?,?,?,?,?,?)')
        .run(new Date().toISOString(), agentId, action, entity, entityId, detail === undefined ? null : j(detail));
    },
  };
}
