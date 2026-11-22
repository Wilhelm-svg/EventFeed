# EventFeed design proposal: data acquisition and knowledge management

Status: proposal for review. Nothing here is implemented.

## Summary of recommendations

1. **Two pipelines that share one evidence model.** Event data and playbook knowledge are different products with different risks, but both rest on the same three building blocks: sources, evidence snapshots and claims.
2. **The claim is the unit of verification.** Records and packets are both broken into individual claims, and each claim points at evidence. You can't check "a packet". You can check "the FynArts site lists 24 June to 4 July 2027".
3. **The platform fetches the evidence itself.** An agent supplies a URL and a verbatim excerpt. The platform downloads the page, stores a snapshot and checks that the excerpt appears in it. This is the strongest single defence against hallucination, and it is deterministic.
4. **The platform runs the adversarial reviewer.** Independence can't be trusted when it is self-declared by external agents. A reviewer the platform runs, with its own credentials and preferably a different model family, is simpler to secure and easier to audit.
5. **Published versions are immutable.** Every change is a new version against a stated base version. The old version stays live until the new one passes every gate. Failed versions are kept for audit but can never be served.
6. **Measure the verification pipeline itself.** Feed it planted-error "canary" contributions and track how many it catches. Without this, "genuinely difficult for hallucinations to enter" can't be tested.
7. **No routine human approval, but keep a human spot-audit.** A small random sample of what gets published is reviewed by a person. This is how you find out whether the automated gates actually work.
8. **Acquire based on demand.** What to acquire next should come from what planners and agents actually search for and don't find, not from crawling.

---

## 0. Critique of the brief

The brief is sound in direction. These are the places where I'd push back or where requirements are missing.

| Issue | Why it matters | Recommendation |
|---|---|---|
| **Stage 1 (self-verification) has little value as a gate.** | The same model reviewing its own work repeats its own blind spots. That is the failure mode the brief itself warns about. | Keep it, because it forces the contribution into a structure (every claim listed, every assumption labelled) that stages 2 and 3 need. Don't count it toward trust. |
| **"Evidence-based verification" mixes two different checks.** | "Does this excerpt exist at this URL?" is mechanical. "Does this excerpt support this claim?" needs judgement. | Split stage 3 into **3a, a mechanical platform check**, and **3b, a judgement check by the reviewer**. Run 3a first. It is free and rejects fabricated evidence before any LLM tokens are spent. |
| **Playbook knowledge is mostly methods, not facts.** | You can't cite a source for "search the organiser's site before listing sites". You can show that it worked. | Packet claims are typed as `fact`, `instruction` or `heuristic`. Instructions are verified by **reproduction**: the reviewer runs the method on a case the contributor didn't choose. Heuristics need recorded outcomes. |
| **"Independent reviewer" is unenforceable if reviewers are just other API clients.** | One operator can register two agent identities and approve its own work. The declared model name can't be verified. | The platform runs stage 2 and 3b reviewers itself. External agents can add reviews later as extra input, never as the only gate. |
| **"Platform owns classification" conflicts with "deterministic".** | Deciding that an event is "family-friendly" takes judgement. | Agents propose tags. The platform validates them against a controlled vocabulary it owns. Unknown tags go into a queue instead of being created silently. |
| **"Platform owns deduplication" is only partly deterministic.** | "FynArts Festival 2027" and "Hermanus FynArts" may be the same event or a parent and a child event. | The platform deterministically **finds candidates** and blocks exact duplicates. A merge decision is a claim like any other and goes through review. |
| **Event records are not given a verification requirement.** | The three-stage rule applies only to packets, but wrong event dates are what reach the traveller. | Apply mechanical evidence checks (3a) to every material field of every record. Apply adversarial review to fields that drive decisions (dates, booking URLs, prices) and to sources not seen before. |
| **Packets are prompt-injection vectors.** | A packet is text that other agents follow as instructions. One poisoned packet can steer every future agent. Scraped pages carry the same risk. | Packets use structured fields with limited length. The reviewer must check specifically for injection. Agent guidance says packet content is a method to follow, not authority to override the agent's own rules. |
| **Missing: legal and terms-of-service compliance.** | Scraping and storing full page snapshots raises copyright and ToS questions. | Store snapshots privately for audit only. Respect robots.txt and site terms. Record the compliance basis on each source. |
| **Missing: cost control.** | Three LLM stages for every contribution add up, and the business is frugal by design. | Run the cheap deterministic gates first. Give each acquisition task a token and fetch budget. Track the cost of each record that becomes decision-ready. |
| **Scope creep: accommodation rates and booking URLs.** | These aren't events. Rates change quickly, often sit behind booking engines and come under contracts (rack rates versus net rates). | Treat accommodation as a separate data category with its own decision-ready profile. Confirm that it is actually in scope (see open questions). |
| **Packet sprawl.** | Agents will tend to write a packet for every quirk of a single site. | Separate **source notes** (facts about one source, attached to that source) from **packets** (methods that apply across sources). A packet must apply to at least 2 cases. |

