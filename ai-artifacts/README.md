# AI artifacts

AI-generated artifacts produced during development — planning docs, UI mockups,
research notes, and review/test records. Organised by purpose:

| Folder | What's in it |
|--------|--------------|
| [`context/`](context/) | The per-area design + spec pack (00–14). Mostly the up-front plan; **06/07/08 have been updated to the as-built system** (see below). |
| [`claude-design/`](claude-design/) | UI mockups from Claude Design — [`invoice-modal/`](claude-design/invoice-modal/) and [`settings/`](claude-design/settings/) (HTML + screenshots). |
| [`research/`](research/) | External research that informed implementation — [hallucination-mitigation.md](research/hallucination-mitigation.md) with sources. |
| [`reviews/`](reviews/) | The multi-agent code review (3 Sonnet + 2 Opus) and the live API / broken-file / hallucination test runs. |

## Context pack

A per-area spec set produced **before implementation** by a multi-agent Claude
workflow (parallel research → adversarial fact-check → synthesis), to lock in
clear, opinionated decisions. **Start with
[context/00-overview.md](context/00-overview.md)** — the index, stack, flow, and
requirement→doc map.

| File | Covers | State |
|------|--------|-------|
| [00-overview.md](context/00-overview.md) | Index, stack, flow, requirement map, decisions. | updated |
| [02-architecture.md](context/02-architecture.md) | Modules, dependency direction, directory trees, sequence diagram. | original plan |
| [03-data-model.md](context/03-data-model.md) | TypeORM `Invoice` entity, `ExtractedInvoice` shape, status machine. | original plan |
| [04-async-processing.md](context/04-async-processing.md) | BullMQ queue/worker, retry/backoff, idempotency, failure handling. | original plan |
| [05-realtime.md](context/05-realtime.md) | Socket.IO gateway, event contract, worker→client emit. | original plan |
| [06-extraction.md](context/06-extraction.md) | **Multi-engine vision extraction cascade** (Claude/Gemini/Groq), schema, scoring. | **updated to as-built** |
| [07-ai-assistant.md](context/07-ai-assistant.md) | **15-tool multi-engine assistant** (answer + act), SSE streaming, anti-hallucination. | **updated to as-built** |
| [08-rest-api.md](context/08-rest-api.md) | **Full endpoint surface** (invoices CRUD + edit/reprocess, assistant, ai, export, auth). | **updated to as-built** |
| [09-frontend.md](context/09-frontend.md) | React component tree, data layer, socket hook, assistant UI. | original plan |
| [10-run-and-test.md](context/10-run-and-test.md) | Run with/without Docker, env, test strategy, smoke checklist. | original plan |
| [11-decisions-and-risks.md](context/11-decisions-and-risks.md) | Decision log, risks/edge cases, "with more time" backlog. | original plan |
| [12-ai-roadmap.md](context/12-ai-roadmap.md) | The pivot to Gemini/Groq, model switcher, stats, analytics — supersedes the original Claude assistant plan. | post-build |
| [13-assistant-test-scenarios.md](context/13-assistant-test-scenarios.md) | 52 graded conversational scenarios for the assistant. | post-build |
| [14-manual-test-plan.md](context/14-manual-test-plan.md) | Hands-on assistant prompts + "bad invoice" upload checklist. | post-build |

> The **original plan** docs (02–05, 09–11) end with a "Fact-check & corrections
> to apply" section — the output of an adversarial review agent that audited the
> draft. The system as actually built diverged in places (notably:
> vision-extraction instead of OCR→Claude, multi-engine instead of Claude-only,
> added auth/export/analytics). Where that divergence matters most, **06/07/08
> have been rewritten to match the shipped code**; the rest are kept as the
> historical plan, with [12-ai-roadmap.md](context/12-ai-roadmap.md) bridging the
> gap.

## How it was generated

- **Up-front design (context/):** ~10 agents, one per area, each writing a
  concrete, code-bearing spec grounded in the actual scaffold, then an
  adversarial reviewer per draft, then synthesis.
- **Mockups (claude-design/):** UI designs produced in Claude Design from
  detailed prompts, kept with their screenshots.
- **Review & tests (reviews/):** a second multi-agent pass (3 Sonnet + 2 Opus)
  audited the finished code, cross-compared, and was manually verified; the API,
  broken-file, and adversarial assistant tests were run against the live backend.
