# Invoice Processing System — Context Pack (Overview & Index)

This folder is the **design context pack** for the Invoice Processing System
assignment. It was produced up front, before implementation, to lock in clear
decisions and a clean architecture so the build is mechanical rather than
exploratory.

> **⚠️ Updated to as-built.** This pack was the *plan*. The shipped system
> diverged in three big ways, so docs **06 (extraction)**, **07 (assistant)** and
> **08 (REST API)** have been **rewritten to match the real code**; the rest are
> kept as the historical plan. The divergences:
>
> - **Extraction** is **multi-engine vision** (Claude / Gemini read the document
>   directly), not OCR→Claude-text. `pdf-parse`+Groq is only a last-resort
>   fallback; `tesseract.js` was dropped. A cascade scores attempts and keeps the
>   best.
> - **AI is multi-provider** (Claude `claude-haiku-4-5` + Gemini + Groq),
>   runtime-switchable — not Claude-only. The assistant grew from 6 tools to
>   **15** (filter, edit-with-confirm, reprocess, suggestions, navigate, charts,
>   export…), streams progress over **SSE**, and has explicit
>   **anti-hallucination guards**.
> - **Added beyond the plan:** JWT auth, xlsx/csv/zip export, an analytics
>   dashboard, and a runtime model switcher.
>
> See [12-ai-roadmap.md](12-ai-roadmap.md) for the pivot, and the
> [reviews/](../reviews/) folder for the post-build code review + test runs.

> **How these docs were made.** A multi-agent Claude workflow researched each
> area in parallel, then a separate adversarial reviewer fact-checked every
> draft (model ids, Anthropic tool-use message format, BullMQ / NestJS / TypeORM
> APIs). Each area doc carries its reviewer's findings in a **“Fact-check &
> corrections to apply”** section at the end — read those before copying code,
> they catch real mistakes (e.g. the BullMQ failure-handling guard). The docs
> are kept **as-is** per the assignment deliverables.

---

## 1. The problem

Build a full-stack app to upload invoices (PDF / image), process them
asynchronously, show live status, expose the extracted data, allow retry of
failures, and provide an AI assistant that can both **answer questions** and
**take actions** against the invoices.

Lifecycle every invoice moves through:

```
uploaded → processing → completed / failed     (failed → processing on retry)
```

## 2. Chosen stack

| Layer            | Choice                                                        | Why (one line)                                              |
|------------------|--------------------------------------------------------------|-------------------------------------------------------------|
| Backend          | **NestJS 10 + TypeScript 5** (Express)                       | Modular DI fits the queue/gateway/assistant decomposition.  |
| ORM / DB         | **TypeORM + PostgreSQL 16**                                  | `jsonb` for extracted data; `synchronize` = zero-migration dev. |
| Async / queue    | **BullMQ on Redis 7**                                        | Durable jobs, built-in retry/backoff for the async pipeline. |
| Real-time        | **WebSocket — `@nestjs/websockets` + Socket.IO**            | Push status deltas; no polling, no manual refresh.          |
| Extraction       | _As built:_ **multi-engine vision cascade** (Claude / Gemini read the doc; `pdf-parse`+Groq fallback) | Vision handles scans/layout; cascade scores attempts, keeps the best. |
| AI assistant     | _As built:_ **multi-engine tool use** (Claude / Groq / Gemini) over `InvoicesService`, SSE-streamed | 15 tools (answer + act), runtime-switchable engine, anti-hallucination guards. |
| Frontend         | **Vite + React 18 + TS**, `socket.io-client`                | Fast dev; list-as-source-of-truth patched by live events.   |
| Infra            | **Docker Compose** (postgres, redis, optional backend)      | One-command infra; native-node path documented for no-Docker. |
| Models           | Extraction: **`claude-haiku-4-5`** · Assistant: **`claude-sonnet-4-6`** (both env-switchable) | Haiku for bounded structuring; Sonnet for reasoning over tools. |

## 3. End-to-end flow

```
 Frontend (Vite/React)                 NestJS backend (:3000)                     Infra
 ─────────────────────                 ──────────────────────                     ─────
  UploadDropzone ── POST /invoices ──►  InvoicesController
                                         │ persist row (status=uploaded) ───────►  Postgres
                                         │ producer.enqueue(id) ────────────────►  Redis (BullMQ)
                                         │ realtime.emit(invoice:status) ─┐
   ◄── 201 invoice (status=uploaded) ───┘                                 │
   InvoiceList row appears  ◄═══════════ WebSocket (Socket.IO) ◄══════════┘

                                        BullMQ Worker (@Processor → WorkerHost)
                                         │ status=processing ──► Postgres ──► emit ═► spinner
                                         │ OCR (pdf-parse | tesseract) ──► rawText
                                         │ Claude (forced extract_invoice tool) ──► ExtractedInvoice JSON
                                         │ status=completed + data ──► Postgres ──► emit ═► data shows
                                         └ on exhausted retries: status=failed + errorMessage ─► emit ═► Retry btn

  Retry button ── POST /invoices/:id/retry ──► guard status=failed ──► re-enqueue (new job)
  AssistantPanel ── POST /assistant/chat ────► Claude tool-use loop ──► list/get/stats/retry_invoice
```

## 4. Requirement → where it’s solved