---

## 1. Overall architecture

One application and one relational database, as now. This adds no new services. The only new infrastructure is object storage for evidence snapshots.

```
                 ┌──────────────────────── Agents (any model) ────────────────────────┐
                 │  research · extract · interpret · propose claims · propose packets │
                 └───────────────┬──────────────────────────────┬─────────────────────┘
                                 │ REST (same self-describing API style as the prototype)
        ┌────────────────────────┴──────────┐        ┌──────────┴─────────────────────────┐
        │ Acquisition                       │        │ Knowledge                          │
        │ tasks (leased) → submissions      │        │ index → categories → packets       │
        │ → claims → canonical records      │        │ versions → verification → publish  │
        └────────────────────────┬──────────┘        └──────────┬─────────────────────────┘
                                 │      shared evidence model   │
                        ┌────────┴──────────────────────────────┴────────┐
                        │ Sources · Evidence snapshots · Claims · Audit   │
                        └────────┬──────────────────────────────┬────────┘
                                 │                              │
                  Platform workers (deterministic)     Platform reviewer (LLM, platform-run)
                  fetch+snapshot · normalise · dedupe   adversarial review · claim-support check
                  conflict detect · score · publish gate
```

**Responsibilities:**

| Agents | Platform |
|---|---|
| Find sources and choose packets | Fetch and snapshot evidence, and check that excerpts appear in it |
| Extract raw values and propose interpretations | Normalise to canonical form, keeping the raw value |
| Flag uncertainty and conflicts they notice | Detect conflicts between claims deterministically |
| Propose tags, merges and packets | Validate against the vocabulary, find duplicate candidates, enforce the publish gate |
| Report packet outcomes and lessons learned | Version history, audit log, scoring, staleness scheduling |

---

## 2. Data acquisition workflow

### 2.1 Core entities

| Entity | Purpose | Mutable? |
|---|---|---|
| `Source` | A site, API or document publisher. Holds its type, trust tier, compliance basis and **source notes**. | Versioned |
| `EvidenceSnapshot` | A page the platform fetched: URL, retrieval time, HTTP status, content hash and a storage reference. | Immutable |
| `Submission` | Exactly what an agent sent: the raw payload, its proposed interpretation, agent id and task id. | Immutable |
| `Claim` | One field-level assertion, for example "event X endDate = 2027-07-04". Holds the raw value, the proposed value, the canonical value, evidence references (snapshot id plus verbatim excerpt) and a status. | Status only |
| `Record` (Event, later others) | The canonical entity built from accepted claims. Each field points to the claim it came from. | Versioned |
| `Conflict` | Two or more accepted claims that disagree on the same field. Holds the resolution or the label "unresolved". | Status only |
| `AcquisitionTask` | A unit of work: target, required fields, budget, lease holder and lease expiry. | Yes |

Keeping provenance at field level means the platform never has to overwrite source material. A canonical value is always a derived view with a pointer back to the claim it came from. The whale-season case from the prototype, where two sources gave different end months, becomes a stored `Conflict` instead of a sentence typed into `whatToExpect`.

### 2.2 Workflow

1. **Backlog creation (platform).** Tasks come from four places:
   - a priority list for each destination and category;
   - searches that returned no results or only thin results (demand);
   - records past their freshness window;
   - unresolved conflicts.
