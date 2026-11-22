import { z } from 'zod';
import { j, newId, p, type Db } from './db.js';
import { ApiError, agentId, idempotencyKey, type Ctx, type NextAction, type OpResult } from './registry.js';
import { FieldError, type RecordType } from './schema.js';
import { FIELDS, CORE, type FieldDef } from './fields.js';
import { domainOf, excerptKey, matchKey, place, similarity } from './normalize.js';
import { claimsFor, liveClaim, loadRecord, present, quality, whenText, type RecordRow } from './records.js';
import { DEFAULT_TIMEZONE, GAZETTEER } from './seed-data.js';

const EVIDENCE_MAX_AGE_DAYS = 90;
const SOURCE_KINDS = { official: 1, 'tourism-body': 2, listing: 3, other: 4 } as const;

export const submitInput = z.strictObject({
  agentId,
  idempotencyKey,
  recordType: z.enum(['event', 'property']),
  recordId: z.string().optional(),
  distinctFrom: z.array(z.string()).max(10).optional(),
  claims: z.array(z.strictObject({
    field: z.string(),
    value: z.unknown(),
    evidence: z.strictObject({
      snapshotId: z.string(),
      excerpt: z.string().min(3).max(1000),
      sourceKind: z.enum(['official', 'tourism-body', 'listing', 'other']).optional(),
    }).optional(),
  })).min(1).max(40),
  dryRun: z.boolean().optional(),
});
type Input = z.infer<typeof submitInput>;

type Evaluated = {
  index: number; field: string; raw: unknown; def?: FieldDef; ok: boolean;
  value?: unknown; notes: string[]; code?: string; message?: string;
  snapshotId?: string; excerpt?: string; sourceUrl?: string; tier: number; tierBasis: string;
  status?: string; reviewId?: string;
};

class DryRun extends Error { constructor(public out: OpResult) { super('dry run'); } }

/** Pipeline: idempotency → store raw → per claim (field check → evidence → normalise + validate → classify)
 *  → dedupe → conflicts → persist in one transaction → per-claim results. */
export function submitFindings(input: Input, ctx: Ctx): OpResult {
  const { db } = ctx;
  const now = ctx.now();
  const rawJson = j(input);

  const prev = db.sql.prepare("SELECT * FROM submissions WHERE agentId = ? AND tool = 'submit_findings' AND idempotencyKey = ?").get(input.agentId, input.idempotencyKey) as any;
  if (prev?.response) {
    if (prev.raw !== rawJson) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', `idempotencyKey "${input.idempotencyKey}" was already used for a different submission (${prev.id}). Use a new key for new content.`);
    const r = p(prev.response);
    if (r.error) throw new ApiError(r.status, r.error.code, r.error.message, { ...r.error, result: r.result, nextActions: r.nextActions });
    return { ...r, warnings: [...r.warnings, `Replayed: this idempotencyKey was already processed as ${prev.id}. Nothing new was saved.`] };
  }

  const submissionId = prev?.id ?? newId('sub');
  if (!input.dryRun && !prev) {
    db.sql.prepare("INSERT INTO submissions VALUES (?, ?, 'submit_findings', ?, ?, ?, 'received', NULL)").run(submissionId, input.agentId, input.idempotencyKey, now.toISOString(), rawJson);
  }
  const finish = (status: string, response: object) => {
    if (!input.dryRun) db.sql.prepare('UPDATE submissions SET status = ?, response = ? WHERE id = ?').run(status, j(response), submissionId);
  };

  try {
    const out = db.sql.transaction(() => process(input, ctx, submissionId, now))();
    finish('processed', { ...out, status: out.status ?? 200 });
    return out;
  } catch (e) {
    if (e instanceof DryRun) return e.out;
    if (e instanceof ApiError) {
      finish(e.code === 'POSSIBLE_DUPLICATE' ? 'needs_choice' : 'rejected', {
        status: e.status, result: e.extra.result ?? null, warnings: [], nextActions: e.extra.nextActions ?? [],
        error: { code: e.code, message: e.message, problems: e.extra.problems ?? [], suggestions: e.extra.suggestions ?? [] },
      });
    }
    throw e;
  }
}

