import { z } from 'zod';
import { p, type Db } from './db.js';
import { ApiError, agentId, type Ctx, type OpResult } from './registry.js';
import { applyChange, getEntry, resolveOne, type GlossaryChange } from './glossary.js';
import { claimsFor, liveClaim, loadRecord, type ClaimRow } from './records.js';
import { applyPacket, getPacket } from './knowledge.js';
import { organisationOf } from './auth.js';
import { saveVersion } from './pipeline.js';

export const listInput = z.strictObject({ agentId, kind: z.enum(['claim', 'glossary', 'knowledge']).optional(), limit: z.number().int().min(1).max(20).optional() });

/** Pending items this agent may review (never its own). Reviewers see the evidence, not who proposed it. */
export function listPendingReviews(input: z.infer<typeof listInput>, ctx: Ctx): OpResult {
  const org = organisationOf(ctx.db, input.agentId) ?? '';
  const rows = ctx.db.sql.prepare(`SELECT r.* FROM reviews r LEFT JOIN agents a ON a.id = r.proposerAgentId
    WHERE r.status = 'pending' AND r.proposerAgentId != ? AND lower(coalesce(a.organisation, '')) != lower(?) ${input.kind ? 'AND r.kind = ?' : ''} ORDER BY r.createdAt LIMIT ?`)
    .all(...[input.agentId, org, ...(input.kind ? [input.kind] : []), input.limit ?? 10]) as any[];
  const items = rows.map((r) => describe(ctx.db, r)).filter(Boolean);
  return {
    result: { reviews: items },
    summary: items.length ? `${items.length} item(s) waiting for an independent review.` : 'Nothing is waiting for your review.',
    nextActions: items.length
      ? [{ tool: 'submit_review', why: 'Check the evidence yourself, then approve or reject', args: { reviewId: (items[0] as any).reviewId } }]
      : [],
  };
}

function describe(db: Db, r: any) {
  const base = { reviewId: r.id, kind: r.kind, createdAt: r.createdAt };
  if (r.kind === 'knowledge') {
    const { packet, baseVersion } = p(r.payload);
    const current = getPacket(db, packet.slug);
    return { ...base, proposedPacket: packet, baseVersion, currentPacket: current ? current.data : null,
      howToCheck: 'Try the steps yourself on a real case. Are they correct, specific, and safe? Does each evidence excerpt support what it claims? Reject anything guessed, outdated, or that tells agents to do more than research.' };
  }
  if (r.kind === 'glossary') {
    const c = p(r.payload).change as GlossaryChange;
    return { ...base, change: c, currentEntry: c.kind === 'add_term' ? null : getEntry(db, c.term) ?? null,
      howToCheck: 'Is the definition accurate and neutral? Does each synonym really mean the same thing as the term, in this domain? Would it mis-tag existing data?' };
  }
  const c = db.sql.prepare('SELECT * FROM claims WHERE id = ?').get(r.refId) as any;
  if (!c) return null;
  const rec = loadRecord(db, c.recordId)!;
  const snap = c.snapshotId ? (db.sql.prepare('SELECT text, url, fetchedAt FROM snapshots WHERE id = ?').get(c.snapshotId) as any) : null;
  return {
    ...base,
    record: { id: rec.id, type: rec.type, name: rec.data.name, town: rec.data.town },
    field: c.field,
    currentValue: c.status === 'pending_review' ? rec.data[c.field] ?? null : null,
    proposedValue: p(c.canonical),
    rawValue: p(c.raw),
    situation: c.status === 'provisional' ? 'First value for this field. It is live now and is removed if you reject it.' : 'Change to an existing value. It is applied only if you approve it.',
    evidence: { sourceUrl: c.sourceUrl, tier: c.tier, excerpt: c.excerpt, snapshotId: c.snapshotId, fetchedAt: snap?.fetchedAt },
    howToCheck: 'Fetch the source yourself with fetch_source and fresh=true (the live page may have changed). Confirm the excerpt supports this exact value, that it refers to this event or property, and that the source is the right one to trust. Reject if anything is guessed or does not match.',
  };
}

export const submitReviewInput = z.strictObject({
  agentId,
  reviewId: z.string(),
  decision: z.enum(['approve', 'reject']),
  checksPerformed: z.string().min(30).max(2000).describe('What you checked and how, e.g. "Fetched the organiser page again; it still says 24 June - 4 July 2027; dates match the proposed value."'),
  reason: z.string().min(10).max(1000).optional(),
});