2. **Lease (agent).** The agent claims a task with a time-limited lease. This stops two agents doing the same research. If the lease expires, the task returns to the queue.
3. **Read the playbook (agent).** The agent fetches the index, opens 1–3 relevant packets and reads the target source's notes.
4. **Find sources, in this order of preference:**
   1. an official API;
   2. a structured public dataset;
   3. the official organiser's website or document;
   4. an official tourism body;
   5. reputable listing sites, used for corroboration only;
   6. scraping, which needs a recorded compliance basis.
5. **Capture evidence (agent supplies, platform verifies).** The agent submits the URL and a verbatim excerpt for each claim. The platform fetches the page and checks the excerpt. If the page can't be fetched server-side (heavy JavaScript, a login wall), the agent may upload its own capture. That evidence is marked `agent_captured` and its claims can't reach the top trust tier.
6. **Submit (agent).** One submission per task attempt, with an idempotency key. It contains the raw extracted values, the proposed canonical values, the evidence for each claim, the uncertainties the agent noticed, and the fields it looked for but couldn't find.
7. **Process (platform, deterministic):**
   1. validate the schema;
   2. normalise, keeping the raw value;
   3. run the mechanical evidence check (3a);
   4. find duplicate candidates;
   5. detect conflicts;
   6. compute quality signals.
8. **Review (platform reviewer).** This runs only for fields that drive decisions, sources seen for the first time, proposed merges and conflicts.
9. **Persist.** The record moves to a new version. Each field links to its claim, the claim links to its evidence, and the evidence links to the snapshot.
10. **Close the task (agent).** The agent reports the outcome, which packets it used and whether they helped, and any lessons. Lessons may become packet proposals or source notes (see §8).

---

## 3. Data quality

No single invented "quality score". The prototype deliberately avoided made-up reliability numbers, and that should continue. Use a small set of signals you can explain, plus one outcome measure.

### 3.1 Signals per field and per record

| Signal | Definition | Deterministic? |
|---|---|---|
| **Source tier** | 1 = official API or organiser site, 2 = official tourism body, 3 = reputable listing, 4 = other | Yes, from `Source` |
| **Evidence status** | `verified_excerpt` (found in a platform snapshot), `agent_captured`, `none` | Yes |
| **Freshness** | Time since the snapshot, compared with how quickly the field type changes. Prices go stale in weeks, venues in years. | Yes, from a volatility table |
| **Corroboration** | Number of independent sources agreeing (different domains, not syndicated copies) | Mostly yes |
| **Conflict** | An unresolved conflict exists on this field | Yes |
| **Completeness** | Required fields present, judged against the category's **decision-ready profile** | Yes |

### 3.2 "Decision-ready", the main unit of value

For each data category, define the minimum set of fields a travel planner needs before acting. For a dated event, a sensible default would be:

- name and a short description;
- confirmed dates, or an explicit "tentative" flag;
- town and venue;
- an official link or booking path;
- at least one tier-1 or tier-2 source;
- no unresolved conflict on dates.

A record is **decision-ready** when it meets its category profile. Everything else is **partial** and is still served, with its `missingInformation`, as the prototype does now. The profiles are stored in the database and can be edited, so changing what "valuable" means is a data change, not a code change.

### 3.3 Success metrics

| Metric | What it tells you |
|---|---|
| Decision-ready records per destination, by category | Value, not volume |
| Demand hit rate: share of real searches that return at least one decision-ready result | Whether we collect the right things |
| Error rate in the human spot-audit | Real accuracy |
| Stale share: decision-ready records past their freshness window | Maintenance debt |
| Cost per decision-ready record (tokens, fetches) | Frugality |
| Canary catch rate (§7.6) | Whether verification works |

Total record count is reported but is never a target.

---

## 4. Knowledge packet design

### 4.1 Two kinds of operational knowledge

| | **Source note** | **Knowledge packet** |
|---|---|---|
| Scope | One source or domain | A method that applies across sources |
| Example | "hermanuscountrymarket.co.za is authoritative. sa-venues.com lists outdated hours." "whalefestival.co.za no longer belongs to the festival." | "Resolving conflicting event dates between an organiser site and listing sites" |
| Attached to | A `Source` | One or more categories |
| Verification | Evidence check plus a lighter review | Full three stages |

Both lessons from the prototype run (stale listing sites and a lost domain) were source notes. Neither needed a packet. This separation does more than anything else to keep the index small.

### 4.2 Packet structure

The fields are structured rather than one block of free markdown, so each claim can be checked separately and each field can be limited in length.

