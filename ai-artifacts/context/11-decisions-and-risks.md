# Key Decisions, Risks & Future Work

This document captures the architectural decisions, known risks/edge-cases, and the deferred-work backlog for the invoice-processing service. It is deliberately scoped to an assignment-grade build: enough rigor to defend the choices, no premature scaling.

---

## 1. Key Decisions Log

Format: **Decision / Why / Alternatives rejected.**

### 1.1 ORM: TypeORM over Prisma

- **Decision:** TypeORM (`typeorm` + `pg`), entities for `Invoice` and `ExtractionResult`, migrations checked into the repo.
- **Why:** First-class NestJS integration via `@nestjs/typeorm` — repositories inject cleanly into providers, DI-managed connection pool, decorator-driven entities match the Nest mental model. The team already runs Nest's lifecycle hooks, so a Nest-native ORM keeps the wiring trivial.
- **Alternatives rejected:**
  - *Prisma* — excellent DX and type-safety, but it owns its own client generation step and connection lifecycle, which fights Nest's DI. Migrations live outside the Nest module graph, and transactional `Queryable` passing through BullMQ workers is awkward. The type-safety win doesn't pay for the integration friction at this size.
  - *Raw `pg` / Knex* — too much hand-rolled mapping for a CRUD-shaped domain.

### 1.2 Queue: BullMQ over a custom in-process queue

- **Decision:** BullMQ (`bullmq` + `@nestjs/bullmq`) on Redis 7. One queue `invoice-extraction`, one processor, jobs keyed by `invoiceId`.
- **Why:** Extraction is slow (OCR + a Claude round-trip = seconds to tens of seconds) and must survive process restarts. BullMQ gives us durable jobs, automatic retries with backoff, concurrency control, and a job lifecycle that maps 1:1 onto the invoice lifecycle. Retry-from-failed (a hard requirement) is a built-in `job.retry()` rather than something we invent.
- **Alternatives rejected:**
  - *Custom `setImmediate`/in-memory queue* — loses every job on crash, no backoff, no visibility. The retry requirement alone kills it.
  - *`pg-boss` (Postgres-backed queue)* — avoids the Redis dependency but the stack already mandates Redis for nothing else yet; BullMQ's ecosystem (Bull Board, events) is stronger and the Socket.IO adapter wants Redis anyway at scale.

### 1.3 Real-time: WebSocket (Socket.IO) over SSE

- **Decision:** `@nestjs/websockets` + Socket.IO gateway. Worker emits `invoice.status.changed` events; gateway pushes to subscribed clients.
- **Why:** The task is bidirectional in spirit — the assistant chat and live status both ride one transport. Socket.IO gives rooms (per-invoice or per-user subscriptions), automatic reconnection, and a typed client. One connection serves both status updates and assistant streaming.
- **Alternatives rejected:**
  - *Server-Sent Events* — simpler and HTTP-native, genuinely sufficient for *status-only* push. Rejected because we'd still need a second channel for the assistant; consolidating on Socket.IO avoids running two real-time mechanisms. SSE is the right call if the assistant were request/response only — noted as a viable simplification.
  - *Polling* — explicitly disallowed ("no manual refresh") and wasteful.

### 1.4 Extraction: OCR/text-extract → Claude over Claude-vision-only

- **Decision:** Branch on input. Text PDFs → `pdf-parse` (cheap, exact). Scanned PDFs/images → Tesseract.js OCR. Either way, the extracted text is handed to Claude, which structures it into JSON via `output_config.format` (a strict JSON schema) — see §1.6.
- **Why:** Most invoices are text PDFs; `pdf-parse` extracts their text losslessly for near-zero cost and latency, and Claude only does the *structuring*, which it's excellent at. Sending text instead of an image is dramatically cheaper (image tokens are expensive — a full-res page can be thousands of tokens) and avoids vision-transcription errors on dense tabular line items.
- **Alternatives rejected:**
  - *Claude vision on the page image for everything* — simplest pipeline (one call, no OCR dependency) and more robust on bad scans, but costs more per invoice, is slower, and over-reads on line-item tables. We keep vision as a *fallback* path conceptually but don't default to it.
  - *Pure OCR + regex/heuristics, no LLM* — brittle against the long tail of invoice layouts; the whole point of using Claude is layout-agnostic structuring.

### 1.5 Model: Sonnet 4.6 default, Haiku 4.5 as the cost lever

