# Agent usability report

## Rebuilt pipeline (MCP and REST, 14 tools)

**Method.** A fresh sub-agent received only the endpoint and a 7-step task. It used plain HTTP calls to the MCP server and read no files.

**Result.** It completed all 7 steps in about 20 requests with no errors:

1. discover the tools;
2. read the glossary and knowledge base;
3. upload an event with evidence from the live FynArts site;
4. update it;
5. check the field sources;
6. propose a glossary term;
7. review that proposal as a second agent.

The approved term re-tagged the record automatically.

**Findings and fixes:**

| Finding | Fix |
|---|---|
| A reviewer's "re-fetch" got the cached copy from the last 10 minutes | Added `fetch_source { fresh: true }`, and the review instructions now tell reviewers to use it |
| An excerpt only had to appear on the page, not state the value | Dates and prices must now have their numbers in the excerpt (`EVIDENCE_DOES_NOT_SUPPORT`) |
| Region and country showed no provenance | They are now labelled as derived from the town |
| Approval said "updated" for a newly added term | It now says added, updated or deprecated |

**Not changed.** Text fields such as description are still checked only for the presence of the excerpt. Whether the excerpt actually supports the text is left to reviewers. Every MCP response carries the envelope twice, once as text and once as structured content, because many clients read only one of the two.

Earlier prototype rounds are in `.backup/prototype-v0/`.