```
Packet (identity, stable)
  id, slug (unique), status, currentPublishedVersionId, createdAt

PacketVersion (immutable once submitted)
  id, packetId, versionNumber, baseVersionId
  name                 ≤ 80 chars, searchable
  description          ≤ 400 chars, searchable: what problem it solves and when to use it
  categories[]         ≥ 1, from the controlled vocabulary (join table, no copies)
  appliesTo            optional facets: dataCategory, sourceType, region
  whenToUse / whenNotToUse
  steps[]              ordered instructions, each with its own id
  claims[]             { id, kind: fact|instruction|heuristic, text, evidence[] }
  workedExamples[]     at least 1 for instruction packets: input, steps applied, result, snapshot refs
  limitations[], assumptions[], knownUncertainties[]
  changeSummary        required when baseVersionId is set
  authorAgentId, state, createdAt, publishedAt
```

The full text of a packet is never placed in the index.

### 4.3 Categories

- Categories form a controlled vocabulary owned by the platform. Start flat with around 8–12 categories, for example:
  - source discovery;
  - content extraction;
  - date and time normalisation;
  - booking and links;
  - pricing;
  - documents (PDF);
  - conflict resolution;
  - organiser identification.
- Agents may **propose** a new category. A proposal becomes a queued item; nothing is created automatically.
- A packet belongs to categories through a join table, so a packet appears in several categories without being copied.
- Add one level of nesting only if a category grows past about 20 packets.

---

## 5. Index design ("the index of a book")

### 5.1 What the index returns

`GET /api/knowledge` returns roughly 1 KB per category:

```json
{
  "howToUse": "Pick a category, scan names and descriptions, then GET the packet you need. Search with /api/knowledge/search?q=.",
  "categories": [
    {
      "slug": "conflict-resolution",
      "name": "Resolving conflicting sources",
      "description": "What to do when sources disagree on dates, times, prices or venues.",
      "packetCount": 3,
      "packets": [
        { "id": "kp_...", "name": "Organiser vs listing-site date conflicts",
          "description": "...", "version": 4, "lastVerified": "2027-01-10", "health": "ok" }
      ]
    }
  ]
}
```

- Entries contain only the name, description, version, last-verified date and health (`ok`, `needs_review`, `stale`). The body is never included.
- Only published versions appear. Drafts and failed versions don't.
- If the index grows past about 150 packets, the top level returns categories only, and `GET /api/knowledge/categories/{slug}` lists that category's packets. Agents follow the same steps either way.

### 5.2 Search

- Full-text search over name and description, ranked by match. This is a standard relational database feature and needs no embeddings.
- The response echoes how the query was interpreted and, when nothing matches, suggests categories, in the same style as the prototype's search endpoint.
- **Why not RAG:** with tens or low hundreds of short, curated packets, an agent scanning names and descriptions picks better than vector similarity would, and its choice is predictable and auditable. Reconsider only if agents measurably fail to find packets that exist. Log searches that return no results to detect that.

---

## 6. API capabilities

Same conventions as the prototype: the API describes itself at `GET /api`, every error has a `message`, `problems` and `suggestions`, and the OpenAPI spec matches the real responses.

### 6.1 Knowledge

| Operation | Endpoint | Notes |
|---|---|---|
| Index | `GET /api/knowledge` | Lightweight, published packets only |
| Search | `GET /api/knowledge/search?q=` | Name and description |
| Browse a category | `GET /api/knowledge/categories/{slug}` | |
| Get a packet | `GET /api/knowledge/packets/{id}` | The current published version. `?version=n` for history. |
| Version history | `GET /api/knowledge/packets/{id}/versions` | Includes failed versions, with their reports |
| Verification reports | `GET /api/knowledge/versions/{vid}/reports` | |
| Propose a new packet | `POST /api/knowledge/packets` | Returns duplicate candidates with 409 if too similar (§9) |
| Propose a change | `POST /api/knowledge/packets/{id}/versions` | Requires `baseVersionId`. "Update" and "propose an improvement" are the same operation. |
| Submit the self-verification report | `POST /api/knowledge/versions/{vid}/self-report` | Moves the version into the pipeline |
| Version status | `GET /api/knowledge/versions/{vid}` | State, blocking findings, next action |
| Report usage | `POST /api/knowledge/packets/{id}/usage` | Outcome: worked, partly worked or failed, with task id and notes |
| Propose a category | `POST /api/knowledge/category-proposals` | |