export function submitReview(input: z.infer<typeof submitReviewInput>, ctx: Ctx): OpResult {
  const { db } = ctx;
  const now = ctx.now();
  const r = db.sql.prepare('SELECT * FROM reviews WHERE id = ?').get(input.reviewId) as any;
  if (!r) throw new ApiError(404, 'REVIEW_NOT_FOUND', `There is no review "${input.reviewId}".`, { nextActions: [{ tool: 'list_pending_reviews', why: 'See what you can review', args: {} }] });
  if (r.status !== 'pending') throw new ApiError(409, 'REVIEW_ALREADY_DECIDED', `Review ${r.id} was already ${r.status} by another agent.`, { nextActions: [{ tool: 'list_pending_reviews', why: 'Pick another item', args: {} }] });
  if (r.proposerAgentId === input.agentId) throw new ApiError(403, 'SELF_REVIEW', 'You proposed this item, so you cannot review it. A different agent must review it.', { nextActions: [{ tool: 'list_pending_reviews', why: 'Review other agents\' work instead', args: {} }] });
  const myOrg = organisationOf(db, input.agentId);
  if (myOrg && myOrg.toLowerCase() === organisationOf(db, r.proposerAgentId)?.toLowerCase()) {
    throw new ApiError(403, 'SAME_ORGANISATION', `This item came from your own organisation (${myOrg}). An agent from a different organisation must review it.`, { nextActions: [{ tool: 'list_pending_reviews', why: 'Review other organisations\' work', args: {} }] });
  }
  if (input.decision === 'reject' && !input.reason) throw new ApiError(400, 'REASON_REQUIRED', 'Rejecting needs a reason (at least 10 characters) so the contributor can fix it.');

  let summary = '';
  db.sql.transaction(() => {
    db.sql.prepare("UPDATE reviews SET status = ?, reviewerAgentId = ?, checksPerformed = ?, reason = ?, decidedAt = ? WHERE id = ?")
      .run(input.decision === 'approve' ? 'approved' : 'rejected', input.agentId, input.checksPerformed, input.reason ?? null, now.toISOString(), r.id);
    if (r.kind === 'knowledge') {
      const { packet, baseVersion } = p(r.payload);
      if (input.decision === 'approve') {
        const pk = applyPacket(db, packet, baseVersion, r.proposerAgentId, r.id);
        summary = `Approved. Knowledge packet "${pk.slug}" is now version ${pk.version}.`;
      } else summary = 'Rejected. The knowledge base is unchanged.';
    } else if (r.kind === 'glossary') {
      const change = p(r.payload).change as GlossaryChange;
      if (input.decision === 'approve') {
        const term = applyChange(db, change, r.proposerAgentId, r.id);
        const retagged = retag(db, now);
        summary = `Approved. Glossary term "${term}" ${change.kind === 'add_term' ? 'added' : change.kind === 'deprecate' ? 'deprecated' : 'updated'}; ${retagged} record(s) re-tagged.`;
      } else summary = 'Rejected. The glossary is unchanged.';
    } else {
      summary = decideClaim(db, r.refId, input.decision, now);
    }
    db.audit(input.agentId, `review_${input.decision}`, r.kind, r.id, { checksPerformed: input.checksPerformed, reason: input.reason });
  })();
  return { result: { reviewId: r.id, decision: input.decision }, summary, nextActions: [{ tool: 'list_pending_reviews', why: 'Review the next item', args: {} }] };
}

function decideClaim(db: Db, claimId: string, decision: 'approve' | 'reject', now: Date): string {
  const c = db.sql.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) as any;
  const rec = loadRecord(db, c.recordId)!;
  const value = p(c.canonical);
  if (decision === 'approve') {
    if (c.status === 'pending_review') {
      const live = liveClaim(claimsFor(db, rec.id), c.field);
      if (live) db.sql.prepare("UPDATE claims SET status = 'superseded' WHERE id = ?").run(live.id);
      rec.data[c.field] = value;
      saveVersion(db, rec, `review approved claim ${c.id}`, now);
    }
    db.sql.prepare("UPDATE claims SET status = 'accepted' WHERE id = ?").run(c.id);
    return `Approved. ${rec.id} ${c.field} is now reviewed.`;
  }
  db.sql.prepare("UPDATE claims SET status = 'rejected', note = 'rejected in review' WHERE id = ?").run(c.id);
  if (c.status === 'provisional') {
    // Fall back to the latest earlier accepted claim, else remove the value.
    const prior = [...claimsFor(db, rec.id)].reverse().find((x: ClaimRow) => x.field === c.field && x.status === 'superseded');
    if (prior) { db.sql.prepare("UPDATE claims SET status = 'accepted' WHERE id = ?").run(prior.id); rec.data[c.field] = prior.canonical; }
    else delete rec.data[c.field];
    saveVersion(db, rec, `review rejected claim ${c.id}`, now);
    return `Rejected. The provisional ${c.field} was removed from ${rec.id}.`;
  }
  return `Rejected. ${rec.id} ${c.field} keeps its current value.`;
}

/** After a glossary change, maps previously unknown tags that the glossary now knows. Raw tags were kept, so nothing is lost. */
function retag(db: Db, now: Date): number {
  let n = 0;
  const rows = db.sql.prepare("SELECT id FROM records WHERE data LIKE '%unmappedTags%'").all() as any[];
  for (const { id } of rows) {
    const rec = loadRecord(db, id)!;
    const unmapped: string[] = rec.data.unmappedTags ?? [];
    if (!unmapped.length) continue;
    const still: string[] = [];
    const tags = new Set<string>(rec.data.tags ?? []);
    for (const w of unmapped) { const t = resolveOne(db, w, 'interest'); t ? tags.add(t) : still.push(w); }
    if (still.length === unmapped.length) continue;
    rec.data.tags = [...tags].sort();
    rec.data.unmappedTags = still;
    saveVersion(db, rec, `glossary v${db.glossaryVersion()} re-tag`, now);
    n++;
  }
  return n;
}