- **Decision:** Default extraction + assistant model `claude-sonnet-4-6`. Make it env-configurable so a deployment can drop to `claude-haiku-4-5`.
- **Why:** This is a cost-sensitive, high-volume, structured-extraction task — not frontier reasoning. **Sonnet 4.6** ($3 / $15 per 1M in/out, 1M context, 64K output) is the sweet spot: strong structured-output and tool-use accuracy at a fraction of Opus pricing. **Haiku 4.5** ($1 / $5 per 1M, 200K context) is ~3× cheaper on input and the right choice once extraction prompts are stable and the schema is locked — the tradeoff is somewhat lower accuracy on messy/ambiguous invoices and no `effort`/`max` thinking control. Recommendation: **build and validate on Sonnet 4.6, then A/B Haiku 4.5 against a labeled set; switch per-deployment if accuracy holds.** (Opus is not justified here — its reasoning depth is wasted on field extraction.)
- **Alternatives rejected:**
  - *Opus 4.8* — overkill and ~1.6× Sonnet's input price; reserve for genuinely hard reasoning, not invoice fields.
  - *Hard-coding one model* — removes the cost lever; config-driven model id costs nothing and lets ops tune the bill.

### 1.6 Structuring: `output_config.format` (strict JSON schema) over tool-use or prefill

- **Decision:** Call `messages.create` with `output_config: { format: { type: "json_schema", schema: INVOICE_SCHEMA } }`. The schema pins `vendor`, `invoiceNumber`, `issueDate`, `dueDate`, `currency`, `totals`, and a `lineItems[]` array. Parse the single text block as JSON.
- **Why:** Structured outputs *guarantee* schema-valid JSON, eliminating the parse-failure class of bugs entirely. It's the canonical API surface for "give me this exact shape." Simpler than orchestrating a tool-call round-trip for a one-shot extraction.
- **Alternatives rejected:**
  - *Tool use / function calling for extraction* — works, but a tool call is a round-trip designed for *actions*; for a pure data-shape constraint, `output_config.format` is more direct. (We *do* use tool use for the assistant — see §1.8 — because that genuinely takes actions.)
  - *Assistant-turn prefill (`{"role":"assistant","content":"{"}`)* — **returns a 400 on Sonnet 4.6 / Haiku 4.5 / the 4.x family.** Not an option even if we wanted it.

### 1.7 Persistence: `jsonb` extracted-data column over a fully-normalized line-item entity

- **Decision:** `Invoice` carries the lifecycle/status columns and metadata; the structured extraction result lives in a `jsonb` column (or a one-to-one `ExtractionResult` entity holding `jsonb`). Line items are *not* exploded into their own table.
- **Why:** Invoice schemas vary wildly across vendors; the extracted shape is read-as-a-blob by the UI and the assistant, never joined or aggregated across invoices in this build. `jsonb` keeps the schema flexible (no migration when we add a field), stores the whole Claude result atomically, and Postgres can still index/query into it (`->>`) if we later need to. Normalizing line items now would be speculative.
- **Alternatives rejected:**
  - *Normalized `LineItem` table (one-to-many)* — correct if we needed per-line-item analytics, reporting, or cross-invoice aggregation. We don't, yet. Adds join complexity and migration churn for zero current benefit. Flagged in §3 as the right move *if* reporting is added.

### 1.8 AI assistant: Claude tool use (answer **and** act), single-user, no auth

- **Decision:** The assistant runs a Claude tool-use loop with a small toolset: `list_invoices(status?, vendor?)`, `get_invoice(id)`, `retry_invoice(id)`. Claude both answers ("what's the status of the ACME invoice?") and acts ("retry the failed ones"). Each tool maps to an existing service method — the assistant calls the same `InvoiceService.retry()` the REST endpoint does. **No authentication; the app is single-user.**
- **Why:** "Take actions, not just answer" is a hard requirement, and tool use is the native mechanism — Claude emits a `tool_use` block, our handler executes the bound service method and returns a `tool_result`. Dedicated tools (not a generic "run SQL") give us a typed, auditable, gate-able surface. Single-user + no-auth is a *deliberate scope cut* for an assignment: it removes an entire subsystem (sessions, RBAC, per-tenant data isolation) that adds no signal to the thing being evaluated.
- **Alternatives rejected:**
  - *Answer-only assistant (RAG over invoice rows)* — fails the explicit "take actions" requirement.
  - *Generic SQL/`bash` tool* — powerful but unsafe (the assistant could mutate arbitrary state) and impossible to gate; dedicated tools are the agent-design-correct choice.
  - *Building auth now* — wrong altitude for the assignment; see §3.1 for how it slots in later.

---

## 2. Risks & Edge Cases

Ordered roughly by likelihood × blast radius. Each has a stance, not just a worry.