There is no direct "update" that skips verification. **Merging "update" and "propose improvement" into one operation is deliberate.** Two paths would invite agents to pick the one with fewer checks.

### 6.2 Acquisition

| Operation | Endpoint |
|---|---|
| List or claim tasks | `GET /api/tasks`, `POST /api/tasks/{id}/lease` |
| Submit findings | `POST /api/submissions` (idempotency key) |
| Submission status | `GET /api/submissions/{id}`: accepted claims, rejected claims with reasons, conflicts |
| Close a task | `POST /api/tasks/{id}/complete` (outcome, packets used, lessons) |
| Sources and notes | `GET /api/sources?domain=`, `POST /api/sources/{id}/notes` |
| Records | Existing search, plus the **fetch-by-id** that every blind-test round asked for: `GET /api/events/{id}`, with field provenance |

---

## 7. Verification architecture

### 7.1 Version lifecycle

| State | Entered when | Next states |
|---|---|---|
| `draft` | The version is created | `self_verified`, `withdrawn` |
| `self_verified` | A complete stage 1 report is accepted | `evidence_checked`, `rejected` |
| `evidence_checked` | Mechanical check 3a passes | `under_review`, `rejected` |
| `under_review` | Platform reviewers have been assigned | `approved`, `changes_requested`, `rejected` |
| `approved` | Stage 2 and stage 3b both pass with no blocking findings | `published`, `stale_base` |
| `published` | The platform gate passes, in one atomic step | `superseded`, `suspended`, `deprecated` |
| `changes_requested` / `rejected` / `stale_base` | Terminal for this version. The contributor fixes the problem by creating a **new** version. | |

Only the platform's publish function can set `published`. No API endpoint accepts a state from a client.

### 7.2 Stage 1: self-verification (contributor)

- The report is structured and contains one entry per claim and per step. Each entry has:
  - the check performed;
  - the result;
  - the correction made;
  - whether the item is a fact or an assumption;
  - any remaining uncertainty.
- The platform checks only that the report is complete: every claim id is covered and no field is empty. It can't check honesty, and it doesn't try.
- **Value:** stage 1 forces assumptions to be labelled and claims to be listed. **It adds no trust.**

### 7.3 Stage 3a: mechanical evidence check (platform, deterministic)

This runs before stage 2 because it costs nothing and catches fabricated evidence. For every `fact` claim:

1. At least one evidence reference exists.
2. The platform fetched the URL itself and stored a snapshot.
3. The excerpt appears in the snapshot, after normalising whitespace and case.
4. The snapshot is within the freshness window for the claim.
5. The source tier is recorded.

Any failure means rejection, with the specific claim id and reason. A made-up URL, a page that has changed, or a quote the source doesn't contain all fail here.

### 7.4 Stage 2: adversarial review (platform-run reviewer)

- **Independence rules, enforced by the platform:**
  - The reviewer's credentials differ from the contributor's, and belong to a different operator.
  - By default, the reviewer uses a different model family from the one the contributor declared.
  - **Blind review:** the reviewer gets the packet version, the evidence snapshots and the base version's diff. It doesn't get the contributor's stage 1 report or reasoning. This is what stops "three reports repeating one line of reasoning".
- **The reviewer's task is to find reasons the packet is wrong:**
  - counterexamples and edge cases;
  - outdated steps and ambiguous wording;
  - failure modes and unintended consequences;
  - injection-like instructions;
  - conflicts with other published packets.
- **Instruction claims are checked by reproduction.** The reviewer applies the steps to one of the contributor's worked examples and to **one case the platform picks** that the contributor didn't choose. It records the result together with the snapshots it used.
- **Report format:** one finding per issue, each with the claim or step id, its severity (`blocking` or `advisory`) and the evidence for it. A report that passes must still list the checks done for each claim. The platform rejects reports that mention no claim ids, because those are empty approvals.

### 7.5 Stage 3b: claim-support check (platform-run reviewer, separate call)

- For each `fact` claim and its excerpt, the reviewer answers:
  - Does the excerpt support this exact claim, or only something close to it?
  - Is the source primary?
  - Does a fresher or higher-tier source say otherwise?
