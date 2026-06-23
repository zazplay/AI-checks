# Multi-agent code review — Invoice Processing System

> Independent code review of the whole project (NestJS backend + React/Vite/Mantine
> frontend) by **five AI reviewers — three on Claude Sonnet 4.6, two on Claude Opus
> 4.8** — followed by a cross-model comparison and a manual verification pass against
> the source. Generated artifact, kept in the repo as a review record.

## How this review was run

- **5 parallel reviewers**, each a distinct persona/model:
  - Sonnet — correctness & reliability
  - Sonnet — security
  - Sonnet — frontend / React / UX / a11y
  - Opus — architecture, maintainability & AI-subsystem design
  - Opus — performance, scalability, data model & testing
- A sixth **Opus comparison agent** merged the 76 raw findings into
  consensus / disagreements / a ranked action list.
- A **verification pass** then checked the highest-impact claims directly against the
  code; corrections are noted inline (see *Verification*).

**Totals:** 76 findings across 5 reviewers ·
9 consensus items · 6 disagreements ·
32 ranked actions.

---

## Verification (manual, against the code)

The ranked findings below were spot-checked against the actual source. Result: the
findings are **substantially accurate**. Confirmed directly:

- ✅ `findEmpty()` calls `findAll()` with **no status filter** → includes
  `uploaded`/`processing` rows ([invoices.service.ts:94](../../backend/src/invoices/invoices.service.ts#L94)).
- ✅ `'dev-insecure-jwt-secret'` fallback exists in **three** places
  (assistant.service.ts, auth.module.ts, events.module.ts).
- ✅ CORS is fully open: `app.enableCors()` (no args) + gateway `cors:{origin:true}`.
- ✅ SSE controller has **no** `req.on('close')` / AbortController.
- ✅ `AskDto.message` is `@IsString()` only — no non-empty guard.
- ✅ `retry()`/`reprocess()` do `findOne → status guard → save → enqueue` with **no
  `@VersionColumn`** and no atomic update — the race is real.
- ✅ **Zero** test files in the project (no `*.spec.ts`).

**One correction — the "critical" #1 is overstated.** The reviewers flagged "rotate
all live API keys — `backend/.env` exists". Verified: `backend/.env` is **gitignored
and NOT committed** (`git ls-files` does not list it), and `.env.example` ships
**empty placeholders**. So no keys are leaked into the repository. The real, *lower*
risk is only that 3 live keys sit in plaintext on the dev machine — rotate if that
machine/backup is shared. Treat #1 as **low**, not critical. A secrets pre-commit
hook is still a reasonable hardening.

---

## Ranked action list (merged & de-duplicated)

| # | Sev | Effort | Action | Location |
|---|---|---|---|---|
| 1 | critical | S | Rotate all live API keys (Gemini/Groq/Anthropic) and the admin password — backend/.env exists on disk with 6 secret-shaped lines (verified). Although gitignored, any git add ./IDE sync/ZIP export leaks them. Add detect-secrets or git-secrets pre-commit hook. | `backend/.env` |
| 2 | high | S | Add a mandatory secret startup guard: refuse to boot when AUTH_PASSWORD is set but JWT_SECRET is unset, and remove the 'dev-insecure-jwt-secret' fallback (verified at assistant.service.ts:793 and auth.module.ts:14). Same secret signs both auth JWTs and destructive-action confirmation tokens, so the fallback is forgeable in a misconfigured prod deploy. | `backend/src/main.ts + backend/src/auth/auth.module.ts:14 + backend/src/assistant/assistant.service.ts:793` |
| 3 | high | M | Fix the non-atomic retry/reprocess race (verified: findOne -> status guard -> save -> enqueue with no lock). Add @VersionColumn to Invoice OR an atomic UPDATE ... WHERE id=? AND status='failed' RETURNING. The same @VersionColumn also fixes the lost-update races during processing (markCompleted vs appendProcessingLog clobbering extractedData) and in updateExtractedFields vs reprocess. | `backend/src/invoices/invoices.service.ts:433,586-637,477-506` |
| 4 | high | S | Fix findEmpty() to exclude 'uploaded' and 'processing' invoices (verified: it filters only on extractedData being null/empty, which is true for all in-flight invoices). The list_empty_invoices assistant tool can otherwise suggest deleting actively-processing invoices. | `backend/src/invoices/invoices.service.ts:94` |
| 5 | high | M | Wire client-disconnect abort on the SSE assistant stream end-to-end (verified: no req.on('close') in controller). Server: AbortController on req close, signal threaded to each LLM SDK call and checked between turns. Client: thread an AbortSignal through askStream, abort it in reset(). Prevents up to MAX_TURNS=8 LLM calls per abandoned session. | `backend/src/assistant/assistant.controller.ts:29 + frontend/src/lib/api.ts:44 + frontend/src/hooks/useAssistant.ts` |
| 6 | high | M | Add rate limiting (@nestjs/throttler) to POST /auth/login (brute-force; e.g. 5/min/IP) and both /assistant/messages endpoints (AI cost DoS; e.g. 10/min/user). Add @ArrayMaxSize(50) to AskDto.history and @MaxLength to message/content. | `backend/src/auth/auth.controller.ts + backend/src/assistant/assistant.controller.ts:13-52` |
| 7 | high | L | Push filtering/sorting/pagination into SQL: replace findAll-then-filter-in-JS in filterInvoices/queryByAmount/queryForExport/findEmpty/getTopProducts/getInvoiceTotalsSeries with jsonb WHERE/ORDER BY/LIMIT in a shared buildFilteredQuery(), reusing the numeric/date regex guards getStats() already has. Core scalability fix (raised by 3 reviewers). | `backend/src/invoices/invoices.service.ts:94-415` |
| 8 | high | M | Add pagination (limit/offset or keyset on createdAt+id) to GET /invoices and the assistant get_dataset, and split the response DTO so processingLog + full extractedData are returned only on the detail endpoint (currently shipped for every list card and every socket broadcast). | `backend/src/invoices/invoices.service.ts:61-66 + backend/src/invoices/dto/invoice-response.dto.ts:34-55` |
| 9 | high | L | Stand up a test suite (zero project test files + no jest config verified). Start with pure-function unit tests: groundReplyText, normalizeToolCall, sign/verifyToken (valid/tampered/expired), detectAnomalies, getStats/filterInvoices null-handling. These also de-risk the SQL migration in rank 7. | `backend/package.json:16` |
| 10 | high | S | Restrict CORS to a CORS_ORIGIN env var on both HTTP (app.enableCors at main.ts:12) and the Socket.IO gateway (origin:true). Cheap regardless of the low-vs-high severity debate. | `backend/src/main.ts:12 + events.gateway.ts:19` |
| 11 | high | M | Fix the useAssistant run() stale-closure (verified: run captures messages at render-time and toHistory(messages) reads that snapshot). Mirror messages in a ref and read messagesRef.current so fast double-sends use fresh history and run/confirmAction stop re-creating every render. | `frontend/src/hooks/useAssistant.ts:34` |
| 12 | high | M | Fix SSE error-frame handling on both axes: api.ts:76 throws inside handleFrame without reader.cancel() (network leak), AND the hook transparently falls back to a full non-streaming re-run on any error frame, double-applying stateful tools (retry_all_failed/reprocess) that already ran. Treat a mid-run error frame as terminal; only fall back when the stream fails to ESTABLISH. | `frontend/src/lib/api.ts:76 + frontend/src/hooks/useAssistant.ts:59-63` |
| 13 | high | S | Fix InvoiceUIContext explain/closeExplain useCallback deps: they list the whole explainMutation object (new ref on every mutation tick), re-firing the context-value useMemo and re-rendering every useInvoiceUI() consumer (AssistantChat, InvoiceCards, AllInvoicesTable) on each AI-explanation tick. Destructure stable mutate/reset and depend on those. | `frontend/src/invoice-ui/InvoiceUIContext.tsx:137` |
| 14 | medium | M | Add helmet middleware (X-Content-Type-Options, X-Frame-Options/CSP, HSTS, etc.) and harden the file-serving endpoint (Content-Disposition: attachment + nosniff). Validate uploaded file content by magic bytes (file-type) instead of trusting client Content-Type, and restrict stored extensions to an allowlist. | `backend/src/main.ts + backend/src/invoices/multer.config.ts:30-38` |
| 15 | medium | S | Make TypeORM synchronize development-only (verified: NODE_ENV !== 'production' enables auto-DDL in staging/test/CI/unset). Change to NODE_ENV==='development' and add real migrations (also needed for the GIN/trigram indexes below). | `backend/src/database/database.module.ts:17` |
| 16 | medium | S | Add @ValidateIf((o)=>!o.confirm)@IsNotEmpty() to AskDto.message (verified: empty string reaches Claude on non-confirm turns and 400s as a misleading 503). Use the conditional form so the legitimate confirm flow that sends message='' still passes. | `backend/src/assistant/dto/ask.dto.ts:30` |
| 17 | medium | M | Make retryFailedThenCleanup restart-safe and outage-safe (verified: detached void watcher polling 3s for 90s, then unlinks files). Drive cleanup off the BullMQ 'failed' event (knows attemptsMade vs attempts), distinguish terminal verdicts (not_an_invoice/empty) from transient failures, and don't hard-delete on a transient AI outage. Both Opus reviewers raised this. | `backend/src/invoices/invoices.service.ts:519-581` |
| 18 | medium | M | Add nonce/jti-based replay prevention to HMAC confirmation tokens (currently stateless, replayable within the 5-min TTL). Replay of update_invoice silently re-applies a patch over a manual correction. Add jti+used-set or shorten TTL to ~60s. Also enforce exactly two dot-separated token parts in verifyToken (token.split('.') silently discards extra components). | `backend/src/assistant/assistant.service.ts:764-795` |
| 19 | medium | S | Stop double-serializing rows into the model context (verified: r.data — both compact 'invoices' and detailed 'dataset' — is JSON.stringify'd into the tool-result at assistant.service.ts:505,638). Send only the detailed payload to the model; keep the compact card list in ToolAction.data for the UI only. | `backend/src/assistant/assistant.tools.ts:644-690` |
| 20 | medium | S | Fix the step-limit (MAX_TURNS) exit path dropping the user message and reply from returned history in all three loops (success exits append both turns; the step-limit branch returns original history). Best fixed once after unifying the loops. | `backend/src/assistant/assistant.service.ts:411-415` |
| 21 | medium | S | Guard against AUTH_PASSWORD-unset silently disabling auth on ALL endpoints: throw at bootstrap if AUTH_PASSWORD is missing and NODE_ENV !== 'development'. Gate or disable Swagger /docs in production (currently bypasses the JWT guard). | `backend/src/auth/jwt-auth.guard.ts:33 + backend/src/main.ts:38-39` |
| 22 | medium | S | Fix InvoiceThumb passing '' to useInvoiceFile for non-completed cards (verified pattern at InvoiceThumb.tsx:37), firing a malformed GET /invoices//file and polluting the query cache. Add enabled: invoice.status==='completed' and always pass invoice.id. | `frontend/src/components/invoices/InvoiceThumb.tsx:37` |
| 23 | medium | S | Add keyboard/role affordances for WCAG 2.1.1: StatsCards Paper has role=button but no onKeyDown (StatsCards.tsx:47); InvoiceCards Card has onClick but no role/tabIndex/keyboard handler (InvoiceCards.tsx:101). Prefer UnstyledButton/native button. | `frontend/src/components/invoices/StatsCards.tsx:47 + frontend/src/components/invoices/InvoiceCards.tsx:101` |
| 24 | medium | S | Memoize hot frontend derivations: MessageBubble suggestions/stats/charts (re-run per keystroke for every message), ChatInvoiceList byId Map + resolved array, and move InvoiceDetail's inline <style>{@keyframes} to index.css. Wrap each in useMemo keyed on message.actions / [all]. | `frontend/src/components/assistant/MessageBubble.tsx:74 + frontend/src/components/assistant/ChatInvoiceList.tsx:43 + frontend/src/components/invoices/InvoiceDetail.tsx:557` |
| 25 | medium | M | Add GIN/trigram (pg_trgm) indexes on extractedData->>'vendorName'/'total'/'currency'/'dueDate' and originalFilename via real migrations, to support the SQL search/filter from rank 7 (currently unindexed ILIKE seq-scans on every typeahead keystroke). | `backend/src/invoices/entities/invoice.entity.ts:42-66` |
| 26 | medium | S | Guard remove() against deleting 'processing'/'uploaded' invoices (or make markCompleted/markFailed treat NotFoundException as a no-op) so deleting an in-flight invoice doesn't produce misleading processor errors and spurious BullMQ retries. | `backend/src/invoices/invoices.service.ts:418` |
| 27 | medium | S | Unbounded chat history (raised by 3 reviewers): cap toHistory at last N turns (e.g. keep first 2 + last 18) before sending. Frontend-only one-liner with a documented MAX_HISTORY_TURNS constant. | `frontend/src/hooks/useAssistant.ts:23` |
| 28 | medium | L | ARCHITECTURE: unify askGemini/askGroq/askClaude (~270 lines of duplicated agentic loop) and completeText behind one AssistantEngine adapter interface; collapse the four hand-synced tool registries (TOOL_DECLARATIONS, dispatch switch, destructive/edit/uiData sets, step labels) into one tool-definition array that derives them all. Removes cross-file drift and lets the rank-20 history-bug + rank-5 abort be fixed in one place. | `backend/src/assistant/assistant.service.ts:329-652 + backend/src/assistant/assistant.tools.ts:100-465` |
| 29 | low | S | Guard date-string filters: filterInvoices/overdue compare extractedData.invoiceDate/dueDate as raw strings (no ISO regex guard, unlike getStats). Non-ISO values ('2024/3/5','March 2024') misclassify lexically. Apply the same ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ guard + ::date cast when moving to SQL. | `backend/src/invoices/invoices.service.ts:203-208` |
| 30 | low | M | Frontend correctness/cleanup batch: AllInvoicesTable accepts onRequestDelete but never uses it (remove or thread down); upsertInvoice always inserts at position 0 (re-sort by createdAt); socket reconnect always invalidates (gate on disconnect-gap > staleTime); UploadDropzone async handleDrop lacks try/catch; DocumentPreview doesn't reset url to null when blob is undefined; useAsideWidth localStorage read needs try/catch; replace ['stats'] string literal with imported statsKeys.all. | `frontend/src/components/invoices/AllInvoicesTable.tsx:72 + frontend/src/hooks/useInvoices.ts:17 + frontend/src/hooks/useInvoiceSocket.ts:25 + frontend/src/hooks/useAssistant.ts:79` |
| 31 | low | M | Backend low-severity cleanup batch: remove dead rawText column (verified: declared at invoice.entity.ts:48, assigned nowhere) or populate it; remove unreachable 'throw lastError' in groqCompletionWithRetry (verified dead — last attempt throws inside catch); add UUID guard to navigate_ui openInvoiceId; align/ document the 0.6 fallback vs 0.4 acceptance confidence thresholds; reset attempts counter on retry/reprocess or document its semantics; include currency in render_chart 'vendors' slice labels; hoist duplicated UUID_RE/isUuid into one shared util; fix the assistant-engine default-selection branch that can pick a provider whose client is null. | `backend/src/invoices/entities/invoice.entity.ts:46-48 + backend/src/assistant/assistant.service.ts:553 + backend/src/assistant/assistant.tools.ts:56-63,779 + backend/src/ai/assistant-engine.service.ts:42-50 + backend/src/processing/extraction.service.ts:114` |
| 32 | low | M | Stream the xlsx/csv export (ExcelJS WorkbookWriter piped to response + cursor-stream query) instead of buffering the whole workbook and full row set in memory; run getStats's 5 independent aggregates with Promise.all and short-TTL cache it (invalidate on the processing-complete socket event). | `backend/src/invoices/export.service.ts:34-49 + backend/src/invoices/invoices.service.ts:248-357` |

_Effort: S ≈ <1h · M ≈ a few hours · L ≈ a day+._

---

## Consensus findings (raised independently by 2+ reviewers)

These carry the strongest signal — different models/personas converged on them.

### findAll()-then-filter-in-JS: nearly every read path (findEmpty, queryByAmount, queryForExport, filterInvoices, getTopProducts, getInvoiceTotalsSeries) loads the entire invoices table into Node memory and filters/sorts in TypeScript. No pagination, no jsonb WHERE/LIMIT.

- **Severity:** high (medium per Sonnet security)
- **Raised by:** Sonnet correctness, Sonnet security, Opus performance/scalability
- **Location:** `backend/src/invoices/invoices.service.ts:94-415`
- **Why it matters:** Three independent reviewers across both model families converged on this as the core scalability defect. Invisible at hundreds of rows, O(table) network + hydration + memory per assistant tool call at 10k+. Opus extended it with the missing GIN/trigram index and pagination angles the Sonnet reviewers only gestured at.

### Confirmation-token / JWT HMAC falls back to a hardcoded weak secret ('dev-insecure-jwt-secret') when JWT_SECRET is unset; same secret used for auth JWTs and destructive-action confirmation tokens. Forgeable in a misconfigured prod deploy.

- **Severity:** high
- **Raised by:** Sonnet correctness, Sonnet security
- **Location:** `backend/src/assistant/assistant.service.ts:793 and backend/src/auth/auth.module.ts:14`
- **Why it matters:** Verified at both line 793 and line 14. Two reviewers independently flagged the fallback. An attacker who reads source can forge confirmation tokens (arbitrary invoice delete/field overwrite) or full JWTs if the env var is absent. Fix is a one-line startup guard.

### Open CORS — app.enableCors() with no args (and Socket.IO gateway cors:{origin:true}) accepts all origins.

- **Severity:** high (low per Sonnet correctness, high per Sonnet security)
- **Raised by:** Sonnet correctness, Sonnet security
- **Location:** `backend/src/main.ts:12`
- **Why it matters:** Verified at main.ts:12. Both reviewers flagged it; severity split (low vs high) hinges on whether the JWT-in-localStorage storage model neutralizes classic CSRF. Cheap to restrict to a CORS_ORIGIN env var, so worth doing regardless of severity debate.

### No client-disconnect / cancellation abort on the SSE assistant stream — the agentic loop (up to MAX_TURNS=8 LLM calls) runs to completion after the browser closes or the user clears the chat, burning AI quota.

- **Severity:** high (medium on the frontend side)
- **Raised by:** Sonnet correctness (server-side), Sonnet frontend (client-side)
- **Location:** `backend/src/assistant/assistant.controller.ts:29 and frontend/src/lib/api.ts:44`
- **Why it matters:** Verified: controller has no req.on('close') handler. Two reviewers attacked the same waste from opposite ends — server has no AbortController to wire to req close, client's askStream has no AbortSignal to cancel on reset(). The complete fix needs both ends threaded with one signal.

### AskDto.message has no @IsNotEmpty() / @MinLength(1) — an empty string reaches Claude on a non-confirm turn and 400s (surfaced as a misleading 503).

- **Severity:** medium (low per Sonnet security)
- **Raised by:** Sonnet correctness, Sonnet security
- **Location:** `backend/src/assistant/dto/ask.dto.ts:30`
- **Why it matters:** Both reviewers caught it AND both noted the trap: the confirm flow legitimately sends message=''. The security reviewer gives the correct fix (@ValidateIf((o)=>!o.confirm) @IsNotEmpty()) where a naive @IsNotEmpty() would break confirmations — a good example of the second reviewer refining the first's fix.

### Unbounded chat history sent to the LLM on every turn — toHistory accumulates all non-pending messages with no sliding window, truncation, or token cap.

- **Severity:** medium
- **Raised by:** Sonnet correctness, Sonnet frontend
- **Location:** `frontend/src/hooks/useAssistant.ts:23`
- **Why it matters:** Verified toHistory maps all non-pending messages. Two reviewers independently proposed the same minimal fix (cap at last N turns). Long sessions grow context cost linearly and eventually hit window limits.

### retryFailedThenCleanup is a detached in-process wall-clock watcher (void watchAndDeleteStillFailing, poll every 3s for 90s) that hard-deletes still-failing invoices: not restart-safe, no concurrency guard, deadline decoupled from BullMQ backoff, and can mass-delete on a transient AI outage.

- **Severity:** medium
- **Raised by:** Opus principal (architecture), Opus staff (reliability/data)
- **Location:** `backend/src/invoices/invoices.service.ts:519-581`
- **Why it matters:** Both Opus reviewers independently flagged the same async-boundary fragility and converged on the same fix: drive cleanup off the BullMQ 'failed' event (which knows attemptsMade vs attempts) instead of a timer. The staff reviewer added the irreversible-data-loss-on-transient-outage angle (remove() unlinks the file).

### Lost-update race during processing: markProcessing/markCompleted/markFailed/appendProcessingLog all do findOne -> mutate -> save(full entity) with no @VersionColumn; concurrent appendProcessingLog and markCompleted can clobber extractedData or drop a log entry. Same read-modify-write race in updateExtractedFields vs reprocess.

- **Severity:** medium (high for the retry/reprocess enqueue variant)
- **Raised by:** Opus staff, Sonnet correctness (retry/reprocess variant)
- **Location:** `backend/src/invoices/invoices.service.ts:586-637`
- **Why it matters:** Two manifestations of one root cause (no optimistic locking on concurrent saves). Sonnet caught the retry/reprocess duplicate-job enqueue race (verified: read-check-save-enqueue with no lock); Opus caught the column-clobber/lost-append race during processing and edits. A single @VersionColumn + partial repo.update / atomic jsonb concat addresses both.

### Tool surface and provider loops carry heavy duplication: get_dataset/filter_invoices both serialize each row twice (compact 'invoices' + detailed 'dataset') into the model context, and the three agentic loops + completeText + the four parallel tool registries repeat the same control flow.

- **Severity:** medium
- **Raised by:** Opus principal, Opus staff
- **Location:** `backend/src/assistant/assistant.tools.ts:644-690`
- **Why it matters:** Verified: at assistant.service.ts:505/638 the whole r.data object (both invoices+dataset) is JSON.stringify'd into the model's tool-result, so multi-currency-large rows are double-counted in tokens. Both Opus reviewers independently flagged duplication as the dominant maintainability theme, from architecture (loops/registries) and from token-cost (double payload) angles.


---

## Disagreements / contested calls

- **CORS severity** — Sonnet correctness rated it 'low' (JWT guard protects endpoints, JWT in localStorage not a cookie so limited CSRF); Sonnet security rated it 'high' (origin is a lost security boundary, Swagger-CSRF surface). The threat model hinges on whether any credentialed request can be made cross-origin — with localStorage-stored bearer tokens, classic CSRF is largely mitigated, so 'low-to-medium' is the more defensible call. Both agree it should be restricted. (`backend/src/main.ts:12`)
- **How to fix AskDto.message empty-string** — Sonnet correctness proposes a plain @IsNotEmpty()/@MinLength(1) or a runtime guard. Sonnet security correctly points out a bare @IsNotEmpty() would BREAK the legitimate confirm flow that sends message='' with a token, and prescribes @ValidateIf((o)=>!o.confirm)@IsNotEmpty(). The security reviewer's version is the correct one; the correctness reviewer's first option is a latent regression. (`backend/src/assistant/dto/ask.dto.ts:30`)
- **SSE error-frame handling: leak vs unsafe fallback re-run** — Sonnet frontend says the bug is that handleFrame throws synchronously without reader.cancel(), leaking the network stream (api.ts:76). Opus principal says the deeper bug is that the hook transparently falls back to a full non-streaming re-run on ANY error frame, which double-applies stateful tools (retry_all_failed/reprocess) that already ran before the late failure (assistant.controller.ts:29-52). These are complementary, not contradictory, but Opus identifies a correctness hazard (double side-effects) the Sonnet reviewer missed while focusing on the resource leak. (`frontend/src/lib/api.ts:76`)
- **attempts counter semantics on reprocess** — Only Sonnet correctness flagged that reprocess() resets processingLog but not the attempts counter, so a 2nd user-initiated reprocess shows '6 attempts'. This is a single-reviewer, low-severity, semantics-definition issue (is 'attempts' lifetime AI calls or per-run?) — arguably intended behavior, not a bug. Contentious because it depends on an undocumented product decision. (`backend/src/invoices/invoices.service.ts:455`)
- **Confidence threshold gap (fallback at 0.6, acceptance gate at 0.4)** — Only Sonnet correctness flagged the two-tier threshold as a possible defect (results in 0.4-0.59 trigger all fallbacks yet are still accepted). This may be a deliberate 'try harder but keep anything usable' design; the reviewer itself hedges ('document this two-tier design'). Single-reviewer, low confidence, plausibly intentional. (`backend/src/processing/extraction.service.ts:114`)
- **navigate_ui openInvoiceId UUID validation** — Only Sonnet security flagged the missing UUID guard on the LLM-supplied openInvoiceId. The reviewer concedes the frontend already mitigates it (invoices.find against local cache) and it only becomes exploitable IF the frontend later deep-links via API. So it is a defense-in-depth / future-proofing item, not a live vulnerability — its 'low' severity is appropriate but it is the kind of speculative finding that needs the caveat attached. (`backend/src/assistant/assistant.tools.ts:779`)

---

## Per-reviewer findings

### claude-sonnet-4-6 — correctness & reliability focus

_The codebase is well-structured and thoughtfully commented. The extraction cascade, BullMQ retry integration, terminal-error signalling, and Socket.IO cache-merge pattern are all solid. The main correctness issues are: (1) a race condition in retry/reprocess where two concurrent HTTP calls can enqueue duplicate BullMQ jobs for the same invoice; (2) findEmpty() returns uploading/processing invoices that have no extractedData yet, making the assistant's list_empty_invoices tool potentially suggest deleting in-flight invoices; (3) the SSE streaming endpoint does not abort the LLM call when the client disconnects, leaking AI quota; (4) the assistant confirmation token falls back to a hardcoded weak secret when JWT_SECRET is not set, making it forgeable in default deployments. Several lower-severity issues are also noted: unbounded history token growth, an empty-message path that reaches Claude (causing a 400), upsertInvoice always placing items at list position 0, and full-table loads for every filtered query._

| Severity | Category | Finding | Location | Conf |
|---|---|---|---|---|
| high | bug | Race condition: duplicate BullMQ jobs from concurrent retry/reprocess calls | `backend/src/invoices/invoices.service.ts:433` | high |
| high | bug | findEmpty() includes 'uploaded' and 'processing' invoices — assistant can delete in-flight invoices | `backend/src/invoices/invoices.service.ts:94` | high |
| high | reliability | SSE endpoint has no client-disconnect abort — AI quota is wasted after browser closes | `backend/src/assistant/assistant.controller.ts:29` | high |
| high | security | Confirmation token HMAC falls back to hardcoded weak secret | `backend/src/assistant/assistant.service.ts:793` | high |
| medium | reliability | Delete-while-processing causes noisy log errors from the processor | `backend/src/invoices/invoices.service.ts:418` | high |
| medium | reliability | Unbounded chat history sent to LLM each turn — token growth in long sessions | `frontend/src/hooks/useAssistant.ts:23` | medium |
| medium | bug | AskDto.message has no @IsNotEmpty() — empty string reaches the LLM on normal turns | `backend/src/assistant/dto/ask.dto.ts:30` | high |
| medium | bug | upsertInvoice always inserts at position 0 — disrupts stable ordering on any socket update | `frontend/src/hooks/useInvoices.ts:17` | high |
| medium | performance | All filtering operations load the full invoice table into memory | `backend/src/invoices/invoices.service.ts:94` | high |
| medium | security | JWT_SECRET defaults to hardcoded value — same risk as the HMAC finding | `backend/src/auth/auth.module.ts:14` | high |
| low | reliability | appendProcessingLog dedup key (at\|engine) is not unique within fast bursts | `backend/src/invoices/invoices.service.ts:631` | low |
| low | security | CORS fully open (wildcard) on both HTTP and WebSocket | `backend/src/main.ts:12` | medium |
| low | maintainability | attempts DB counter is never reset on reprocess() — misleading attempt display | `backend/src/invoices/invoices.service.ts:455` | medium |
| low | reliability | Confidence threshold gap: fallback fires at 0.6 but acceptance gate is 0.4 | `backend/src/processing/extraction.service.ts:114` | medium |
| low | bug | Groq retry silently swallows lastError on the last attempt path | `backend/src/assistant/assistant.service.ts:553` | medium |

**Top priorities:** Fix the non-atomic retry/reprocess race: add optimistic locking (@VersionColumn) or an atomic UPDATE ... WHERE status='failed' check to prevent duplicate BullMQ jobs (invoices.service.ts:433); Fix findEmpty() to exclude 'uploaded' and 'processing' invoices so the assistant cannot suggest deleting in-flight invoices (invoices.service.ts:94); Add SSE client-disconnect abort: wire res.on('close') to an AbortController and pass the signal to each LLM SDK call so abandoned sessions don't burn API quota (assistant.controller.ts:29); Add a mandatory JWT_SECRET startup guard: refuse to boot without it when auth is enabled, to prevent the default hardcoded secret from reaching production (main.ts + auth.module.ts); Add @IsNotEmpty() to AskDto.message to prevent empty strings from reaching Claude (which returns a 400) on non-confirmation chat calls (assistant/dto/ask.dto.ts:30)


### claude-sonnet-4-6 — security-focused senior engineer

_The codebase is well-structured with thoughtful security in several areas: timing-safe credential comparison (timing-safe.ts), UUID grounding guards on tool args, HMAC-signed confirmation tokens for destructive actions, whitelist-only field patching in updateExtractedFields, and a clean JWT flow with a proper public decorator. However, several real security gaps exist. The most pressing are: live API keys committed in backend/.env (Gemini, Groq, Anthropic, plus admin/admin creds), a completely open CORS policy, no rate limiting on the login or assistant endpoints, and stateless confirmation tokens that can be replayed within their 5-minute window. The "auth disabled when AUTH_PASSWORD is unset" design choice is intentional for dev convenience but is not guarded carefully enough — it silently opens every endpoint including deletions. The Socket.IO gateway replicates the pattern correctly but also inherits the same all-origins CORS._

| Severity | Category | Finding | Location | Conf |
|---|---|---|---|---|
| critical | security | Live API keys present in committed/working-tree .env file | `backend/.env:28-38` | high |
| high | security | Completely open CORS — all origins accepted | `backend/src/main.ts:12` | high |
| high | security | No rate limiting on login endpoint — brute-force password attacks possible | `backend/src/auth/auth.controller.ts` | high |
| high | security | No rate limiting on assistant endpoints — AI token amplification / cost DoS | `backend/src/assistant/assistant.controller.ts:13-52` | high |
| medium | security | HMAC confirmation tokens are stateless and replayable within 5-minute TTL | `backend/src/assistant/assistant.service.ts:764-795` | high |
| medium | security | AUTH_PASSWORD unset silently disables auth on ALL endpoints, not just documented ones | `backend/src/auth/jwt-auth.guard.ts:33` | high |
| medium | security | File upload MIME type validated against client-supplied Content-Type, not file content | `backend/src/invoices/multer.config.ts:30-38` | high |
| medium | reliability | TypeORM synchronize:true active outside production — risk of unintended schema mutations | `backend/src/database/database.module.ts:17` | high |
| low | security | Swagger /docs endpoint is publicly accessible regardless of AUTH_PASSWORD setting | `backend/src/main.ts:38-39` | high |
| low | security | Missing HTTP security headers — no helmet or equivalent | `backend/src/main.ts` | high |
| low | security | navigate_ui tool forwards LLM-generated openInvoiceId to the frontend without UUID validation | `backend/src/assistant/assistant.tools.ts:779` | high |
| low | security | Confirmation token split('.') silently discards extra components — token extension possible | `backend/src/assistant/assistant.service.ts:772` | high |
| low | bug | AskDto.message allows empty string — Claude 400s when sent as LLM message | `backend/src/assistant/dto/ask.dto.ts:30` | high |
| low | performance | get_dataset and filter_invoices tools load all invoices into memory before filtering | `backend/src/invoices/invoices.service.ts:186-243` | high |

**Top priorities:** Rotate all exposed API keys (Gemini, Groq, Anthropic) and the admin password from backend/.env immediately, then add detect-secrets to the pre-commit hook; Add rate limiting to POST /auth/login (brute-force protection) and both POST /assistant/messages endpoints (AI cost DoS prevention) using @nestjs/throttler; Restrict CORS in main.ts from app.enableCors() to app.enableCors({ origin: process.env.CORS_ORIGIN }) and similarly in events.gateway.ts; Add nonce-based replay prevention to HMAC confirmation tokens (store used jtis until exp) to prevent update_invoice token replay overwriting manual edits; Add helmet middleware for security headers and move TypeORM synchronize:true to development-only


### claude-sonnet-4-6 — frontend/React/UX reviewer

_The codebase is well-structured, intentional, and has clearly been iterated on (the optimistic-update hooks, RAF-based drag resize, and socket-cache merge are all good patterns). The most critical issues are around the useAssistant hook: run() captures a stale messages closure because messages is in its dep array (causing incorrect history on fast double-sends), and the SSE reader throws synchronously inside handleFrame without reader.cancel() (network stream leak). A cluster of medium-severity React performance issues stems from computed values that should be memoized (MessageBubble's derived data, ChatInvoiceList's byId Map) and from explainMutation being placed in useCallback deps in the context provider, causing wide context re-renders on every mutation state tick. Three accessibility bugs (StatsCards filter cards and InvoiceCards thumbnails lack keyboard handlers despite role=button or click handlers) need fixing for keyboard and screen-reader users. The remaining findings are lower severity: a misleading hardcoded fake progress UI in ProcessingSteps, a missing AbortController for stream cancellation, an unbounded chat history that will eventually hit context limits, and a query key raw-string inconsistency._

| Severity | Category | Finding | Location | Conf |
|---|---|---|---|---|
| high | performance | useAssistant: run() re-created on every message, causing stale-closure cascade | `frontend/src/hooks/useAssistant.ts:34` | high |
| high | bug | SSE error frame throws synchronously inside handleFrame, aborting the stream reader loop without cleanup | `frontend/src/lib/api.ts:76` | high |
| high | performance | InvoiceUIContext: explainMutation reference in useCallback deps causes perpetual re-creation | `frontend/src/invoice-ui/InvoiceUIContext.tsx:137` | high |
| medium | performance | ChatInvoiceList: byId Map rebuilt on every render without memoization | `frontend/src/components/assistant/ChatInvoiceList.tsx:43` | high |
| medium | bug | InvoiceThumb passes empty string as invoiceId to useInvoiceFile, causing a spurious query | `frontend/src/components/invoices/InvoiceThumb.tsx:37` | high |
| medium | performance | MessageBubble: suggestions and stats computed inline on every render without memoization | `frontend/src/components/assistant/MessageBubble.tsx:74` | high |
| medium | reliability | Socket reconnect always triggers a full list invalidation, even when the gap was sub-second | `frontend/src/hooks/useInvoiceSocket.ts:25` | medium |
| medium | bug | useAssistant: toHistory filters pending messages but includes the just-sent user message in history for the next turn | `frontend/src/hooks/useAssistant.ts:22` | medium |
| medium | bug | AllInvoicesTable: onRequestDelete prop accepted but never used in the component body | `frontend/src/components/invoices/AllInvoicesTable.tsx:72` | high |
| medium | reliability | UploadDropzone: async handleDrop not wrapped in try/catch — unhandled rejection if start() throws | `frontend/src/components/invoices/UploadDropzone.tsx:26` | medium |
| medium | bug | Accessibility: StatsCards Paper uses role=button without keyboard handler | `frontend/src/components/invoices/StatsCards.tsx:47` | high |
| medium | bug | Accessibility: InvoiceCards Card click area has no keyboard/role affordance | `frontend/src/components/invoices/InvoiceCards.tsx:101` | high |
| medium | feature-gap | Feature gap: no AbortController / request cancellation in askStream when the user clears the chat mid-stream | `frontend/src/lib/api.ts:44` | high |
| medium | feature-gap | Feature gap: chat history sent to the backend grows unbounded — no truncation strategy | `frontend/src/hooks/useAssistant.ts:23` | high |
| low | bug | InvoiceUIContext value useMemo missing setTab and setSearch in deps array | `frontend/src/invoice-ui/InvoiceUIContext.tsx:220` | high |
| low | maintainability | ProcessingSteps in InvoiceDetail shows hardcoded active=0 forever — a dead spinner on long jobs | `frontend/src/components/invoices/InvoiceDetail.tsx:436` | high |
| low | bug | DocumentPreview: object URL can be created from a stale blob after component re-render | `frontend/src/components/invoices/DocumentPreview.tsx:13` | medium |
| low | maintainability | Accessibility: aw-chip example prompts in AssistantWelcome are UnstyledButton with no aria-label | `frontend/src/components/assistant/AssistantWelcome.tsx:133` | medium |
| low | bug | stats query key inconsistency between useStats and useAssistant invalidation | `frontend/src/hooks/useAssistant.ts:79` | high |
| low | performance | useAsideWidth: localStorage.getItem called synchronously during module init via readStored | `frontend/src/hooks/useAsideWidth.ts:14` | medium |
| low | performance | InvoiceDetail injects a bare <style> tag inside JSX on every render | `frontend/src/components/invoices/InvoiceDetail.tsx:557` | high |

**Top priorities:** Fix useAssistant run() stale-closure bug by moving messages into a ref (useAssistant.ts:34) — this is the only correctness bug that can cause wrong API calls; Fix SSE error frame throwing inside handleFrame without reader.cancel() (api.ts:76) — leaks network connections; Fix InvoiceUIContext: replace explainMutation in useCallback deps with stable mutate/reset refs (InvoiceUIContext.tsx:137) — causes unnecessary re-renders across the entire app on every AI explanation; Fix keyboard accessibility on StatsCards filter buttons (StatsCards.tsx:47) and InvoiceCards click targets (InvoiceCards.tsx:101) — WCAG 2.1 violation; Fix InvoiceThumb passing empty string to useInvoiceFile causing spurious malformed HTTP requests for every non-completed card (InvoiceThumb.tsx:37)


### Claude Opus 4.8 — Principal Engineer (architecture, maintainability, AI subsystem)

_This is a genuinely well-engineered assignment: the extraction cascade, the signed-token confirmation flow, the deterministic anomaly/grounding guards, and the per-currency stats are all thoughtful and above the bar for a take-home. The dominant architectural weakness is the 3-engine assistant abstraction: askGemini/askGroq/askClaude are three ~90-line agentic loops that are structurally identical and differ only in SDK message shape, and that same provider switch is duplicated again in completeText() — there is no shared "LLM-with-tools" interface, so every new behavior (a new tool, a retry policy, history handling) must be edited in three places. The tool layer is a single giant dispatchTool switch plus four hand-synced parallel registries (declarations, step labels, UI-data set, destructive set), which is fragile to extend. Dependency direction also leaks: AssistantService reaches past the ai module's selector abstraction to inject all three raw SDK services directly. None of these are correctness-critical, but they are exactly where complexity should be reduced and generalized. I also found a few real bugs (history dropped on step-limit, duplicated dataset payloads inflating tokens, an in-process detached cleanup watcher that's lost on restart)._

| Severity | Category | Finding | Location | Conf |
|---|---|---|---|---|
| high | maintainability | Three near-identical agentic loops (askGemini/askGroq/askClaude) with no shared provider abstraction | `backend/src/assistant/assistant.service.ts:329-652` | high |
| medium | simplification | completeText() duplicates the same provider switch a second time | `backend/src/assistant/assistant.service.ts:713-760` | high |
| medium | maintainability | Tool surface is maintained as four hand-synced parallel registries | `backend/src/assistant/assistant.tools.ts:100-465` | high |
| medium | maintainability | AssistantService bypasses the ai-module selector abstraction and injects all three raw SDK services | `backend/src/assistant/assistant.service.ts:223-230` | medium |
| medium | bug | Hitting MAX_TURNS drops the user message and reply from returned history | `backend/src/assistant/assistant.service.ts:411-415` | high |
| medium | performance | get_dataset and filter_invoices return the same invoices twice (compact + detailed), inflating tokens | `backend/src/assistant/assistant.tools.ts:644-690` | high |
| medium | reliability | retryFailedThenCleanup uses a detached in-process polling watcher with no persistence or concurrency guard | `backend/src/invoices/invoices.service.ts:519-581` | medium |
| low | maintainability | Extraction RULES/schema are described as 'Gemini responseSchema' but Claude and GPT get only a prose JSON spec — schema drift risk | `backend/src/processing/extraction.service.ts:97-108, 375-415` | medium |
| low | bug | render_chart 'vendors' metric collides two-currency vendors into one slice | `backend/src/assistant/assistant.tools.ts:56-63` | high |
| low | maintainability | MAX_TURNS / MIN_CONFIDENCE / CONFIRM_TTL and worker tuning are scattered magic constants | `backend/src/assistant/assistant.service.ts:216-217` | medium |
| low | bug | Default assistant-engine selection logic has an unreachable/confusing branch | `backend/src/ai/assistant-engine.service.ts:42-50` | medium |
| low | reliability | SSE stream endpoint can emit a 200 response then an error frame with no retry path on the server side | `backend/src/assistant/assistant.controller.ts:29-52` | medium |

**Top priorities:** Unify the three agentic loops (askGemini/askGroq/askClaude) and completeText behind a single AssistantEngine adapter interface — this is the central architectural debt and removes ~270 lines of duplicated, drift-prone control flow plus a second copy in completeText.; Collapse the four hand-synced tool registries (declarations, dispatch switch, destructive/edit/uiData sets, step labels) into one tool-definition array that derives all of them, eliminating cross-file sync bugs and the giant switch.; Fix the step-limit history bug (user+model turns dropped) in all three loops — ideally once, after unifying them.; Stop double-serializing rows in get_dataset/filter_invoices ('invoices' compact + 'dataset' detailed) into the model's context; it roughly doubles tool-result tokens on the largest calls.; Make the retry-then-cleanup flow restart-safe by driving deletion off the BullMQ 'failed' event instead of a detached in-process 90s polling watcher.


### Claude Opus 4.8 — staff engineer (performance, scalability, data model, testing)

_The app is well-organized and the AI tool-use layer is thoughtfully defended, but the data-access layer is built on a `findAll()`-then-filter-in-JavaScript pattern that does not scale: nearly every read path (search "empty", amount queries, export, the assistant's filter_invoices, totals series, top products) pulls the entire `invoices` table into memory and filters/sorts in TS. There is no pagination anywhere, no GIN index on the heavily-queried `extractedData` jsonb, and no optimistic locking despite concurrent read-modify-write `save(entity)` calls on the same row during processing (a real lost-update window between markProcessing/appendProcessingLog and markCompleted). The data model carries a dead `rawText` column (declared, never written) and stores the per-attempt processing log in the same jsonb that the list endpoint serializes for every card. Most importantly, there is zero automated test coverage — no spec files, no jest config — so none of the subtle correctness logic (UUID grounding, confirmation-token HMAC, jsonb stats regex guards, the retry/cleanup watcher, the lost-update race) is protected against regressions. The single highest-leverage move is to push filtering/sorting/pagination into SQL and add a focused test suite around the service and assistant dispatcher._

| Severity | Category | Finding | Location | Conf |
|---|---|---|---|---|
| high | performance | findAll-then-filter-in-JS: nearly every query is a full-table scan loaded into Node memory | `backend/src/invoices/invoices.service.ts:94-415` | high |
| high | performance | No pagination on list or assistant dataset endpoints | `backend/src/invoices/invoices.service.ts:61-66` | high |
| high | performance | No GIN index on extractedData jsonb; only status and createdAt are indexed | `backend/src/invoices/entities/invoice.entity.ts:42-66` | high |
| high | test | Zero automated test coverage — no spec files and no jest config | `backend/package.json:16` | high |
| medium | reliability | Lost-update race: concurrent full-entity save() calls overwrite each other during processing | `backend/src/invoices/invoices.service.ts:586-637` | medium |
| medium | performance | processingLog jsonb is serialized into every list-card response | `backend/src/invoices/dto/invoice-response.dto.ts:34-55` | high |
| medium | performance | search() and the (future SQL) filters do unindexed ILIKE on jsonb with no result cap beyond 50 | `backend/src/invoices/invoices.service.ts:77-87` | medium |
| medium | reliability | retryFailedThenCleanup watcher polls the DB with no persistence across restarts and can mass-delete on transient AI outages | `backend/src/invoices/invoices.service.ts:519-581` | medium |
| low | maintainability | rawText column is declared but never written — dead schema | `backend/src/invoices/entities/invoice.entity.ts:46-48` | high |
| low | performance | xlsx export buffers the entire workbook in memory | `backend/src/invoices/export.service.ts:34-49` | medium |
| low | performance | Stats and chart endpoints fire many independent sequential aggregate queries each request | `backend/src/invoices/invoices.service.ts:248-357` | high |
| low | reliability | updateExtractedFields read-modify-write on jsonb has no concurrency guard and can clobber a concurrent reprocess | `backend/src/invoices/invoices.service.ts:477-506` | medium |
| low | bug | filterInvoices issuedBefore/dueBefore compare ISO date strings lexically, which is correct only for well-formed dates | `backend/src/invoices/invoices.service.ts:203-208` | medium |
| low | maintainability | safeParseArgs/UUID regex duplicated across files; id-grounding logic split | `backend/src/assistant/assistant.service.ts:985-993` | high |

**Top priorities:** Push filtering/sorting/pagination into SQL: replace the findAll-then-filter-in-JS pattern in filterInvoices/queryByAmount/queryForExport/findEmpty/getTopProducts with jsonb WHERE/ORDER BY/LIMIT, using the same numeric/date regex guards getStats already uses.; Add pagination (limit/offset or keyset) to GET /invoices and the assistant get_dataset, and split the response DTO so processingLog and full extractedData are only returned on the detail endpoint.; Stand up a test suite: jest config plus high-ROI unit tests for groundReplyText, normalizeToolCall, sign/verifyToken, detectAnomalies, and getStats/filterInvoices null-handling — this also de-risks the SQL migration.; Add a GIN/trigram index strategy on extractedData (vendor, total, currency, dueDate) and originalFilename, via real migrations, and disable synchronize in production.; Fix the lost-update races during processing/edit: add @VersionColumn (optimistic locking) or switch mark*/append*/updateExtractedFields to partial repo.update / atomic jsonb SQL so concurrent saves don't clobber extractedData or drop processingLog entries.