| # | Risk / edge case | Stance for this build |
|---|---|---|
| 1 | **Secret handling — the Anthropic API key was pasted into chat.** | **Treat it as compromised and rotate it immediately** in the Anthropic Console; the pasted key must never reach the repo. Load `ANTHROPIC_API_KEY` from env only (`@nestjs/config`), keep `.env` in `.gitignore`, and add `.env.example` with placeholders. Never log the key; never echo it in error messages. |
| 2 | **Huge files** (100MB scanned PDF, multi-hundred-page doc). | Enforce an upload size cap at the Multer/body layer (e.g. 25MB) and reject early with 413. Cap OCR page count. Without a limit, Tesseract.js can pin a CPU and starve the worker; a page-count guard bounds latency and Claude token cost. |
| 3 | **Non-invoice uploads** (a photo, a contract, a blank page). | Extraction won't crash — Claude returns schema-valid JSON with empty/null fields. Add a `confidence`/`isInvoice` signal to the schema so the UI can flag "this doesn't look like an invoice" rather than silently storing garbage. Mark such results `completed` but low-confidence, not `failed`. |
| 4 | **OCR garbage** (skewed scan, low DPI, handwriting). | Two-layer: if `pdf-parse`/Tesseract yields near-empty text, fail fast *before* paying for a Claude call. If text is present but noisy, Claude still extracts what it can — surface low confidence rather than asserting correctness. Don't pretend bad OCR is a clean read. |
| 5 | **Claude rate limits / cost** (429, token spend per invoice). | The Anthropic SDK auto-retries 429/5xx with backoff; BullMQ retries the *job* on top of that. Cap input tokens by sending extracted text, not page images (§1.4). Use `count_tokens` to reject pathologically large inputs pre-flight. Model is config-driven so cost can be tuned (§1.5). |
| 6 | **Worker crash mid-job.** | Jobs are durable in Redis; BullMQ re-delivers an interrupted job to another worker (stalled-job detection). The DB write that flips `processing → completed/failed` is the *last* step and is idempotent (keyed on `invoiceId`), so a re-run can't double-write a half-result. Status stays `processing` until a terminal write lands. |
| 7 | **Duplicate uploads** (same invoice submitted twice). | For an assignment, dedupe on a content hash (SHA-256 of the file bytes) at upload: same hash → return the existing invoice instead of creating a second. Lightweight, no false negatives on byte-identical files. (Semantic dedup — same invoice, re-scanned — is out of scope; noted in §3.) |
| 8 | **Redis down.** | The queue and the Socket.IO scale-out both depend on Redis. If Redis is unreachable: uploads still persist to Postgres (status `uploaded`), but extraction can't be enqueued — surface a degraded-mode error rather than 500-ing, and let the upload be retried once Redis returns. Document this as a known single point of failure for the assignment. |
| 9 | **Claude returns `stop_reason: "refusal"`** (rare, but a real 200-response branch). | Check `stop_reason` before reading `content[0]` — a refusal has empty/partial content and would otherwise throw on index access. On refusal, mark the invoice `failed` with a clear reason so it can be retried, don't crash the worker. |
| 10 | **Partial/inconsistent status from concurrent updates.** | Single source of truth for status is the DB row; the Socket.IO event is *derived* from a committed write, never the other way round. Emit the event *after* the transaction commits to avoid pushing a status the DB doesn't yet reflect. |

---

## 3. "What I'd Improve With More Time" — Backlog

Prioritized; each item names the trigger that would make it worth doing.