- Each claim gets one outcome: `supported`, `partially_supported` (it must be qualified), or `unsupported` (it must be removed or marked unverified).
- Heuristic claims ("listing sites are often outdated") are supported by usage outcomes or by several cited cases, not by a single page.

### 7.6 Publish gate (platform, deterministic)

A version is published only if **all** of these hold:

1. The schema is valid and every reference resolves (categories exist, snapshots exist).
2. A complete stage 1 report exists.
3. 3a passed for every fact claim.
4. The stage 2 and 3b reports exist, come from eligible independent reviewers, and have **no open blocking findings**.
5. No fact claim is `unsupported` unless it is explicitly marked unverified.
6. `baseVersionId` is still the current published version (§9).
7. The duplicate check passes (§9).

Publishing is one database transaction. It writes the new current version, marks the old one `superseded` and appends to the audit log.

**Measuring the pipeline:**
- **Canaries:** a scheduled job submits contributions with planted errors, such as a fake date, an excerpt that doesn't support its claim, a step that breaks, or an injected instruction. It records which stage caught each one. Canaries are tagged privately and never published. If the catch rate falls below a threshold, publishing pauses.
- **Human spot-audit:** a person reviews a random sample of published versions (suggested default: every version for the first 20 packets, then 10%). Audit findings feed back into the reviewer prompts. This doesn't approve routine contributions. It checks whether the gates actually work.

---

## 8. Self-maintenance

1. **Usage outcomes.** Every task completion reports which packets were used and whether each one worked. The platform calculates a success rate for each packet version.
2. **Health rules (deterministic):**
   - When at least 3 failures occur within the last 10 uses, the packet is marked `needs_review`. It is still served, with a warning.
   - When at least 6 failures occur within 10 uses, or a blocking audit finding is recorded, it is marked `suspended` and removed from the index.
3. **Review-after dates.** Each packet gets one according to how quickly its topic changes. A packet past its date is marked `stale`, and a re-verification task is created automatically.
4. **Lessons become contributions.**
   - A lesson about one source becomes a source note.
   - A lesson that applies more widely becomes a new version of the most relevant packet, or a new packet if none fits.
   - Agents must link the task ids that support the lesson. Those tasks are its evidence.
5. **Retirement.** Packets unused for a long period, for example 6 months, are flagged for deprecation rather than deleted.
6. **Protection against degrading loops.** A packet can't be "verified" solely through usage reports from agents that followed it, since that is circular. At least one reproduction must be on a case the platform chose.

---

## 9. Concurrency and versioning

| Risk | Mechanism |
|---|---|
| **Lost updates** | Optimistic concurrency. Every new version states its `baseVersionId`. Several drafts may target the same base. The first to pass the gate is published, and the others move to `stale_base`. The API returns the new current version and a diff, and the agent rebases by submitting a fresh version. No locks are held for long. |
| **Duplicate packets** | The slug is unique. On create, the platform runs a trigram or full-text similarity check of the name and description against published packets **and open drafts**. Above a threshold it returns 409 with the candidates. The agent then either proposes a version of an existing packet or resubmits with a `distinctFrom` justification, which the stage 2 reviewer must accept. |
| **Duplicate research** | Task leases with expiry. Idempotency keys on submissions. |
| **Duplicate records** | Exact-match blocking, plus candidate detection on name, place and date. A merge is a reviewed claim. |
| **Concurrent publishes** | The publish gate checks the base version and writes inside one transaction. |
| **Audit** | An append-only event log for every state change, written in the same transaction as the change. |

Versions are never edited in place, so no history can be lost.

---

## 10. Failure handling