| TASK.md requirement                                   | Solved by                                             | Doc |
|-------------------------------------------------------|-------------------------------------------------------|-----|
| Invoice upload (PDF or image)                         | `POST /invoices` multipart + Multer fileFilter/limits | [08-rest-api](08-rest-api.md), [02-architecture](02-architecture.md) |
| List of invoices with current status                  | `GET /invoices` + `InvoiceList`                       | [08-rest-api](08-rest-api.md), [09-frontend](09-frontend.md) |
| Real-time status updates (no refresh)                 | Socket.IO gateway emits `invoice:status`; client patches list | [05-realtime](05-realtime.md) |
| Extracted data visible once completed                 | `jsonb extractedData` → `InvoiceDetail`               | [03-data-model](03-data-model.md), [06-extraction](06-extraction.md), [09-frontend](09-frontend.md) |
| Async processing pipeline                              | BullMQ worker: OCR → Claude → persist                 | [04-async-processing](04-async-processing.md), [06-extraction](06-extraction.md) |
| Retry mechanism for failures                          | `POST /invoices/:id/retry` (guarded, re-enqueues)     | [04-async-processing](04-async-processing.md), [08-rest-api](08-rest-api.md) |
| AI assistant that answers about invoices              | `list_invoices` / `get_invoice` / `get_stats` tools   | [07-ai-assistant](07-ai-assistant.md) |
| AI assistant that **takes actions**                   | `retry_invoice` tool (headline action)                | [07-ai-assistant](07-ai-assistant.md) |
| README: approach / improvements / AI usage            | Final README + this pack                              | [11-decisions-and-risks](11-decisions-and-risks.md) |
| Clear run & test instructions                         | Two run paths (Docker / native) + smoke checklist     | [10-run-and-test](10-run-and-test.md) |

## 5. The doc set

| File | What it covers |
|------|----------------|
| [00-overview.md](00-overview.md) | This index — problem, stack, flow, requirement map, decisions. |
| [02-architecture.md](02-architecture.md) | Module decomposition, dependency direction, directory trees, `app.module` wiring, sequence diagram. |
| [03-data-model.md](03-data-model.md) | `Invoice` entity, `ExtractedInvoice` shape (jsonb vs entity), status state machine, indexing, synchronize-vs-migrations. |
| [04-async-processing.md](04-async-processing.md) | BullMQ queue/worker (`WorkerHost`), retry/backoff, manual-retry vs auto-retry, idempotency, failure handling. |
| [05-realtime.md](05-realtime.md) | Socket.IO gateway, event contract, worker→client emit, reconnection/initial-state, WebSocket-vs-SSE. |
| [06-extraction.md](06-extraction.md) | File-type branch, OCR caveats, Claude forced-tool structuring, schema, model/cost tradeoff, error cases. |
| [07-ai-assistant.md](07-ai-assistant.md) | Tool set, agentic loop, `tool_use`/`tool_result` format, action guarding, chat API shape. |
| [08-rest-api.md](08-rest-api.md) | Endpoints, DTOs, status codes, Multer config, CORS, validation. |
| [09-frontend.md](09-frontend.md) | Component tree, data layer (react-query vs fetch), socket hook, upload UX, assistant UI, deps to add. |
| [10-run-and-test.md](10-run-and-test.md) | Run with/without Docker, env vars, unit/e2e strategy, mocking Anthropic+OCR, smoke checklist, fixtures. |
| [11-decisions-and-risks.md](11-decisions-and-risks.md) | Decision log (Decision/Why/Rejected), risks & edge cases, “with more time” backlog. |

## 6. Headline decisions

| Decision | Why | Rejected alternative |
|----------|-----|----------------------|
| TypeORM + `synchronize` in dev | Zero migration step → trivial setup (matters with no Docker) | Prisma; TypeORM migrations in dev |
| BullMQ for async | Durable jobs + built-in retry/backoff, Redis already in stack | Hand-rolled `setTimeout`/in-memory queue |
| WebSocket (Socket.IO) for real-time | Bidirectional, reconnection, broad client support | SSE (fine, but one-way; documented as alt) |
| OCR → Claude (not Claude-vision-only) | Cheap text extraction first; Claude only structures | Send raw PDF/image straight to Claude vision |
| `extractedData` as `jsonb` column | One shape = tool schema = storage; no join | Separate `ExtractedData` entity |
| Assistant tools wrap `InvoicesService` | No duplicated logic; assistant can’t reach an illegal state | Assistant issues raw SQL / its own queries |
| Worker writes DB via repository directly | Breaks `Invoices ↔ Processing` cycle; one-way dependency | Worker imports `InvoicesService` |
| Single-user, no auth | Assignment scope; keeps focus on the async/AI core | Full auth/multi-tenant up front |

Full reasoning and the risk register live in
[11-decisions-and-risks.md](11-decisions-and-risks.md).

## 7. How to use this pack

1. Start here, then read [02-architecture.md](02-architecture.md) for the module
   map and directory tree.
2. Implement bottom-up: data model → queue/worker → extraction → realtime →
   REST → assistant → frontend.
3. **Before copying any code block, read that doc’s “Fact-check & corrections to
   apply” section** — it lists the HIGH/MED fixes the review agent found (the
   BullMQ `WorkerHost` / `@OnWorkerEvent` + `attemptsMade` guard is the most
   important one).
4. [10-run-and-test.md](10-run-and-test.md) is the acceptance checklist — each
   TASK.md requirement maps to a verification step.

> **Security note:** the Anthropic API key was pasted into a chat during setup,
> so it must be treated as compromised and **rotated** at
> <https://console.anthropic.com> after the assignment. Tracked in
> [11-decisions-and-risks.md](11-decisions-and-risks.md).
