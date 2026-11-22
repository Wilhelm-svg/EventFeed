# EventFeed API design

Status: plan only. Nothing is implemented. This builds on design v4 (roles, verification, accommodation rules, glossary and knowledge index) and covers the API itself: operations, contracts, the ingestion pipeline, update semantics, errors, and how the API looks through MCP and REST.

**Goal:** an AI agent, built on any model, connects and finds the tools. It reads the instructions, then gets data, uploads data, updates records, and reads and updates the glossary and knowledge base, all without a custom integration.

---

## 1. Critique before the plan

| Point in the request | Concern | Recommendation |
|---|---|---|
| Pipeline order "normalise, validate, deduplicate, classify, persist" | Validation is needed twice. Garbage has to be rejected *before* normalisation, and values have to be checked for meaning *after* it: you can't check that end ≥ start until both dates are parsed. Deduplication also depends on classification, because the match keys differ by entity type and use normalised tags and place names. | Order: **receive → validate structure → normalise → validate meaning → classify → check evidence → deduplicate → detect conflicts → persist** (§4). |
| "Persistence" as the last step | If processing crashes, the agent's original submission is lost. | Store the raw submission **first**, in its own transaction, and process it afterwards. The raw record is never modified. |
| "Update some records" | A direct overwrite destroys provenance, and two agents updating the same field would collide. | An update is a **new claim on an existing record**. Fields that aren't decision-critical change at once. Decision-critical fields show up as `pendingChanges` until review passes. To the agent this behaves like an update, and the full history is kept. |
| Deleting records | Not requested. A delete would destroy provenance and is easy to abuse. | No delete. A record is retired by a claim with evidence: `status: cancelled`, `ended` or `closed`, or a `dispute` of a wrong value. |
| "Update the glossary" | A wrong synonym would silently re-tag data across the whole database. | Glossary changes are proposals. Deterministic conflict checks run immediately, and one peer review follows. Once published, affected records are re-normalised from their raw values. |
| Agent-friendly vs strict | Asking agents to send perfect canonical data would break weaker models. | Accept raw values plus the agent's proposed interpretation. The platform produces the canonical value. If the two differ, the response warns the agent rather than rejecting the submission. |
| MCP and headers | An agent working through MCP can't set HTTP headers such as `Idempotency-Key` or `If-Match`. | Every control value, including idempotency keys and base versions, is a **normal argument**. REST also accepts the header forms. |
| No limits or paging (one of the prototype's blind-test findings) | Results grow large enough to blow the agent's context. | Cursor paging, a small default page size, and a `detail: summary|full` option. |

---

## 2. Principles

1. **One operation registry.** Each operation is defined once: its name, its purpose described for agents, input and output schemas, examples, errors, scope and `nextActions` rules. REST routes, OpenAPI, the MCP tools, the reference instructions and the contract tests are all generated from that one definition.
2. **The interface is designed around tasks, not tables.** Tools match what an agent is trying to do ("submit findings", "look up a term"), not the database structure.
3. **The pipeline is deterministic and synchronous.** An agent learns the outcome of every claim in the same call. Only peer review is asynchronous.
4. **Original data is never lost.** Raw input, the agent's proposal, and the platform's canonical value are stored side by side for every field.
5. **Every response explains itself.** Each one has `summary`, `warnings` and `nextActions`. Errors carry a stable `code` for branching plus a plain `message`, `problems`, `suggestions` and `validExample`.
6. **Writes are safe to retry.** Every write takes an `idempotencyKey`. Any write can be sent with `dryRun: true`, which runs the whole pipeline without saving anything.

---

## 3. Operations

### 3.1 Tool catalogue (15 tools; MCP name = REST operation)

| Tool | REST | Scope | MCP annotations¹ |
|---|---|---|---|
| `get_instructions` | `GET /api/instructions/{topic?}` | none | read-only |
| `search_records` | `GET /api/records/search` | read | read-only |
| `get_record` | `GET /api/records/{id}` | read | read-only |
| `fetch_source` | `POST /api/sources/fetch` | read | idempotent |
| `submit_findings` | `POST /api/submissions` | submit | idempotent (key) |
| `get_next_task` | `POST /api/tasks/next` | read | |
| `complete_task` | `POST /api/tasks/{id}/complete` | submit | idempotent (key) |
| `lookup_glossary` | `GET /api/glossary` | read | read-only |
| `propose_glossary_change` | `POST /api/glossary/proposals` | contribute | idempotent (key) |
| `browse_knowledge` | `GET /api/knowledge` | read | read-only |
| `search_knowledge` | `GET /api/knowledge/search` | read | read-only |
| `get_knowledge` | `GET /api/knowledge/{id}` | read | read-only |
| `propose_knowledge` | `POST /api/knowledge/proposals` | contribute | idempotent (key) |
| `submit_verification` | `POST /api/verifications` | contribute / review | idempotent (key) |
| `my_work` | `GET /api/me/work` | read | read-only |

¹ MCP tool annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint: false` everywhere) let hosts auto-approve safe calls. Check them against the current MCP spec revision when building.

**How the requested capabilities map to tools:**

| Agent wants to | Tool |
|---|---|
| Get data | `search_records`, `get_record` |
| Upload data | `fetch_source` (evidence), then `submit_findings` |
| Update records | `submit_findings` with `recordId` |
| Get the glossary | `lookup_glossary` |
| Update the glossary | `propose_glossary_change` |
| Use and maintain the knowledge base | `browse_knowledge`, `search_knowledge`, `get_knowledge`, `propose_knowledge` |
| Track everything | `my_work` |

### 3.2 Response envelope (all operations)

```ts
{
  ok: boolean,
  result: object | null,
  summary: string,                 // one sentence
  warnings: string[],
  error?: {
    code: string,                  // stable, e.g. "EVIDENCE_EXCERPT_NOT_FOUND"
    message: string,               // plain language
    problems: string[],            // one sentence per field
    suggestions: string[],
    validExample?: object
  },
  nextActions: { tool: string, why: string, args: object }[],
  page?: { cursor: string | null, hasMore: boolean },
  meta: { apiVersion, instructionsVersion, glossaryVersion, requestId }
}
```

- **Over MCP:** the envelope is returned as structured content, with `summary` as its text. Errors are returned as a tool result marked `isError`, not as protocol errors, so the model sees the error and can fix the call itself.
- **Over REST:** the same body, with the matching HTTP status (§7).

---

## 4. Ingestion pipeline (`submit_findings`)

```
 receive ──► 1 store raw ──► 2 validate structure ──► 3 normalise ──► 4 validate meaning
         ──► 5 classify ──► 6 check evidence (3a) ──► 7 deduplicate ──► 8 detect conflicts
         ──► 9 persist (one transaction) ──► 10 respond (per-claim results + nextActions)
                                          └─► async: peer review for decision-critical claims
```

| # | Stage | What it does | Failure result |
|---|---|---|---|
| 1 | **Store raw** | Saves the payload as received, together with agent, organisation, task, idempotency key and timestamp. Never changed afterwards. A repeated idempotency key returns the original response. | (always succeeds) |
| 2 | **Validate structure** | Checks the payload's shape: known entity type, claims array present, evidence references well formed, no unknown top-level fields. | Whole submission rejected, `400 STRUCTURE_INVALID` |
| 3 | **Normalise** | Produces canonical values from the raw and proposed values (§5). Records what it changed in `normalizationNotes`. | That claim is rejected, `CLAIM_UNPARSEABLE` |
| 4 | **Validate meaning** | Checks values against each other and against reality: real calendar dates, end ≥ start, months 1–12, sensible amounts, positive occupancy, no future `observedAt`, accommodation rules (public rates only, no personal data). | That claim is rejected with a field message |
| 5 | **Classify** | Applies deterministic labels (§6): entity and temporal type, glossary tags, source tier, whether the field is decision-critical, whether review is needed, and expiry. | Unmapped tags are kept raw and flagged; the claim is not rejected |
| 6 | **Check evidence (3a)** | Confirms that each claim's `snapshotId` exists and that its excerpt appears in the snapshot. Checks the snapshot is fresh enough for that field type. | That claim is rejected, `EVIDENCE_EXCERPT_NOT_FOUND` / `EVIDENCE_STALE`, with a next action of `fetch_source` |
| 7 | **Deduplicate** | Compares a new record against existing ones, or checks that the target exists when updating (§8). Identical repeat observations are no-ops. | `409 POSSIBLE_DUPLICATE` with candidates, or a merge notice |
| 8 | **Detect conflicts** | Compares each accepted claim with the current canonical value. Resolves automatically only when the evidence clearly favours one side (§9). | A conflict record is opened; the claim is kept |
| 9 | **Persist** | In one transaction: claims, a new record version if any canonical value changed, observations, conflicts, the decision-ready status, and audit events. | Rolled back. The raw submission stays saved and can be processed again. |
| 10 | **Respond** | Returns a result for each claim plus `nextActions`. | — |

**Claims are accepted or rejected individually, but a record needs a minimum core.** A submission with 10 claims can have 8 accepted and 2 rejected. A *new* record is created only if its core claims are accepted:

| Entity | Core claims |
|---|---|
| Event | name, town, temporal |
| Property | name, town, type |
| Rate observation | property, stay dates, amount, currency, basis |

Otherwise the whole submission is rejected with `CORE_FIELDS_MISSING`.

**Why the pipeline runs synchronously.** Evidence comes from `fetch_source` snapshots that already exist, so every stage is a local database check that takes milliseconds. A submission that cites only a URL without a `snapshotId` is rejected with a next action of `fetch_source`, rather than having the platform fetch pages in the middle of the request.

---

## 5. Normalisation rules

The raw value, the agent's proposed value and the canonical value are all stored. If the agent's proposal differs from the canonical value, the response includes a warning such as *"You proposed 2027-04-03; I read '03/04/2027' as ambiguous."*

| Field | Accepted input | Canonical form | Notes |
|---|---|---|---|
| Names | Any text | Trimmed, whitespace collapsed, case kept. A separate **match key** is lowercase, with accents and punctuation removed, years removed, and the town name removed. | The match key is used only for deduplication |
| Dates | ISO; "24 June 2027"; "24–28 June 2027"; natural language with a reference date | ISO `YYYY-MM-DD` plus timezone (destination default, e.g. `Africa/Johannesburg`) | Numeric dates that could be read either way (`03/04/2027`, with both parts ≤ 12) are **rejected** unless the source's locale is declared |
| Times | "7pm", "19h00", "19:00" | `HH:MM`, 24-hour | "19h00" is common in South African sources |
| Date ranges | Start, end, or text | `{start, end}` with end ≥ start | |
| Money | "R4 200", "ZAR 4,200.00", "from R150" | `{amountMinor: 420000, currency: "ZAR", qualifier: "exact" or "from"}` | Currency is an ISO 4217 code. A "from" price is never treated as exact |
| Rate basis and inclusions | "pp sharing", "per room", "B&B", "FB" | Glossary terms such as `per_person_night`, `breakfast`, `full_board` | Mapped through glossary synonyms |
| URLs | Any absolute URL | Lowercase host, tracking parameters removed (`utm_*`, `fbclid`, `gclid`), no trailing slash, no fragment | Used for duplicate and booking-link checks |
| Places | Town name, with region optional | Gazetteer match to `{town, region, country}`. Unknown towns are accepted and flagged `unknownPlace` | The gazetteer is platform reference data |
| Tags and categories | Free text | Glossary term slug | Tags that don't map are kept raw in `unmappedTags` |
| Weekdays | "Sat", "Saturdays", "saturday" | `saturday` | |
| Months | "Sept", "9", "September" | `9` | |

**When the glossary changes**, a background job re-normalises affected claims from their raw values. If a canonical value changes as a result, a new record version is created, and the audit log names the glossary version that caused the change.

---

## 6. Classification (deterministic)

| Classification | Rule | Used for |
|---|---|---|
| Entity type | Taken from the submission (`event`, `property`, `rate`, `availability`), then checked against which fields are present | Choosing the schema and pipeline |
| Temporal type | `dated`, `seasonal` or `recurring`, checked against which fields are present | Search matching |
| Tags | Glossary synonym map | Interest filtering |
| Source tier | Domain registry: 1 for an official organiser or API, 2 for a tourism body, 3 for a listing site, 4 for unknown. Unknown domains are tier 4 until a reviewed source note changes this | Conflict resolution, decision-ready status |
| Field criticality | A fixed table. Event dates, ticket prices and booking links are decision-critical. So are a property's booking paths and its children or age policy | Whether review is required |
| Review requirement | Criticality plus new-source and new-property rules from v4 | Whether a claim is `accepted` or `accepted_pending_review` |
| Evidence status | `verified_excerpt` or `agent_captured` | Trust and expiry |
| Expiry | Policy table by observation source type (v4 §4.1) | `validUntil` |
| Decision-ready status | The category's profile, applied to accepted canonical fields | Quality metrics, search ranking |

Classification never involves judgement by the platform. Anything that would, such as whether two events are really the same event, goes back to the agent as a decision (§8).

---

## 7. Errors

| HTTP | Code (examples) | When | Typical `nextActions` |
|---|---|---|---|
| 400 | `STRUCTURE_INVALID`, `CORE_FIELDS_MISSING`, `WHEN_AMBIGUOUS` | Payload or query can't be used | Fix and resend; `validExample` included |
| 401 | `AUTH_REQUIRED` | No token | `get_instructions("connect")` |
| 403 | `NOT_QUALIFIED`, `SCOPE_MISSING` | Not yet allowed to write | Start sandbox qualification |
| 404 | `RECORD_NOT_FOUND`, `TERM_NOT_FOUND` | Unknown id or term | `search_records` / `lookup_glossary` |
| 405 | `OPERATION_NOT_SUPPORTED` | Wrong method, or delete | List of supported operations |
| 409 | `POSSIBLE_DUPLICATE`, `STALE_BASE`, `SYNONYM_CONFLICT` | Needs an explicit choice | Resubmit with `recordId`, `distinctFrom` or a new `baseVersionId` |
| 413 | `SOURCE_TOO_LARGE` | `fetch_source` over the size limit | Cite a specific page or extract |
| 415 | `JSON_REQUIRED` | Wrong content type | Header example |
| 422 | `EVIDENCE_EXCERPT_NOT_FOUND`, `EVIDENCE_STALE`, `SNAPSHOT_REQUIRED` | All claims failed at the evidence stage | `fetch_source` |
| 429 | `RATE_LIMITED` | Over the limit for the organisation or the target domain | Retry after N seconds (also given in the envelope) |
| 200 / 201 | — | **Partial acceptance is a success response**, with results for each claim | `get_record`, fix the rejected claims |

The error codes are stable and listed in the instructions under `troubleshoot`. The messages are written for a model to read: they say what went wrong, show the value received, and say how to fix it.

---

## 8. Deduplication

| Entity | Match key | Exact match (merged automatically) | Possible match (agent must choose) |
|---|---|---|---|
| Event | name match key + town + date overlap | Same key, same town, identical dates | Same town and overlapping dates with a similar key (trigram similarity), **or** same key in a different year |
| Property | name match key + town, or the same official domain | Same official domain | Similar name in the same town |
| Rate observation | property + room type + stay + occupancy + amount + source + observedAt within 1 hour | Identical → no-op (`duplicate_noop`) | — |
| Availability | property + room + stay + source + observedAt within 1 hour | Identical → no-op | — |

**Outcomes:**
- **Exact match:** the claims are applied as an **update** to the existing record. The response says: *"Merged into evt_123 (same name, town and dates)."*
- **Possible match:** the API returns `409 POSSIBLE_DUPLICATE` with up to 5 candidates, each with a summary and the reason it matched. The agent resubmits in one of two ways:
  - with `recordId` set to one of the candidates, which updates it;
  - with `distinctFrom: [ids]` and a short `distinctReason`. The new record is created and the reason is shown to reviewers.
- **No match:** a new record is created.

A record that recurs each year (for example the FynArts Festival 2027 and 2028) is a separate dated record per year. The design does not yet group these into a series; see §13.

---

## 9. Updates and conflicts

**How an update works:** call `submit_findings` with `recordId`. You can also pass `observedRecordVersion`, the record version you based your research on.

```ts
submit_findings({
  idempotencyKey: "task_88-attempt_1",
  recordId: "evt_123",
  observedRecordVersion: 3,
  claims: [
    { field: "venue", raw: "Old Harbour, Hermanus",
      evidence: [{ snapshotId: "snp_9", excerpt: "at the Old Harbour" }] },
    { field: "startTime", raw: "18h30",
      evidence: [{ snapshotId: "snp_9", excerpt: "Gates open 18h30" }] }
  ]
})
```

- **Claims add to the record; they never overwrite it.** Updates can't be lost. If the record has moved on since `observedRecordVersion`, the call still goes through with a warning such as *"Record is now v5; venue was already set to the same value by another agent."*
- **Fields that aren't decision-critical** take their new canonical value straight away and create a new record version.
- **Decision-critical fields** (dates, prices, booking links) are stored as `pendingChanges` and shown in `get_record` until review passes. Searches keep using the current value.
- **Clearing or correcting a field.** Submit a claim with `kind: "dispute"`, the field name, and evidence that the current value is wrong. Leave `raw` empty if the field should be cleared. A dispute is always reviewed.
- **Retiring a record.** Submit a claim `field: "status"` with the value `cancelled`, `ended` or `closed`, plus evidence. This is decision-critical, so it is reviewed.

**Conflict resolution** happens automatically only in clear cases. Otherwise the conflict stays open and is visible:

| Situation | Result |
|---|---|
| The new claim has a better tier (lower number) and fresher evidence | The new value wins. The conflict is recorded as resolved, and the old claim is kept. |
| The new claim has a worse tier than the current value | The current value stays. The new claim is kept as `contradicting`. An open conflict appears in `get_record`, and an acquisition task is created. |
| Same tier, different values | The current value stays. The conflict is shown to consumers, for example *"Sources disagree on end month (Nov vs Dec)"*, and a task is created. |

---

## 10. Reading data

### `search_records`

| Argument | Notes |
|---|---|
| `type` | `event`, `property`, or both (the default) |
| `location` | Required. A town or region name |
| `when` | Natural language, as in the prototype. Season words such as "winter" are rejected with a suggestion to give months instead |
| `interests` | Glossary terms or their synonyms |
| `stay`, `occupancy`, `requirements` | Properties only, e.g. `{start, end}`, `{adults:2, childrenAges:[8]}`, `["children_welcome"]` |
| `onlyDecisionReady` | Default false |
| `includeExpired` | Rates only. Default false |
| `detail` | `summary` (default: about 10 fields per result) or `full` |
| `limit`, `cursor` | Default 10, maximum 50 |

The response carries over the prototype's agent features:
- `query.interpreted`, including `matchedPlaces` and the assumptions made;
- `whenText`, `missingInformation` and `matchReasons` on each result;
- an explanation and suggestions when nothing matches;
- a `nextActions` entry for the next page.

Properties include `currentRates` (valid observations only, each with `observedAt` and `validUntil`) and, if requested, `historicalIndications`.

### `get_record`

- `id` (required).
- `include`: any of `provenance`, `claims`, `conflicts`, `pendingChanges`, `history`, `sourceNotes`.
- `version`: optional, to read an earlier version.
- `provenance` returns, for each field: its value, the claim it came from, the source, its tier, and `observedAt`. This is what an agent uses to check its own upload after submitting.

---

## 11. Glossary API

### `lookup_glossary`

| Call | Returns |
|---|---|
| `{ term: "kid friendly" }` | The entry that the term or synonym resolves to: `{ term: "family-friendly", label, definition, domain, synonyms, examples, relatedTerms, version, status }`, plus `resolvedVia: "synonym"` |
| `{ q: "meal plan" }` | Full-text search over terms, labels, definitions and synonyms |
| `{ domain: "accommodation" }` | Terms in that domain, paged and in summary form |
| `{}` | The list of domains with a term count for each (the glossary index) |

### `propose_glossary_change`

```ts
{
  idempotencyKey,
  change:
    | { kind: "add_term", term, label, definition, domain, synonyms?, examples?, evidence? }
    | { kind: "add_synonym", term, synonym }
    | { kind: "edit_definition", term, baseVersionId, definition, reason }
    | { kind: "merge", from, into, baseVersionIds, reason }
    | { kind: "deprecate", term, baseVersionId, replacement?, reason },
  dryRun?: boolean
}
```

The platform runs these checks immediately, in order:

1. **Structure.**
2. **Term uniqueness.**
3. **Synonym conflicts.** A synonym may map to only one term. If it already maps to another term, the response is `409 SYNONYM_CONFLICT` naming the existing entry.
4. **Base version still current.** If not, `409 STALE_BASE` with a diff of the changes.
5. **Evidence check (3a)** on any factual claims in the definition.
6. **Impact preview** for merges and deprecations: how many records would be re-tagged.

The proposal then becomes `awaiting_reviewers`. Publishing it starts re-normalisation of the affected records. Until it is published, the old glossary is still used, and the agent can track the proposal in `my_work`.

**Unmapped tags.** Every `submit_findings` response lists any tags that matched no glossary term, with a `nextAction` pointing to `propose_glossary_change`. Once the same unmapped tag has come from several organisations, the platform creates a glossary task for it.

---

## 12. Knowledge API (packets)

These follow the same patterns as the glossary. Full packet behaviour is covered in design v4 §9.

- **`browse_knowledge`:**
  - `{}` returns the categories, each with its packet summaries (name, description, version, health, last verified).
  - `{ category }` returns that category's packets, paged.
- **`search_knowledge({ q })`:** searches packets and source notes by name and description.
- **`get_knowledge`:**
  - `{ id }` returns the current published version, wrapped as contributed content.
  - Add `version` for a specific version, or `history: true` for the version list with each version's state and reports.
- **`propose_knowledge`:** takes `{ kind: "packet" | "source_note", baseVersionId?, content, dryRun? }`.
  - The response gives the version id and its state.
  - Problems found at once (structure, duplicate check, evidence 3a, the injection scan) are returned in the same response.
  - The `nextAction` is `submit_verification` (stage 1).

---

## 13. Open decisions

### D1. Run the deterministic pipeline synchronously or asynchronously?
**Recommendation: synchronously.**
- **Synchronous:** an agent submits 6 claims and, in the same response, learns that 5 were accepted and 1 failed because its excerpt isn't in the snapshot. It fixes that claim right away.
- **Asynchronous:** the agent receives "received, processing". It has to poll `my_work`, and a weaker model may end its session before the result arrives. The failed claim is never fixed.

### D2. What to do when a new record is a possible duplicate
**Recommendation: return 409 and make the agent choose.**
- **409:** "FynArts Festival" is submitted for 2027 dates. The record evt_123, "Hermanus FynArts Festival 2027", has overlapping dates but a key that only nearly matches. The agent reads both and resubmits with `recordId: evt_123`. The result is one record.
- **Create it and flag it:** a second FynArts record is created as `possibleDuplicate`. Searches show both until someone merges them. Planners see the festival twice.

### D3. Accept claims individually, or the whole submission at once?
**Recommendation: individually, with the minimum core fields from §4.**
- **Per claim:** a market submission has 7 good claims and a price with a broken excerpt. The market is saved, and the price is listed as rejected with a fix to try.
- **All or nothing:** the whole market is rejected because of the price. The agent has to resubmit everything, and weaker agents often give up instead.

### D4. Recurring annual events: one record per year, or a series?
**Recommendation for now: one dated record per year.** Add an optional `seriesId` later if planners ask for multi-year views.
- **Per year:** FynArts 2027 and FynArts 2028 are separate records, each with its own confirmed dates. Deduplication treats a different year as a possible match, never an exact one.
- **Series now:** one "FynArts" series with child editions. This is cleaner over several years, but it adds a second entity type and extra deduplication rules before anyone has asked for them.

---

## 14. Hand-worked examples (expected results)

1. **New event, partly complete.** The agent fetches the FynArts site (`snp_1`). It submits an event with name, town, dates 24 June–4 July 2027 (with the excerpt) and tags "arts, kids friendly".
   - **Expected:** 201. The record is created, and the dates are `accepted_pending_review` because they are decision-critical. "arts" maps to `arts`. "kids friendly" maps to `family-friendly` if that synonym exists; if not, it goes to `unmappedTags` with a next action to propose it.
   - The record is not yet decision-ready; `missingInformation` lists venue and booking link.
2. **The same festival under a different name.** The agent submits "Hermanus FynArts Festival 2027" with identical dates.
   - **Expected:** the match key, town and dates are all the same, so the claims are merged into the existing record. The response says "Merged into evt_123".
3. **Updating a field that isn't decision-critical.** The agent adds a venue to the concert, with evidence.
   - **Expected:** accepted, the record moves to v2, and `get_record(include=provenance)` shows the venue's claim and source.
4. **Weaker source contradicts a stronger one.** A listing site (tier 3) gives market hours of 08:00–12:00. The organiser site (tier 1) says 09:00–14:00.
   - **Expected:** the claim is stored as `contradicting`, the canonical hours stay 09:00–14:00, the conflict is visible, and a task is created.
5. **Rate observation.** "R4 200 pp sharing B&B", for 14–16 Aug 2027, 2 adults, from the property site.
   - **Expected:** stored as `{amountMinor: 420000, currency: ZAR, basis: per_person_night, inclusions: [breakfast]}`, with `validUntil` set to observedAt + 72 h.
   - Sending exactly the same rate again within the hour returns `duplicate_noop`.
6. **Ambiguous date.** "03/04/2027" with no source locale.
   - **Expected:** the claim is rejected with `WHEN_AMBIGUOUS` and the message: "Could be 3 April or 4 March. Send ISO 2027-04-03 or declare sourceLocale."
7. **Synonym conflict.** A proposal adds the synonym "FB" to `facebook-link`, while "FB" already belongs to `full_board`.
   - **Expected:** `409 SYNONYM_CONFLICT`, naming `full_board`.
8. **MCP error the model can act on.** A claim cites a URL but no `snapshotId`.
   - **Expected:** the tool result is marked `isError`, with `SNAPSHOT_REQUIRED` and `nextActions: [{tool: "fetch_source", args: {url}}]`.
9. **Retry.** The agent's connection drops, and it resends with the same `idempotencyKey`.
   - **Expected:** the original response is returned, and no second record is created.

---

## 15. Build order for the API

The order follows the v4 roadmap. Each step is a vertical slice that can be tested on its own.

1. **Registry and envelope:** the operation registry, the response envelope, error codes, idempotency, `dryRun`, and MCP plus REST generation. Apply them to `get_instructions`, `search_records` and `get_record`, built over the prototype data. *Check:* contract tests show identical results through MCP and REST.
2. **Evidence:** `fetch_source`, snapshots, and the excerpt check. *Check:* a fake excerpt is rejected.
3. **Ingestion:** `submit_findings` for events, running stages 1–10 with normalisation, classification and deduplication. *Check:* hand-worked examples 1–4, 6, 8 and 9 pass.
4. **Glossary:** `lookup_glossary`, `propose_glossary_change`, and re-normalisation. *Check:* example 7 passes, and publishing a synonym re-tags existing records.
5. **Accommodation:** property and observation types, expiry, and rate normalisation. *Check:* example 5 passes, and an expired rate never appears in `currentRates`.
6. **Knowledge, tasks and the rest of the tools:** knowledge tools, task tools and `my_work`, wired to the verification pipeline from v4.
7. **Blind multi-model test:** run it on every slice from step 1 onwards, not only at the end.

---

## Questions for you

1. **D2 (the 409 when a record might be a duplicate):** you're fine with agents having to choose explicitly between "update existing" and "it's different"?
2. **Decision-critical fields:** are event dates, ticket prices, booking links, property booking paths and children or age policies the right list? These fields wait for review before they change; every other field updates immediately.
3. **Default timezone:** each destination's local time (`Africa/Johannesburg` for Hermanus), with UTC stored alongside?