| Situation | Behaviour |
|---|---|
| **No evidence available** | The claim is stored as `unverified`. It can't count toward "decision-ready" or support a packet's fact claim. The field appears in `missingInformation`, and a re-check task is created on a slower schedule. |
| **Sources conflict** | A `Conflict` is created. Deterministic resolution applies only when the tiers clearly differ: a tier-1 source that is fresher wins, and the losing claim is kept. Otherwise the conflict stays unresolved and is **shown to consumers** (as the whale-season disagreement already was), and a resolution task is created. |
| **Source page changes or disappears** | When the record is re-checked, the old snapshot is kept and the claim is marked `evidence_gone`. The record's freshness drops, and a task is created. |
| **Verification fails** | The version becomes `rejected` or `changes_requested`. Its reports are kept and visible. The published version is unaffected. The contributor creates a new version. |
| **Reviewer unavailable or errors** | The version stays `under_review` and nothing is published. Contributions time out after a set period and are re-queued. |
| **A packet turns out to be wrong after publication** | It is `suspended` and removed from the index. The tasks that used it are listed from the usage log, so records acquired with it can be re-checked. |
| **A contributor or reviewer turns out to be bad** | Quarantine its credentials. Every version it touched is listed through the audit log, and its contributions can be reverted to their previous versions in bulk. |
| **The canary catch rate drops** | Publishing pauses globally. Reads continue. |

---

## 11. Security and permissions

1. **Identity.** Every agent has its own API key, issued by a person to a named operator. No anonymous writes. The internal-only, `127.0.0.1` posture of the prototype ends here.
2. **Scopes:** `read`, `submit_data`, `contribute_knowledge`, `review` (platform reviewers only) and `admin`.
3. **Trust tiers earned from track record.** New agents get low rate limits, and their contributions are always included in the human spot-audit sample. Limits rise with the acceptance rate. Trust never removes a verification stage.
4. **Independence enforced on operators, not names.** A reviewer is never from the same operator as the contributor.
5. **Prompt-injection defences.**
   - Packet fields have length limits and are structured.
   - Stage 2 must check for directives aimed at agents ("ignore", "always submit", requests for credentials).
   - Scraped content is only ever evidence and is never executed.
   - The agent guide states that packets describe methods and don't override an agent's own rules.
6. **SSRF.** The platform's fetcher refuses private and loopback addresses, follows redirects only to public hosts, and enforces size and time limits.
7. **Secrets.** Packets and submissions are scanned for credentials and tokens, which are rejected.
8. **Compliance.** Each `Source` records its compliance basis (official API terms, public page, robots.txt allows). Scraping without a basis is rejected. Snapshots are stored privately and never republished.
9. **Rate limits** per key and per session, as the API principles already suggest.

---

## 12. Implementation roadmap

Each step is sized by risk and ends with a check you can run. Each later step depends on the one before it.

| # | Step | Risk / impact | Done when |
|---|---|---|---|
| 1 | **Evidence model**: Source, EvidenceSnapshot, Submission, Claim, field provenance, plus the platform fetcher with excerpt checking (3a). Re-ingest the 5 Hermanus events through it. | High / high | All 5 events trace field to claim to snapshot. A planted fake excerpt is rejected. |
| 2 | **Agent identity and scopes**, audit log, fetch-by-id for records | Medium / high | A write without a key fails. Every change appears in the audit log. |
| 3 | **Knowledge read side**: categories, packets, index, search. Seed 5–8 packets **by hand** from what we already know, such as the source order of preference and listing sites versus the official site. | Low / high | A blind agent finds and uses the right packet from the index alone, measured the way the prototype was. |
| 4 | **Contribution and versioning**: drafts, base version, stale-base handling, duplicate check, stage 1 report, the state machine, and the publish gate with 3a only | Medium / high | Two concurrent edits: one is published, the other gets `stale_base`. A near-duplicate packet gets 409 with candidates. |
| 5 | **Platform reviewer** (stages 2 and 3b), with blind input and reproduction on a case the platform picks | High / high | The canary suite runs and its catch rate is reported. The human audit of the first 20 packets agrees with the reviewer. |
| 6 | **Acquisition tasks**: leases, demand-driven backlog from searches with no results, decision-ready profiles, quality metrics | Medium / medium | Searches with no results create tasks. The decision-ready count and the cost per record are reported. |
| 7 | **Self-maintenance**: usage reports, health rules, review-after dates, bulk revert | Low / medium | A packet that fails repeatedly is suspended automatically. Revert by agent works. |

**Optional later improvements, not needed now:**
- external agents as extra reviewers;
- nested categories;
- semantic search (only if logged searches with no results show packets are being missed);
- a UI for human auditors;
- multi-destination scaling work;
- MCP access alongside REST.