function process(input: Input, ctx: Ctx, submissionId: string, now: Date): OpResult {
  const { db } = ctx;
  const type = input.recordType as RecordType;
  const fields = FIELDS[type];
  let record: RecordRow | undefined;
  if (input.recordId) {
    record = loadRecord(db, input.recordId);
    if (!record) throw new ApiError(404, 'RECORD_NOT_FOUND', `There is no record "${input.recordId}".`, { nextActions: [{ tool: 'search_records', why: 'Find the record id', args: { location: 'Hermanus' } }] });
    if (record.type !== type) throw new ApiError(400, 'RECORD_TYPE_MISMATCH', `${record.id} is a ${record.type}, but recordType is "${type}".`);
  }

  // Timezone comes from the town (in this submission, or the existing record).
  const townClaim = input.claims.find((c) => c.field === 'town');
  const townName = typeof townClaim?.value === 'string' ? townClaim.value : record?.data.town;
  const timezone = townName ? place(townName).timezone : DEFAULT_TIMEZONE;

  // 1. Evaluate each claim independently.
  const seen = new Set<string>();
  const evals: Evaluated[] = input.claims.map((c, index) => {
    const e: Evaluated = { index, field: c.field, raw: c.value, ok: false, notes: [], tier: 4, tierBasis: 'none' };
    const reject = (code: string, message: string) => Object.assign(e, { ok: false, code, message, status: 'rejected' });
    const def = fields[c.field];
    if (!def) return reject('UNKNOWN_FIELD', `"${c.field}" is not a ${type} field. Fields: ${Object.keys(fields).join(', ')}.`);
    e.def = def;
    if (seen.has(c.field)) return reject('DUPLICATE_FIELD', `"${c.field}" appears more than once in this submission. Send one claim per field.`);
    seen.add(c.field);
    if (c.evidence) {
      const snap = db.sql.prepare('SELECT id, url, finalUrl, fetchedAt, text FROM snapshots WHERE id = ?').get(c.evidence.snapshotId) as any;
      if (!snap) return reject('SNAPSHOT_NOT_FOUND', `Snapshot "${c.evidence.snapshotId}" doesn't exist. Call fetch_source on the page first and use the snapshotId it returns.`);
      if (!excerptKey(snap.text).includes(excerptKey(c.evidence.excerpt))) {
        return reject('EVIDENCE_EXCERPT_NOT_FOUND', `The excerpt "${c.evidence.excerpt.slice(0, 80)}" is not in snapshot ${snap.id} (${snap.url}). Copy the exact words from the page; use fetch_source with find= to locate them.`);
      }
      const ageDays = (now.getTime() - new Date(snap.fetchedAt).getTime()) / 86400000;
      if (ageDays > EVIDENCE_MAX_AGE_DAYS) return reject('EVIDENCE_STALE', `Snapshot ${snap.id} is ${Math.floor(ageDays)} days old (limit ${EVIDENCE_MAX_AGE_DAYS}). Fetch the page again.`);
      const domain = domainOf(snap.finalUrl);
      const known = db.sql.prepare('SELECT tier FROM sources WHERE domain = ?').get(domain) as any;
      Object.assign(e, {
        snapshotId: snap.id, excerpt: c.evidence.excerpt, sourceUrl: snap.finalUrl,
        tier: known ? known.tier : c.evidence.sourceKind ? SOURCE_KINDS[c.evidence.sourceKind] : 4,
        tierBasis: known ? 'source-registry' : c.evidence.sourceKind ? 'declared-by-agent' : 'unknown-source',
      });
    } else if (def.evidence !== false) {
      return reject('EVIDENCE_REQUIRED', `"${c.field}" needs evidence: { snapshotId, excerpt }. Call fetch_source on the page, then quote the exact words that support this value.`);
    }
    try {
      const nrm = def.normalize(c.value, { db, now, timezone });
      if (c.evidence) {
        const gap = unsupported(c.field, nrm.value, c.evidence.excerpt);
        if (gap) return reject('EVIDENCE_DOES_NOT_SUPPORT', `${c.field}: the excerpt "${c.evidence.excerpt.slice(0, 80)}" does not contain ${gap}. Quote the words on the page that state this value.`);
      }
      Object.assign(e, { ok: true, value: nrm.value, notes: nrm.notes ?? [] });
    } catch (err) {
      if (err instanceof FieldError) return reject(err.code, `${c.field}: ${err.message}`);
      throw err;
    }
    return e;
  });

  const good = evals.filter((e) => e.ok);
  const warnings: string[] = [];
  let mergedInto: string | undefined;

  // 2. New record: core fields, then dedupe.
  if (!record) {
    const missing = CORE[type].filter((f) => !good.some((e) => e.field === f));
    if (missing.length) {
      throw new ApiError(400, 'CORE_FIELDS_MISSING', `A new ${type} needs accepted claims for ${CORE[type].join(', ')}. Missing or rejected: ${missing.join(', ')}. Nothing was saved.`, {
        result: { claims: evals.map(claimResult) }, problems: evals.filter((e) => !e.ok).map((e) => e.message!),
        nextActions: [{ tool: 'get_instructions', why: 'See field formats for submit_findings', args: { tool: 'submit_findings' } }],
      });
    }
    const name = good.find((e) => e.field === 'name')!.value as string;
    const town = good.find((e) => e.field === 'town')!.value as string;
    const key = matchKey(name, town);
    const temporal = good.find((e) => e.field === 'temporal')?.value;
    const officialUrl = good.find((e) => e.field === 'officialUrl')?.value;
    const candidates = (db.sql.prepare('SELECT id FROM records WHERE type = ? AND lower(town) = lower(?)').all(type, town) as any[]).map((r) => loadRecord(db, r.id)!);
    const exact = candidates.find((c) => c.matchKey === key && (type === 'event' ? j(c.data.temporal) === j(temporal) : true))
      ?? (officialUrl && type === 'property' ? candidates.find((c) => c.data.officialUrl === officialUrl) : undefined);
    if (exact) {
      record = exact;
      mergedInto = exact.id;
      warnings.push(`Merged into existing ${exact.id} ("${exact.data.name}"): same name, town${type === 'event' ? ' and dates' : ''}. Your claims were applied as an update.`);
    } else {
      const possible = candidates
        .filter((c) => !input.distinctFrom?.includes(c.id))
        .map((c) => ({ c, score: c.matchKey === key ? 1 : similarity(c.matchKey, key) }))
        .filter((x) => x.score >= 0.75)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (possible.length) {
        throw new ApiError(409, 'POSSIBLE_DUPLICATE', `This may already exist: ${possible.map((x) => `${x.c.id} "${x.c.data.name}"`).join(', ')}. Nothing was saved. Resubmit with recordId to update one of them, or with distinctFrom listing them if yours is a different ${type}.`, {
          result: {
            candidates: possible.map((x) => ({
              id: x.c.id, name: x.c.data.name, town: x.c.data.town, whenText: type === 'event' ? whenText(x.c.data.temporal, x.c.data.datesConfirmed) : undefined,
              reason: x.score === 1 ? 'same name in the same town, different dates' : `similar name in the same town (similarity ${x.score.toFixed(2)})`,
            })),
          },
          nextActions: [
            { tool: 'get_record', why: 'Compare the candidate with what you found', args: { id: possible[0].c.id } },
            { tool: 'submit_findings', why: 'Same thing: update it', args: { recordId: possible[0].c.id } },
            { tool: 'submit_findings', why: 'Different thing: create it anyway', args: { distinctFrom: possible.map((x) => x.c.id) } },
          ],
        });
      }
      const id = newId(type === 'event' ? 'evt' : 'prp');
      const t = now.toISOString();
      db.sql.prepare('INSERT INTO records VALUES (?, ?, 0, ?, ?, ?, ?, ?)').run(id, type, j({}), key, town, t, t);
      record = loadRecord(db, id)!;
      if (input.distinctFrom?.length) warnings.push(`Created as distinct from ${input.distinctFrom.join(', ')}.`);
    }
  }

  // 3. Apply claims: conflicts and review routing.
  const rec = record;
  const before = j(rec.data);
  const ins = db.sql.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insert = (e: Evaluated, status: string, note?: string) => {
    const id = newId('clm');
    ins.run(id, rec.id, submissionId, input.agentId, e.field, j(e.raw), j(e.value), e.snapshotId ?? null, e.excerpt ?? null, e.sourceUrl ?? null, e.tier, e.tierBasis, status, note ?? null, now.toISOString());
    e.status = status;
    if (status === 'provisional' || status === 'pending_review') {
      e.reviewId = newId('rev');
      db.sql.prepare("INSERT INTO reviews (id, kind, refId, proposerAgentId, payload, status, createdAt) VALUES (?, 'claim', ?, ?, ?, 'pending', ?)")
        .run(e.reviewId, id, input.agentId, j({ recordId: rec.id, field: e.field }), now.toISOString());
    }
    return id;
  };

  for (const e of good) {
    const def = e.def!;
    if (def.merge) {
      const v = e.value as { tags: string[]; unmappedTags: string[] };
      rec.data.tags = [...new Set([...(rec.data.tags ?? []), ...v.tags])].sort();
      rec.data.unmappedTags = [...new Set([...(rec.data.unmappedTags ?? []), ...v.unmappedTags])].sort();
      insert(e, 'accepted');
      continue;
    }
    const current = rec.data[e.field];
    const live = liveClaim(claimsFor(db, rec.id), e.field);
    if (current === undefined) {
      rec.data[e.field] = e.value;
      insert(e, def.critical ? 'provisional' : 'accepted');
      if (e.field === 'town') {
        const g = GAZETTEER[String(e.value).toLowerCase()];
        if (g) { rec.data.region ??= g.region; rec.data.country ??= g.country; }
      }
    } else if (j(current) === j(e.value)) {
      insert(e, 'corroborating');
    } else {
      const sameSource = live?.sourceUrl && e.sourceUrl && domainOf(live.sourceUrl) === domainOf(e.sourceUrl);
      const better = e.tier < (live?.tier ?? 4) || sameSource;
      if (!better) {
        insert(e, 'contradicting', `Kept the current value (tier ${live?.tier ?? 4} source). This claim comes from a tier ${e.tier} source.`);
      } else if (def.critical) {
        insert(e, 'pending_review', 'Change to a decision-critical field: applied after another agent reviews it.');
      } else {
        rec.data[e.field] = e.value;
        if (live) db.sql.prepare("UPDATE claims SET status = 'superseded' WHERE id = ?").run(live.id);
        insert(e, 'accepted');
      }
    }
  }

  const changed = j(rec.data) !== before;
  if (changed) saveVersion(db, rec, mergedInto ? `merged submission ${submissionId}` : `submission ${submissionId}`, now);
  db.audit(input.agentId, 'submit_findings', 'record', rec.id, { submissionId, accepted: good.length, rejected: evals.length - good.length });

  const q = quality(rec, claimsFor(db, rec.id));
  const counts = (s: string) => evals.filter((e) => e.status === s).length;
  const created = rec.version === 1 && !mergedInto && !input.recordId;
  const parts = [`${counts('accepted')} accepted`, `${counts('provisional')} provisional (live, awaiting review)`, `${counts('pending_review')} pending review`, `${counts('corroborating')} corroborating`, `${counts('contradicting')} contradicting`, `${counts('rejected')} rejected`]
    .filter((s) => !s.startsWith('0 '));
  const nextActions: NextAction[] = [{ tool: 'get_record', why: 'Check what was saved, with sources', args: { id: rec.id } }];
  const rejected = evals.filter((e) => e.status === 'rejected');
  if (rejected.length) nextActions.push({ tool: 'fetch_source', why: `Fix ${rejected.length} rejected claim(s): get evidence, then resubmit them with recordId ${rec.id} and a new idempotencyKey`, args: { find: 'the exact words' } });
  if (rec.data.unmappedTags?.length) nextActions.push({ tool: 'lookup_glossary', why: `Tags not in the glossary: ${rec.data.unmappedTags.join(', ')}. Check for a matching term, or propose one with propose_glossary_change`, args: { q: rec.data.unmappedTags[0] } });
  if (q.unreviewedFields.length || counts('pending_review')) nextActions.push({ tool: 'list_pending_reviews', why: 'Decision-critical claims need a review by a different agent', args: {} });

  const out: OpResult = {
    status: created ? 201 : 200,
    result: {
      submissionId: input.dryRun ? null : submissionId,
      recordId: rec.id,
      recordVersion: rec.version,
      created,
      mergedInto: mergedInto ?? null,
      claims: evals.map(claimResult),
      ...q,
      unmappedTags: rec.data.unmappedTags ?? [],
      record: present(db, rec, 'summary'),
    },
    summary: `${created ? 'Created' : 'Updated'} ${rec.id} (v${rec.version}): ${parts.join(', ')}.`,
    warnings: [...warnings, ...evals.flatMap((e) => e.notes)],
    nextActions,
  };
  if (good.length === 0) {
    throw new ApiError(422, 'ALL_CLAIMS_REJECTED', `None of the ${evals.length} claims could be accepted. Nothing was saved.`, {
      result: { claims: evals.map(claimResult) }, problems: evals.map((e) => e.message!), nextActions: nextActions.slice(1),
    });
  }
  if (input.dryRun) throw new DryRun({ ...out, summary: `Dry run, nothing saved. Would have: ${out.summary}` });
  return out;
}

