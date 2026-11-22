import { z } from 'zod';
import { j, newId, p, type Db } from './db.js';
import { ApiError } from './registry.js';
import { termKey } from './normalize.js';
import { GLOSSARY_DOMAINS, type GlossaryDomain } from './seed-data.js';

export type Entry = {
  term: string; label: string; definition: string; domain: GlossaryDomain; synonyms: string[];
  version: number; status: 'active' | 'deprecated'; replacedBy: string | null; updatedAt: string;
};

const row = (r: any): Entry => ({ ...r, synonyms: p(r.synonyms) });
export const allEntries = (db: Db): Entry[] => (db.sql.prepare('SELECT * FROM glossary ORDER BY domain, term').all() as any[]).map(row);
export const getEntry = (db: Db, term: string): Entry | undefined => {
  const r = db.sql.prepare('SELECT * FROM glossary WHERE term = ?').get(term);
  return r ? row(r) : undefined;
};

/** Resolves a word to a glossary entry by term or synonym. Deprecated terms redirect to their replacement. */
export function resolve(db: Db, word: string, domain?: string): { entry: Entry; via: 'term' | 'synonym' | 'replacement' }[] {
  const k = termKey(word);
  const out: { entry: Entry; via: 'term' | 'synonym' | 'replacement' }[] = [];
  for (const e of allEntries(db)) {
    if (domain && e.domain !== domain) continue;
    const via = termKey(e.term) === k || termKey(e.label) === k ? 'term' : e.synonyms.some((s) => termKey(s) === k) ? 'synonym' : null;
    if (!via) continue;
    if (e.status === 'deprecated' && e.replacedBy) {
      const rep = getEntry(db, e.replacedBy);
      if (rep) { out.push({ entry: rep, via: 'replacement' }); continue; }
    }
    out.push({ entry: e, via });
  }
  return out;
}

/** Resolves to one canonical term in a domain, or null if the glossary doesn't know the word. */
export const resolveOne = (db: Db, word: string, domain: GlossaryDomain) => resolve(db, word, domain)[0]?.entry.term ?? null;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a lowercase-hyphenated slug like "whale-watching"');
const domain = z.enum(Object.keys(GLOSSARY_DOMAINS) as [GlossaryDomain, ...GlossaryDomain[]]);
const reason = z.string().min(10).max(500);

export const glossaryChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('add_term'), term: slug, label: z.string().min(2).max(80), definition: z.string().min(10).max(500), domain, synonyms: z.array(z.string().min(1).max(60)).max(20).default([]), reason }),
  z.strictObject({ kind: z.literal('add_synonym'), term: slug, synonym: z.string().min(1).max(60), reason }),
  z.strictObject({ kind: z.literal('edit_definition'), term: slug, baseVersion: z.number().int(), definition: z.string().min(10).max(500), reason }),
  z.strictObject({ kind: z.literal('deprecate'), term: slug, baseVersion: z.number().int(), replacement: slug.optional(), reason }),
]);
export type GlossaryChange = z.infer<typeof glossaryChange>;

/** Every word (term, label, synonym) already used in a domain, by lookup key → owning term. Includes pending proposals. */
function usedWords(db: Db, d: string): Map<string, string> {
  const used = new Map<string, string>();
  for (const e of allEntries(db).filter((e) => e.domain === d)) {
    for (const w of [e.term, e.label, ...e.synonyms]) used.set(termKey(w), e.term);
  }
  const pending = db.sql.prepare("SELECT id, payload FROM reviews WHERE kind = 'glossary' AND status = 'pending'").all() as any[];
  for (const r of pending) {
    const c = p(r.payload).change as GlossaryChange;
    const cd = c.kind === 'add_term' ? c.domain : getEntry(db, c.term)?.domain;
    if (cd !== d) continue;
    const words = c.kind === 'add_term' ? [c.term, c.label, ...c.synonyms] : c.kind === 'add_synonym' ? [c.synonym] : [];
    for (const w of words) used.set(termKey(w), `${c.kind === 'add_term' ? c.term : c.term} (pending review ${r.id})`);
  }
  return used;
}