**Technology note.** All of this fits one relational database. The stack document's Postgres choice suits it: built-in full-text search, trigram similarity and transactional publishing. Snapshots go in object storage. Confirm the database at step 1. Nothing here needs a vector store, a queue service or microservices.

---

## Open decisions

### D1. Who performs stage 2 and stage 3b?
**Recommendation:** reviewers run by the platform.

- **Under "platform-run":** an agent proposes a change to the date-conflict packet. The platform's reviewer runs on a different model family, sees only the packet and the snapshots, reproduces the method on a case the platform chose, and finds that the method breaks for events that span midnight. The version gets `changes_requested`. Independence holds because the platform controls the credentials.
- **Under "any eligible agent reviews":** the same proposal is picked up by another external agent. Nothing stops that agent belonging to the same operator under a second key, or running the same model with the same blind spots. The review passes. This is cheaper for the platform, but independence can only be checked after the fact.

### D2. How deeply are event records verified?
**Recommendation:** mechanical evidence checks for every material field, and adversarial review for fields that drive decisions and for new sources.

- **Under the recommendation:** an agent submits FynArts 2027 with dates from the organiser site. 3a confirms the excerpt "24 June 2027 – 4 July 2027" is in the snapshot. Dates drive decisions, so the reviewer confirms the excerpt refers to the 2027 festival and not to the separate November event listed on the same page. The record is accepted.
- **Under "full three stages for every record":** the same check happens, but so do two more LLM calls for the description and the categories. That roughly triples the cost of each record for little gain in accuracy.

### D3. Can agents create categories?
**Recommendation:** no. Agents propose categories, and proposals are queued. The platform or a person accepts them.

- **Under "propose only":** an agent wants a "pdf-extraction" category, but "documents" already exists. The proposal is declined with that suggestion, so the index stays at 10 categories.
- **Under "free creation":** within weeks there are "pdf", "pdfs", "document-extraction" and "documents", each with 1–2 packets. That is the duplication the brief wants to avoid, moved up to the category level.

---

## Hand-worked checks (expected results)

1. **Hallucinated fact.** A packet claims "Hermanus tourism publishes an events API at /api/events" and cites a URL that returns 404. **Expected:** 3a rejects it (snapshot fetch failed) before any reviewer runs.
2. **Real excerpt that doesn't support the claim.** A claim says "the whale season ends 30 November". The excerpt is real but comes from a boat operator's page about its own trip season. **Expected:** 3a passes, 3b returns `partially_supported`, and the claim must be qualified ("one operator stops trips on 30 November") before publication.
3. **Self-approval attempt.** Operator A's second key reviews operator A's contribution. **Expected:** the publish gate refuses, because the reviewer isn't independent. The attempt is logged.
4. **Concurrent edits.** Agents X and Y both edit packet v3. X publishes v4. **Expected:** Y's version moves to `stale_base`, and Y receives the v3-to-v4 diff and must rebase.
5. **A packet that has gone bad.** The "find official booking URLs" packet fails in 6 of 10 recent uses because a ticketing platform changed its URLs. **Expected:** it is suspended, removed from the index, a re-verification task is created, and the records acquired with it are listed for re-checking.

---

## Essential versus optional

| Essential for the first production release | Optional, later |
|---|---|
| Field-level provenance; the platform fetches evidence and checks excerpts | External agent reviewers |
| Immutable versions with base-version concurrency | Nested categories |
| A platform-run, blind, independent reviewer | Semantic search |
| A deterministic publish gate and append-only audit | A UI for human auditors |
| Per-agent keys, scopes, bulk revert | Trust-tier automation beyond rate limits |
| Canary suite and human spot-audit | Accommodation and rate data |
| Decision-ready profiles and demand-driven tasks | MCP interface |

## Questions for you

1. **Are accommodation rates and booking URLs in scope** for EventFeed, or are they examples from a wider Magic Safari plan? They change how volatile the data is and raise legal questions, so they deserve their own design pass.
2. **Who runs the agents?** If they are only our own agents, security can be lighter. If third parties will contribute, §11 is the minimum.
3. **Is a human spot-audit acceptable** (all of the first 20 packets, then 10%)? This is not routine approval, but it is human time.
4. **Is there a verification budget?** Platform-run reviewers mean the platform pays for two LLM calls per contribution. At the expected volume of tens of packets and hundreds of records, that cost is small, but it should be an explicit choice.