1. **Authentication + authorization.** Add Nest `AuthGuard` (JWT or session), scope every invoice query to the owner. *Trigger: more than one user.* Slots cleanly onto the existing service layer — the assistant tools already go through `InvoiceService`, so they inherit auth for free.
2. **Multi-tenancy.** Tenant column + row-level scoping (or RLS in Postgres), per-tenant rate budgets for Claude. *Trigger: this becomes a product, not a demo.*
3. **Object storage (S3/MinIO).** Store the original file in S3, keep only a key in Postgres. *Trigger: files outgrow local disk, or you want them durable across container restarts.* Today the raw file on local disk is a data-loss risk.
4. **Observability / tracing.** OpenTelemetry spans across upload → queue → OCR → Claude → DB, structured logging, and a dashboard for queue depth + per-stage latency + token spend. *Trigger: anything you'd debug in production.* Right now failures are diagnosed by reading logs.
5. **Confidence scores + human-in-the-loop correction.** Per-field confidence in the schema; low-confidence fields surface in the UI for a human to correct, and corrections feed back as labeled data. *Trigger: extraction accuracy becomes a business metric.* This is the highest-value AI improvement.
6. **Better OCR.** Swap Tesseract.js for a managed OCR (Google Document AI / Textract) or Claude vision as a fallback on low-confidence text-extracts. *Trigger: scanned-invoice accuracy is too low.*
7. **Dead-letter queue.** Jobs that exhaust retries land in a DLQ for inspection instead of vanishing into `failed`. *Trigger: you need to triage *why* things fail at volume, not just see that they did.*
8. **Streaming assistant responses.** Stream Claude's reply token-by-token over the existing Socket.IO channel for a snappier chat. *Trigger: assistant answers feel slow.* Low effort given the transport already exists.
9. **Pagination + virtualized invoice list.** Cursor pagination on the REST list endpoint; virtualized rendering on the frontend. *Trigger: the list exceeds a few hundred rows.* Today an unbounded `find()` would be a problem at scale.
10. **Normalized line items.** Promote `lineItems` from `jsonb` to a `LineItem` table. *Trigger: cross-invoice reporting/analytics (spend by vendor, line-item search).* See §1.7 — deliberately deferred.
11. **E2E + extraction-accuracy tests.** Playwright happy-path (upload → live status → result → retry → assistant action), plus a fixture set of real invoices scored against expected JSON to catch extraction regressions when prompts or models change. *Trigger: any change to the extraction prompt, schema, or model.* The accuracy harness is what makes the Haiku-vs-Sonnet decision (§1.5) data-driven instead of a guess.

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

## Review: "Risks, decisions log, and what I'd improve"

Overall this is a strong, internally consistent document. The Anthropic/Claude-specific claims are unusually accurate for a draft — model IDs, pricing, `output_config.format`, the prefill-400 behavior, and the refusal branch are all correct. The errors that remain are mostly in the supporting-stack details (BullMQ, TypeORM, Multer) and a couple of overstated/imprecise Claude claims.

### Claude / Anthropic API

- [SEVERITY low] §1.5 calls Haiku 4.5 "~3× cheaper on input" than Sonnet 4.6. -> Haiku is $1/1M input vs Sonnet's $3/1M — that's exactly 3× cheaper on input (and 3× on output, $5 vs $15), so "~3×" is right but "~3× cheaper on input" undersells output; minor, not an error. The "no `effort`/`max` thinking control" claim for Haiku 4.5 is **correct** (effort errors on Haiku 4.5).
- [SEVERITY low] §1.5 says Opus 4.8 is "~1.6× Sonnet's input price." -> Opus 4.8 is $5/1M input, Sonnet 4.6 is $3/1M, so 5/3 ≈ 1.67× — accurate. No change needed; flagging only because it reads like a guess and happens to be right.
- [SEVERITY med] Risk #9 says a refusal "has empty/partial content and would otherwise throw on index access," and the doc only ever describes the pre-output case. -> Correct that you must check `stop_reason` before reading `content[0]`, but be precise: a *pre-output* refusal has an **empty `content` array and is not billed**; a *mid-stream* refusal returns **partial content that IS billed** and must be discarded. The draft's "empty/partial" is loosely right but the billing distinction (and "discard the partial") is the part a senior reviewer would want stated.
- [SEVERITY low] Risk #5 / §1.5 lean on `count_tokens` as a pre-flight guard ("Use `count_tokens` to reject pathologically large inputs"). -> Valid and supported (`client.messages.count_tokens` / `POST /v1/messages/count_tokens`), but note it's a **billable-free network round-trip per upload**, not a local estimate — for a guard you'd typically cap bytes/pages first (which the doc already does in risk #2) and only call `count_tokens` when near the limit. Not wrong, just worth not implying it's free/local.
- [SEVERITY low] §1.6 "Parse the single text block as JSON" — correct, but the canonical/safer SDK path for this exact use case is `client.messages.parse()` with a schema (TS: `messages.parse` + `zodOutputFormat`), which validates for you. The manual `output_config.format` + `json.loads(text)` works; just noting the doc presents the lower-level path as the only one.

### BullMQ

- [SEVERITY med] §1.2 / §1.8 describe retry-from-failed as "a built-in `job.retry()`." -> In BullMQ the method on a `Job` instance is `job.retry()` (optionally `job.retry('failed')`), which is correct — **but** the assistant's `retry_invoice` tool and the REST endpoint almost certainly don't hold a live `Job` object; they hold an `invoiceId`. To retry you must first fetch the job (`queue.getJob(jobId)` then `job.retry()`), or re-add a new job. The doc's claim that the tool "calls the same `InvoiceService.retry()` the REST endpoint does" is fine, but "retry-from-failed is a built-in `job.retry()` rather than something we invent" glosses over the job-lookup step. Minor, but a reviewer would flag that `job.retry()` needs a job handle you don't have at the API/tool boundary.
- [SEVERITY low] §1.2 names the decorator stack as "`bullmq` + `@nestjs/bullmq`." -> Correct package names (the NestJS integration is `@nestjs/bullmq`, processors via the `@Processor()` class decorator + `WorkerHost`, not the legacy `@nestjs/bull`). No error; confirming it's right since it's an easy one to get wrong.
- [SEVERITY low] Risk #6 "BullMQ re-delivers an interrupted job to another worker (stalled-job detection)." -> Accurate — BullMQ's stalled-job mechanism (`stalledInterval`, `maxStalledCount`) moves stalled jobs back to wait/failed. Correct terminology.

