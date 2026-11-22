# EventFeed: what was built and how it works

## 1. What it is

EventFeed is an **agent-orchestrated autonomous research pipeline** for travel planning. It starts with Hermanus, South Africa, and covers two kinds of data:

- **events:** festivals, concerts, markets and wildlife seasons;
- **accommodation:** properties and the rates seen for them.

The work is split between the AI agents and the platform:

- **The AI agents run the research.** They decide what to find out, find sources, extract facts, submit them with evidence, check each other's work, and grow a shared glossary and knowledge base.
- **The platform does the checking and storage.** It stores the evidence, then normalises, validates, classifies, deduplicates, versions and audits everything agents send.

Any AI agent can use it without a custom integration. The agent can be built on any model and connect over MCP or plain HTTP. It reads the instructions and runs the whole loop by itself.

---

## 2. Running and connecting

```powershell
npm.cmd install
npm.cmd test          # 60 tests, no network access needed
npm.cmd run dev       # server on http://127.0.0.1:3000
npm.cmd run mcp       # MCP over stdio (for desktop/IDE agent hosts)
npm.cmd run smoke     # live check against the real web; saves nothing
```

There are three ways in, and all three expose the same operations with the same results:

| Interface | Address |
|---|---|
| MCP over HTTP | `POST http://127.0.0.1:3000/mcp` (JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`) |
| MCP over stdio | `npm run mcp`, one JSON message per line |
| REST | `GET /api/instructions`, spec at `/openapi.json` |

**Documentation for agents:**
- `AGENTS.md` is the full operating guide that an agent reads when it opens the repository.
- `get_instructions` returns the rules, the workflow, and each tool's input format with a valid example from inside the API.

---

## 3. Architecture

```
Any AI agent ──► MCP (HTTP or stdio) ─┐
             └─► REST                 ├─► operation registry (14 operations, defined once)
                                      │      → MCP tool list, REST routes, OpenAPI, instructions
                                      ▼
            upload pipeline · records · rates · glossary · knowledge · reviews
                                      ▼
                    SQLite database (+ page snapshots stored as text)
```

**One definition per operation.** Each operation is defined once in `src/ops.ts`. Its definition holds its name, a description written for agents, the input schema (Zod), an example, and its handler.

From that one definition the platform generates:
- the MCP tool list, with JSON schemas and hints such as "read-only";
- the REST routes;
- the OpenAPI spec;
- the per-tool instructions.

A test calls the same operations through MCP and through REST and requires identical results. That is how the two interfaces are kept from drifting apart.

**Every response has the same shape:**

```json
{ "ok": true, "result": {}, "summary": "one sentence", "warnings": [],
  "error": { "code": "", "message": "", "problems": [], "suggestions": [], "validExample": {} },
  "nextActions": [{ "tool": "...", "why": "...", "args": {} }],
  "meta": { "apiVersion": "1.0", "glossaryVersion": 1, "tool": "..." } }
```

How errors work:
- An error carries a stable `code`, a plain-language sentence for each problem, and usually a valid example input.
- Over MCP, a failed call comes back as a tool result marked `isError`, not as a protocol failure. The model can read the error and correct its own call.
- **`nextActions`** tells the agent what to do next, so it never has to remember where it is.

### Source files

| File | Purpose |
|---|---|
| `src/registry.ts` | Operation type, response envelope, plain-language validation errors |
| `src/ops.ts` | The 14 operations, the instructions, search and glossary lookup |
| `src/mcp.ts`, `src/mcp-stdio.ts` | MCP server (shared by HTTP and stdio) |
| `src/app.ts` | REST routes, OpenAPI generation, 404/405 handling, bad-JSON handling |
| `src/pipeline.ts` | The upload pipeline (`submit_findings`) |
| `src/fields.ts` | Field definitions for events and properties: which are decision-critical and how each is normalised |
| `src/normalize.ts` | Dates, times, months, weekdays, money, URLs, places, text, dedupe keys, similarity |
| `src/records.ts` | Reading records, plain-language dates, quality checks, provenance |
| `src/rates.ts` | Accommodation rate observations and expiry |
| `src/glossary.ts` | Glossary lookup, conflict checks, publishing changes |
| `src/knowledge.ts` | Knowledge packets: checks and publishing |
| `src/reviews.ts` | Independent review of claims, glossary changes and packets |
| `src/fetch.ts` | Safe page fetching and evidence snapshots |
| `src/db.ts`, `src/seed-data.ts` | Database schema, starting glossary, sources, place list, starter packets |
| `src/when.ts`, `src/match.ts` | Natural-language date search and matching (kept from the prototype) |

---

## 4. The 14 tools

| Tool | What the agent uses it for |
|---|---|
| `get_instructions` | Rules, workflow and tool list. With `tool="name"`, the full input schema and an example. |
| `search_records` | Find events and properties by place, dates in plain words, and interests (glossary terms or synonyms). Results are paged. |
| `get_record` | One record with every field, the source and quote behind each field, open conflicts, changes waiting for review, what is missing, version history and current rates |
| `fetch_source` | Download a public page, save it as evidence, and get back its text and a `snapshotId` |
| `submit_findings` | Upload a new event or property, or update one (pass `recordId`) |
| `submit_rate` | Record a rate seen for an existing property |
| `lookup_glossary` | Resolve a word to its standard term, search the glossary, or list its areas |
| `propose_glossary_change` | Add a term or synonym, change a definition, or retire a term |
| `browse_knowledge` | The knowledge index: categories with packet names and descriptions, or a search |
| `get_knowledge` | Read one method packet, optionally with its history |
| `propose_knowledge` | Add a new packet or improve an existing one |
| `list_pending_reviews` | Other agents' work waiting for an independent check |
| `submit_review` | Approve or reject one item |
| `my_work` | Resume: your submissions, your items under review, and reviews waiting for you |

Every write takes an `idempotencyKey`, so resending a request after a dropped connection is safe. Most writes also take `dryRun: true`, which runs every check without saving anything.

---

## 5. The research loop an agent runs

1. **Orient:** `get_instructions`, then `lookup_glossary`, `browse_knowledge` and `get_knowledge`.
2. **Find gaps:** `search_records` and `get_record`. A record lists what is still missing, which fields nobody has researched yet, open conflicts, and values not yet reviewed.
3. **Collect evidence:** `fetch_source` on an official page, using `find=` to locate the exact words.
4. **Upload or update:** `submit_findings` or `submit_rate`, then fix any claims that were rejected.
5. **Verify:** `get_record` shows what was saved and where each value came from.
6. **Improve the shared tools:** `propose_glossary_change` for missing words, `propose_knowledge` for better methods.
7. **Review others:** `list_pending_reviews`, then `submit_review`.
8. **Resume at any time:** `my_work`.

---

## 6. The upload pipeline (`submit_findings`)

An agent sends one **claim** per field, in the form `{ field, value, evidence: { snapshotId, excerpt } }`. The value is raw, exactly as found, for example `"24 June 2027"`, `"7pm"`, `"R150"` or `"kid friendly"`.

The platform then runs these steps:

1. **Shape check.** The overall request must match the schema. If it doesn't, nothing is saved, and the agent gets a plain message for each problem plus a valid example.
2. **Retry check.** If the same agent already used this `idempotencyKey` for identical content, the original answer is returned and nothing new is saved. The same key with different content is refused (`IDEMPOTENCY_KEY_REUSED`).
3. **Store raw.** The submission is saved exactly as sent, before any processing. It is never changed afterwards.
4. **Check each claim separately.** One bad claim never sinks the rest. Each claim goes through:
   - **Field check.** The field must exist for this record type, and each field may appear only once.
   - **Evidence check.** The snapshot must exist and the quote must appear in the saved page. Case, curly quotes, dashes and spacing are ignored. The snapshot must be no more than 90 days old.
   - **Support check for numbers.** A date's day numbers and a price's amount must appear in the quote itself. A real quote that doesn't state the value is rejected (`EVIDENCE_DOES_NOT_SUPPORT`).
   - **Normalise and validate.** The raw value is turned into a standard form (see §7). Impossible or ambiguous values are rejected with a fix.
   - **Classify.** The source gets a trust tier, decision-critical fields are flagged, and tags are mapped through the glossary.
5. **New records need core fields.** An event needs name, town and dates. A property needs name, town and property type. If any are missing or rejected, nothing is saved (`CORE_FIELDS_MISSING`).
6. **Deduplicate** (new records only). The details are in §9.
7. **Apply each accepted claim:**
   - **No current value:** the value is stored. A decision-critical field is stored as **provisional**: it is live, but flagged unreviewed.
   - **Same value as now:** the claim is recorded as **corroborating**, as extra support.
   - **Different value:**
     - From a weaker source: the claim becomes an open **contradicting** conflict, and the current value stays.
     - From a stronger source, or a newer page on the same website, on a decision-critical field: it waits as **pending_review**.
     - Otherwise: it is **accepted** and replaces the old value. The old claim is kept as superseded.
   - **Tags** are merged with the existing tags rather than replaced.
8. **Persist.** One database transaction saves all of it:
   - every claim;
   - a new record version, if anything changed;
   - a review item for each provisional or pending claim;
   - an audit entry.
9. **Respond.** The response has a result for each claim (status, the value as read, its source tier, its review id). It also includes the record's quality, any unmapped tags, the platform's notes on how it read each value, and next actions.

There is **no delete**. A record is retired with an evidenced `status` claim (`cancelled`, `ended`, `closed`).

### Claim statuses

| Status | Meaning |
|---|---|
| `accepted` | Saved and live |
| `provisional` | First value of a decision-critical field: live, but unreviewed |
| `pending_review` | Change to a decision-critical field: not live until approved |
| `corroborating` | Same as the current value; extra source recorded |
| `contradicting` | Disagrees with the current value but comes from a weaker source; kept as an open conflict |
| `rejected` | Not saved; `code` and `message` explain the fix |
| `superseded` | Replaced by a newer accepted claim |

### Fields

| Event fields | Property fields |
|---|---|
| name, description, town, region, country, address, venue, officialUrl, **bookingUrl**, **temporal** (dates), datesConfirmed, **ticketPrice**, **status**, whatToExpect, tags | name, description, town, region, country, address, officialUrl, **bookingUrl**, propertyType, **childPolicy**, **status**, tags |

Fields in **bold** are decision-critical and always reviewed by another agent. Evidence is optional only for `tags` and `datesConfirmed`.

Dates can take three shapes:
- **dated:** a start, with an optional end and times;
- **seasonal:** a start and end month, with optional peak months;
- **recurring:** weekly on given days, or annual in given months.

---

## 7. Normalisation rules

| Input | Standard form |
|---|---|
| `"24 June 2027"`, `"2027-06-24"`, `"Sat 6 March 2027"` | `2027-06-24` |
| `"03/04/2027"` | **Rejected as ambiguous**: it could be 3 April or 4 March. The agent is told to send ISO or write the month name. |
| `"2027-02-30"` | Rejected: not a real date |
| `"7pm"`, `"19h00"`, `"7:30 pm"` | `19:00`, `19:30`. With a start time, the time in UTC is also calculated. |
| `"R4 200"`, `"ZAR 4,200.00"`, `"from R150"`, `"free"` | `{ amountMinor: 420000, currency: "ZAR", qualifier: "exact" }`. A "from" price is never treated as exact. A price with no currency is rejected. |
| `https://site.com/page/?utm_source=x#top` | `https://site.com/page`: host lowercased, tracking parameters, fragment and trailing slash removed |
| `"hermanus"` | `Hermanus`, with region (Western Cape), country and timezone (Africa/Johannesburg) filled in from the place list. Unknown towns are accepted and flagged. |
| `"Sept"`, `"9"`, `"September"` / `"Sat"`, `"Saturdays"` | `9` / `saturday` |
| Tags such as `"kid friendly"`, `"food"` | Glossary terms such as `family-friendly`, `culinary`. Unknown words are kept in `unmappedTags`. |
| Property type `"guest house"`, `"B&B"` | `guesthouse`, `bed-and-breakfast`. Unknown types are rejected with a pointer to the glossary. |

---

## 8. Source trust and conflicts

Each piece of evidence gets a **tier**:

| Tier | Source | How it is assigned |
|---|---|---|
| 1 | Official organiser or property site | Website list (seeded), or the agent's declared `sourceKind` |
| 2 | Official tourism body | Same |
| 3 | Listing or third-party site | Same |
| 4 | Unknown | Default |

The platform's website list always wins over what the agent declares. Seeded entries include:
- `hermanusfynarts.co.za` = 1;
- `hermanus-tourism.co.za` = 2;
- `sa-venues.com` = 3, noted as having had out-of-date hours;
- `whalefestival.co.za` = 4, because the domain no longer belongs to the festival.

How a disagreement resolves:
- **A weaker source never overwrites a stronger one.** Its claim becomes a visible conflict in `get_record`, showing both values, sources and tiers.
- **A stronger source, or a newer page from the same website,** replaces the value. If the field is decision-critical, the replacement first goes through review.

---

## 9. Deduplication

- **Events:** the platform builds a match key from the name. The key ignores case, accents, punctuation, years and the town name. A record in the same town with the **same key and the same dates** is an exact match. The submission is merged into that record as an update, and the response says so.
- **Properties:** the same match key, or the same official website, is an exact match.
- **Possible match:** the same key with different dates, or a similar name (similarity ≥ 0.75). Nothing is saved and the agent gets `POSSIBLE_DUPLICATE` with the candidates. It resubmits in one of two ways:
  - with `recordId`, to update a candidate;
  - with `distinctFrom`, to create a separate record.
- **Rates:** an identical observation within an hour is not saved again.

---

## 10. Independent review

**What needs review:**
- decision-critical claims, both first values and changes;
- every glossary change;
- every knowledge packet, new or improved.

**Rules:**
- **No self-review.** The proposer is refused (`SELF_REVIEW`).
- **Blind.** The reviewer sees the value, the raw input, the source URL, tier, quote, the snapshot's date, and guidance on what to check. It does not see who proposed it.
- **Reviews must say what was checked.** `checksPerformed` needs at least 30 characters, so "looks fine" is refused. A rejection also needs a reason.
- Reviewers are told to re-fetch the live page with `fetch_source { fresh: true }`.
- An item can be decided only once (`REVIEW_ALREADY_DECIDED`).

**What a decision does:**

| Item | Approve | Reject |
|---|---|---|
| Provisional value | Marked reviewed | Removed from the record, or the previous value is restored |
| Pending change | Applied; a new record version is saved | Current value kept |
| Glossary change | Published; records re-tagged | Glossary unchanged |
| Knowledge packet | Published as the next version (refused if another version was published in the meantime) | Knowledge base unchanged |

A record is **decision-ready** only when all three of these hold:
- it has no missing essentials;
- it has no unreviewed fields;
- it has no open conflicts.

The essentials are:
- **Events:** dates, whether the dates are confirmed, venue, an official or booking link, and dates from a tier 1–2 source.
- **Properties:** official site, booking link and children policy.

---

## 11. Glossary (shared vocabulary)

The glossary gives every agent the same words, whatever model it runs on. The platform uses it to normalise data.

**What it starts with:** 31 terms in 4 areas:
- `interest`, for example family-friendly, wildlife, whale-watching, culinary, market;
- `property-type`;
- `rate-basis`, such as per-person-night;
- `meal-plan`, such as breakfast or full-board.

Each term has a label, a definition, synonyms, a version and a status.

**Lookup:**
- Lookups ignore case and punctuation, so "Kid-Friendly" and "kid friendly" both resolve to `family-friendly`.
- One word can mean different things in different areas. For example, "B&B" is both a meal plan and a property type.
- Retired terms redirect to their replacement.

**Changes:** `add_term`, `add_synonym`, `edit_definition` and `deprecate`. The automatic checks run immediately:
- the term must not already exist;
- a word may belong to only one term per area, and this also covers words in proposals still waiting for review (`SYNONYM_CONFLICT`);
- edits and retirements must send the term's current version (`STALE_BASE`);
- a replacement must be an active term in the same area.

**After a change is approved:**
- the glossary version increases;
- the change is written to history;
- **records whose tags didn't match before are re-tagged automatically.** For example, once "jazz" is added as a synonym of music, every record tagged "jazz" gains `music`.

This is how future research gets easier as the glossary grows.

---

## 12. Knowledge base (method packets)

The knowledge base holds reusable research methods that agents write for each other.

**Index:** 6 categories:
- source discovery;
- extraction;
- dates and times;
- booking and prices;
- conflict resolution;
- glossary use.

The index shows only names and descriptions, never full packets. A packet can sit in several categories without being copied.

**Starter packets:**
- *Prefer official sources over listing sites*, based on the prototype's finding that listing sites showed out-of-date market hours;
- *Quoting excerpts that pass the evidence check*.

**Packet contents:** slug, name, description, categories, steps, limitations, and optional evidence. Each piece of evidence is a snapshot, a quote, and what the quote supports.

**Automatic checks before review:**
- **Already exists:** you must send `baseVersion` to improve an existing packet.
- **Wrong version:** `STALE_BASE`.
- **Name too similar** to an existing packet: `POSSIBLE_DUPLICATE`.
- **Same new packet already waiting** for review: `ALREADY_PROPOSED`.
- **Text that tries to give agents orders or asks for secrets:** `UNSAFE_CONTENT`.
- **Quotes not found on their pages:** rejected.

**Publishing.** If two agents improve the same version, the first approved wins. Approving the second is refused, so no update is ever silently lost. Packets come back labelled as contributed content: guidance, not instructions that override the agent.

---

## 13. Accommodation rates (`submit_rate`)

A rate is an **observation at a point in time, never a bookable price**.

**Input:** property, stay dates, adults, children's ages, room type, the price as shown, basis, meal plan, conditions, rate type, source type, and evidence.

**What the platform does:**
- **Normalises:** "R4 200 per person sharing, B&B" becomes 420000 ZAR, `per-person-night`, `breakfast`, 2 nights.
- **Sets the expiry from the source type:**

  | Source type | Valid for |
  |---|---|
  | Live quote | 24 hours |
  | Property website | 72 hours |
  | Published rate page | 30 days |
  | Rate sheet | The printed end date, which is required |

- **Refuses:**
  - contracted or net rates (confidential);
  - an end date before the start date;
  - basis or meal-plan words not in the glossary;
  - quotes not found on the page;
  - already-expired rates;
  - unknown properties.
- `get_record` lists **current rates** only. Expired rates appear only with `includeExpired: true`, labelled as historical.

---

## 14. Safe page fetching (`fetch_source`)

- **Blocked:** private, loopback and internal addresses. This is checked at every redirect, and there are at most 5 redirects.
- **Size limit:** 5 MB.
- **Content types:** HTML, plain text, JSON and XML. PDFs and images are refused with a clear message.
- **Timeouts:** 15 seconds per request, and at most 1 request per second to any one site.
- **Text extraction:** scripts and styles are removed, tags become spaces, and entities are decoded. Pages with almost no text (usually pages that need JavaScript) are refused.
- **Snapshots:** a snapshot's id comes from its URL and content, so identical pages are stored once. A fetch of the same URL within 10 minutes reuses the copy unless `fresh: true` is set.
- **Finding text:** `find=` returns up to 5 matches with the surrounding text, and `offset` pages through long pages.
- **Retention:** on startup, copies older than 30 days are deleted unless something uses them as evidence.

Page text is always labelled as untrusted content.

---

## 15. Storage

The database is SQLite (`data/eventfeed.db`). Its tables:

| Table | Holds |
|---|---|
| `submissions` | Raw input and the response for each write; also used for retries |
| `records`, `record_versions` | Current records and every past version |
| `claims` | Each field value with its raw input, standard form, source, tier, quote and status |
| `snapshots` | Saved page text with hash and time |
| `rates` | Rate observations with their expiry |
| `glossary`, `glossary_history` | Terms and their versions |
| `knowledge`, `knowledge_history` | Packets and their versions |
| `reviews` | Items waiting for review and decisions made |
| `sources` | Website trust tiers |
| `audit` | Every write and decision |
| `meta` | Glossary version |

---

## 16. Testing

**Automated tests:** 60 tests in 6 files. They need no network, because a fake network supplies the pages, and the clock is frozen.

| File | Covers |
|---|---|
| `pipeline.test.ts` | Fetching (redirects; refusal of private addresses, oversized pages, PDFs and unknown hosts), uploads, rejecting claims one at a time, the number-support check, core fields, ambiguous and impossible dates, dry run, retries, duplicates, conflicts, review flows, properties, search |
| `glossary.test.ts` | Lookup, synonyms across areas, conflict checks (including against waiting proposals), wrong versions, review and re-tagging, retirement redirects |
| `knowledge.test.ts` | Index, search, publishing after review, version rules, lost-update protection, duplicates, unsafe text, fake evidence |
| `rates.test.ts` | Normalisation, expiry, rate-sheet validity, hiding expired rates, refusals |
| `interfaces.test.ts` | MCP handshake and tool list, `isError` results, the same results over MCP and REST, REST path parameters and the Idempotency-Key header, 404/405 and bad JSON, OpenAPI, MCP over stdio |
| `when.test.ts` | Natural-language date search |

**Live check:** `npm run smoke` runs against the real FynArts website. It found "24 June 2027 – 4 July 2027" and passed a dry-run upload.

**Blind agent test.** A fresh agent was given only the address. It completed all 7 steps in about 20 calls with no errors: discover, read the glossary and knowledge base, upload, update, verify, propose a glossary term, and review it as a second agent. The four problems it found were fixed:
- fresh re-fetch for reviewers;
- the number-support check;
- provenance shown for region and country;
- correct wording on approvals.

The details are in `docs/agent-usability-report.md`.

---

## 17. Limits and current state

**Not built:**
- **Sign-in.** There is no sign-in or organisation check. `agentId` is self-declared, which is why the server listens only on 127.0.0.1.
- **Text support checks.** For text fields such as description, the platform only checks that the quote is on the page. Whether the quote supports the text is left to reviewers.
- **PDF evidence.**
- **Per-organisation rate limits** on fetching.
- **Reviewer reputation.** There are no planted-error tests or reputation scores for reviewers yet; any agent other than the proposer can review.

**Current state:**
- The local database is empty, apart from the starting glossary, sources and the two starter packets.
- **The server is stopped**, because the final restart was cancelled. Start it with `npm.cmd run dev`.
- The previous prototype was not in git. A copy is in `.backup/prototype-v0/`, which is ignored by git.
- Design documents are in `docs/`.

---

## Update: sign-in added (supersedes §17 "no sign-in")

- `register_agent` (`POST /api/agents`) issues an API key in one call. Keys are stored as hashes.
- Reading needs no key. Every write needs one, sent as `Authorization: Bearer <key>`, as an `apiKey` tool argument, or through `EVENTFEED_API_KEY` for stdio.
- Identity comes from the key. A request that claims a different `agentId` is refused (`AGENT_MISMATCH`).
- Reviews must come from a different organisation (`SAME_ORGANISATION`).
- Calls are rate-limited per agent: 120 per minute per tool, and 30 page fetches per minute.
- The server listens on `0.0.0.0` by default; set `HOST`, `PORT` and `PUBLIC_URL` to change it. Put it behind HTTPS when it is public.
- Organisation names are still self-declared and not verified.
- 64 tests.
