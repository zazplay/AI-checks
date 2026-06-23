# Reducing LLM hallucinations in the invoice assistant

> External research (web, 2025–2026) on stopping LLM tool-use hallucinations —
> specifically the "invented entity id" class of bug we hit (the assistant
> calling `delete_invoice` with a made-up id like `"1"`). Captures the
> best-practice findings, maps each to what this codebase already does, and
> lists the gaps we chose to close. Kept here (not in `context/`) because it is
> external research, not part of the up-front design pack.

## The bug that prompted this

The assistant was asked to "delete the largest overdue invoice" and called
`delete_invoice` with a fabricated id instead of first looking the invoice up.
This is a textbook **entity-ID hallucination**: a plausible-looking reference
(an id, a number, an API name) that does not exist. They are dangerous because
they read as credible and, for a destructive tool, would act on nothing — or the
wrong thing — if unguarded.

## What the literature says (and our mapping)

| Practice (sources below) | Status in this repo |
|---|---|
| **Argument correctness > parameter count** — tool-use reliability hinges on correct arguments and strict schema adherence, not on how many params a tool has. | ✅ class-validator DTOs, `ParseUUIDPipe`, regex-guarded jsonb casts. |
| **Verify generated entity IDs exist before acting**; refuse when confidence is insufficient. | ✅ `isUuid()` + resolve-to-real-invoice in `buildDeletePending`/`buildUpdatePending`; if nothing resolves, we refuse and tell the model to look it up. |
| **Grounding: IDs must come from a tool result**, never from the model's "knowledge". | ✅ system prompt now states real ids only ever come from a tool result, with a worked find→act example. |
| **Static, audited tool descriptions** (no user content; schema clarity reduces hallucination). | ✅ tool descriptions are frozen strings; we hardened them to say ids must be real UUIDs from a finder. |
| **Server-side truncation; never pipe raw blobs** back to the model. | ✅ `compact`/`compactDetailed` return token-bounded projections, not raw rows/files. |
| **Execute / verify / approve separation** (a checkpoint between deciding and doing). | ✅ destructive tools (delete, edit) are gated behind an HMAC-signed human confirmation. |
| **Multi-layer defense incl. a regex scanner for ungrounded patterns** in the *text* output. | ⚠️ Partial — we guard tool *arguments*; we do not yet scan the assistant's prose for ungrounded ids/figures. Deferred (false-positive risk). |
| **Multi-agent validation** (one agent acts, another verifies). | ➖ Out of scope for a single-user assistant; the HMAC confirm is our human-in-the-loop checkpoint. |

## What we changed as a result

1. **Strengthened the "no invented ids" rule** in the system prompt with an
   explicit find-then-act protocol and a worked example
   ("delete the largest overdue invoice" → `filter_invoices(overdue, amount_desc,
   limit 1)` → take the returned id → `delete_invoice(id)`), same turn.
2. **Unified the destructive-tool gate** across all three engines (Gemini, Groq,
   Claude) so edits and deletes both resolve real ids before asking to confirm;
   a token is never signed for ids that don't exist.
3. **UUID guard on every id-taking tool** (not just delete/update): `isUuid`
   validation with a friendly "look it up first" error instead of a raw 404 /
   Postgres `invalid input syntax for type uuid`.
4. **Hardened tool descriptions** to state ids must be real UUIDs taken from a
   finder result.

## Principles to keep (cheat-sheet)

- **Ground every reference.** Any id/number the assistant acts on must trace back
  to a tool result, not to the prompt or the model's prior.
- **Validate at the boundary.** Shape-check arguments (UUID, enum, range) before
  they reach the DB; convert a throw into a clear, model-readable error.
- **Refuse over guess.** When an id can't be resolved, say so and tell the model
  to find it first — never fall through to a fabricated value.
- **Gate the irreversible.** Deletes and edits pass through an explicit human
  confirmation; the model can propose, only the user disposes.
- **Keep payloads small.** Hand back compact projections, not raw blobs — less to
  misread, fewer tokens, lower drift.

## Sources

- [LLM Function-Calling Pitfalls Nobody Mentions — Medium](https://medium.com/@2nick2patel2/llm-function-calling-pitfalls-nobody-mentions-a0a0575888b1)
- [ToolScan: A Benchmark for Characterizing Errors in Tool-Use LLMs (arXiv 2411.13547)](https://arxiv.org/pdf/2411.13547)
- [Reducing Tool Hallucination via Reliability Alignment (arXiv 2412.04141)](https://arxiv.org/pdf/2412.04141)
- [ToolCritic: Detecting and Correcting Tool-Use Errors in Dialogue Systems (arXiv 2510.17052)](https://arxiv.org/pdf/2510.17052)
- [MIRAGE-Bench: LLM Agent is Hallucinating and Where to Find Them (arXiv 2507.21017)](https://arxiv.org/pdf/2507.21017)
- [Small Language Models for Agentic Systems: A Survey (arXiv 2510.03847)](https://arxiv.org/pdf/2510.03847)
- [8 Ways to Prevent LLM Hallucinations — Airbyte](https://airbyte.com/agentic-data/prevent-llm-hallucinations)
- [LLM Hallucination Detection and Mitigation: Best Techniques — Deepchecks](https://deepchecks.com/llm-hallucination-detection-and-mitigation-best-techniques/)
- [How to Stop AI Agents from Hallucinating Silently with Multi-Agent Validation — DEV](https://dev.to/aws/how-to-stop-ai-agents-from-hallucinating-silently-with-multi-agent-validation-3f7e)
- [Grounding LLMs with Fresh Web Data to Reduce Hallucinations — Towards Data Science](https://towardsdatascience.com/grounding-llms-with-fresh-web-data-to-reduce-hallucinations/)