### TypeORM

- [SEVERITY low] §1.7 uses a `jsonb` column for the extraction result and mentions `->>` querying. -> Correct: TypeORM supports `@Column({ type: 'jsonb' })` on Postgres, and `->>`/`->` operators work via query builder/raw SQL. No error. (A reviewer would only note: querying into `jsonb` from TypeORM's `find()` is awkward; you'd drop to `createQueryBuilder` — which the doc implicitly concedes.)
- [SEVERITY low] The lifecycle uses a status enum (`uploaded`/`processing`/`completed`/`failed`). The doc never states the column type, but if implemented as a Postgres `enum` via `@Column({ type: 'enum', enum: InvoiceStatus })`, adding a value later requires a migration (`ALTER TYPE`). -> Not an error in the doc (it doesn't claim otherwise), but given §1.7's "no migration when we add a field" rationale for `jsonb`, a reviewer would note the status enum *does* incur migration churn — a mild internal tension. Consider `varchar` + a TS union if churn-avoidance is the stated value.
- [SEVERITY low] §1.7 mentions UUID PKs only implicitly. No `uuid`/`@PrimaryGeneratedColumn('uuid')` claim is made, so nothing to correct — just confirming there's no wrong token here.

### Multer / NestJS upload

- [SEVERITY med] Risk #2 says to "Enforce an upload size cap at the Multer/body layer (e.g. 25MB) and reject early with 413." -> The mechanism is right but the **error code is not automatic**: Multer's `limits.fileSize` throws `MulterError` with code `LIMIT_FILE_SIZE`, which NestJS surfaces as a **500** by default unless you map it (e.g. a custom exception filter translating `LIMIT_FILE_SIZE` → `PayloadTooLargeException`/413). So "reject early with 413" requires explicit wiring; out of the box you get 500. Worth stating.
- [SEVERITY low] Risk #2's "Multer/body layer" phrasing conflates two limits. -> File-size limits come from Multer's `limits` (via `FileInterceptor`/`MulterModule` options); JSON/body-size limits come from Express's `body-parser` (`app.use(json({ limit }))`). For a multipart file upload, the Multer `limits.fileSize` is the relevant one — the "body layer" cap won't catch a large multipart file. Minor imprecision.

### Internal consistency / architecture (non-Claude)

- [SEVERITY low] §1.4 says text PDFs go to `pdf-parse` and "Claude only does the *structuring*," then risk #4 says "if `pdf-parse`/Tesseract yields near-empty text, fail fast." -> Consistent and sound. No error. (`pdf-parse` is text-extraction only — correct that it can't OCR scanned PDFs, hence the Tesseract branch.)
- [SEVERITY low] Risk #8 claims "the Socket.IO scale-out both depend on Redis." -> True only if you've added the `@socket.io/redis-adapter`; a single-process assignment build (which the doc elsewhere assumes) uses the in-memory adapter and Socket.IO does **not** depend on Redis. The doc says "at scale" elsewhere (§1.2) but risk #8 states the dependency as present-tense. Mild internal inconsistency — for this single-node build, Redis-down breaks the queue, not Socket.IO.
- [SEVERITY low] §1.3 "automatic reconnection, and a typed client … One connection serves both status updates and assistant streaming." -> Accurate for Socket.IO; `@nestjs/websockets` + `@WebSocketGateway` + `@SubscribeMessage` is the right API surface (not asserted by name in the doc, but nothing contradicts it).

### Net assessment
The Claude-facing claims (model IDs, pricing, `output_config.format` vs tool use, prefill-400, refusal branch, SDK auto-retry implied in risk #5) are **correct** — the SDK does auto-retry 429/5xx with backoff (default 2 retries), so risk #5 is accurate. The corrections worth making before this ships are the three `med`s: the refusal billing/discard nuance (risk #9), the `job.retry()`-needs-a-job-handle gap (§1.2/§1.8), and the Multer-413-isn't-automatic point (risk #2).