/** Deterministic checks. Throws ApiError with a fix if the change can't be accepted for review. */
export function checkChange(db: Db, c: GlossaryChange): void {
  const lookupNext = (term: string) => [{ tool: 'lookup_glossary', why: 'See the current entry', args: { term } }];
  if (c.kind === 'add_term') {
    if (getEntry(db, c.term)) throw new ApiError(409, 'TERM_EXISTS', `The term "${c.term}" already exists. Propose add_synonym or edit_definition instead.`, { nextActions: lookupNext(c.term) });
    const used = usedWords(db, c.domain);
    for (const w of [c.term, c.label, ...c.synonyms]) {
      const owner = used.get(termKey(w));
      if (owner) throw new ApiError(409, 'SYNONYM_CONFLICT', `"${w}" already belongs to ${owner} in domain ${c.domain}. One word can map to only one term per domain.`, {
        suggestions: [`Add your synonyms to ${owner} instead, or remove "${w}" from this proposal`], nextActions: lookupNext(owner.split(' ')[0]),
      });
    }
    return;
  }
  const e = getEntry(db, c.term);
  if (!e) throw new ApiError(404, 'TERM_NOT_FOUND', `There is no glossary term "${c.term}".`, { nextActions: [{ tool: 'lookup_glossary', why: 'Search for the right term', args: { q: c.term } }] });
  if (c.kind === 'add_synonym') {
    const owner = usedWords(db, e.domain).get(termKey(c.synonym));
    if (owner) throw new ApiError(409, 'SYNONYM_CONFLICT', `"${c.synonym}" already belongs to ${owner} in domain ${e.domain}.`, { nextActions: lookupNext(owner.split(' ')[0]) });
    return;
  }
  if (c.baseVersion !== e.version) {
    throw new ApiError(409, 'STALE_BASE', `"${c.term}" is at version ${e.version}, not ${c.baseVersion}. Read the current entry and propose again with baseVersion ${e.version}.`, { result: { current: e }, nextActions: lookupNext(c.term) });
  }
  if (c.kind === 'deprecate' && c.replacement) {
    const rep = getEntry(db, c.replacement);
    if (!rep || rep.domain !== e.domain || rep.status !== 'active') throw new ApiError(400, 'REPLACEMENT_INVALID', `replacement "${c.replacement}" must be an active term in domain ${e.domain}.`);
  }
}

/** Applies an approved change. Returns the term that changed. Caller runs this inside a transaction. */
export function applyChange(db: Db, c: GlossaryChange, agentId: string, reviewId: string | null): string {
  const now = new Date().toISOString();
  let e: Entry;
  if (c.kind === 'add_term') {
    e = { term: c.term, label: c.label, definition: c.definition, domain: c.domain, synonyms: c.synonyms, version: 1, status: 'active', replacedBy: null, updatedAt: now };
    db.sql.prepare('INSERT INTO glossary VALUES (?,?,?,?,?,?,?,?,?)').run(e.term, e.label, e.definition, e.domain, j(e.synonyms), 1, 'active', null, now);
  } else {
    e = getEntry(db, c.term)!;
    if (c.kind === 'add_synonym') e.synonyms = [...e.synonyms, c.synonym];
    if (c.kind === 'edit_definition') e.definition = c.definition;
    if (c.kind === 'deprecate') { e.status = 'deprecated'; e.replacedBy = c.replacement ?? null; }
    e.version += 1;
    e.updatedAt = now;
    db.sql.prepare('UPDATE glossary SET definition=?, synonyms=?, version=?, status=?, replacedBy=?, updatedAt=? WHERE term=?')
      .run(e.definition, j(e.synonyms), e.version, e.status, e.replacedBy, now, e.term);
  }
  db.sql.prepare('INSERT INTO glossary_history VALUES (?,?,?,?,?,?)').run(e.term, e.version, j(e), now, agentId, reviewId);
  db.bumpGlossaryVersion();
  return e.term;
}

export function newGlossaryReview(db: Db, c: GlossaryChange, agentId: string, key?: string): string {
  const id = newId('rev');
  db.sql.prepare("INSERT INTO reviews (id, kind, refId, proposerAgentId, payload, status, createdAt) VALUES (?, 'glossary', ?, ?, ?, 'pending', ?)")
    .run(id, c.term, agentId, j({ change: c, key: key ?? null }), new Date().toISOString());
  return id;
}