export function saveVersion(db: Db, rec: RecordRow, reason: string, now: Date) {
  rec.version += 1;
  rec.updatedAt = now.toISOString();
  if (rec.data.name && rec.data.town) { rec.town = rec.data.town; rec.matchKey = matchKey(rec.data.name, rec.data.town); }
  db.sql.prepare('UPDATE records SET version = ?, data = ?, town = ?, matchKey = ?, updatedAt = ? WHERE id = ?').run(rec.version, j(rec.data), rec.town, rec.matchKey, rec.updatedAt, rec.id);
  db.sql.prepare('INSERT INTO record_versions VALUES (?,?,?,?,?)').run(rec.id, rec.version, j(rec.data), rec.updatedAt, reason);
}

/** Deterministic support check for numbers: the excerpt must contain the day numbers of a date and the amount of a price. */
function unsupported(field: string, value: any, excerpt: string): string | null {
  const nums = new Set((excerpt.replace(/(\d)[\s,](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []).map(Number));
  if (field === 'temporal' && value?.type === 'dated') {
    const days = [value.startDate, value.endDate].filter(Boolean).map((d: string) => Number(d.slice(8, 10)));
    const missing = days.filter((d: number) => !nums.has(d));
    return missing.length ? `the day number(s) ${missing.join(', ')}` : null;
  }
  if (field === 'ticketPrice' && value?.amountMinor > 0) {
    const amount = Math.floor(value.amountMinor / 100);
    return nums.has(amount) ? null : `the amount ${amount}`;
  }
  return null;
}

const claimResult = (e: Evaluated) => ({
  index: e.index, field: e.field, status: e.status ?? (e.ok ? 'accepted' : 'rejected'),
  value: e.ok ? e.value : undefined, code: e.code, message: e.message, tier: e.snapshotId ? e.tier : undefined,
  source: e.sourceUrl, reviewId: e.reviewId, notes: e.notes.length ? e.notes : undefined,
});
