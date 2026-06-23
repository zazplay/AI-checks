# API test plan — Invoice Processing System

> What to test across the REST + SSE surface, and why. Companion to the test
> results in [03-api-test-results.md](03-api-test-results.md). Covers every mapped
> route plus the auth boundary, input validation, and the anti-hallucination
> guards. Run against a live backend (`http://localhost:3000`) with seed data.

## Scope

20 mapped routes across `auth`, `invoices`, `assistant`, `ai`, `health`. Tests are
black-box HTTP (curl), asserting status codes, response shape, and — for actions —
the resulting state. AI-dependent cases assert *behaviour* (a tool ran, status
changed) rather than exact prose.

## Conventions

- **Auth:** all routes require `Authorization: Bearer <jwt>` except `POST /auth/login`
  and `GET /health`.
- **Pass** = status code + shape (+ side effect) as expected. **Fail** = otherwise.
- Destructive cases are run against disposable/created rows, then cleaned up.

---

## A. Auth & health

| # | Case | Request | Expected |
|---|------|---------|----------|
| A1 | Login OK | `POST /auth/login {admin/admin}` | 200/201, `accessToken` present |
| A2 | Login wrong password | `POST /auth/login {admin/wrong}` | 401 |
| A3 | Login missing fields | `POST /auth/login {}` | 400 (validation) |
| A4 | Health (public) | `GET /health` no token | 200 |
| A5 | Protected route without token | `GET /invoices` no auth header | 401 |
| A6 | Protected route bad token | `GET /invoices` garbage token | 401 |

## B. Invoices — read

| # | Case | Request | Expected |
|---|------|---------|----------|
| B1 | List all | `GET /invoices` | 200, array |
| B2 | List by status | `GET /invoices?status=completed` | 200, all rows `completed` |
| B3 | List bad status | `GET /invoices?status=banana` | 400 |
| B4 | Get one (valid id) | `GET /invoices/:id` | 200, has `extractedData` |
| B5 | Get one bad uuid | `GET /invoices/not-a-uuid` | 400 (ParseUUIDPipe) |
| B6 | Get one missing | `GET /invoices/<random-uuid>` | 404 |
| B7 | Stats | `GET /invoices/stats` | 200, `byStatus`/`byCurrency`/`topVendors`/`overdue` |
| B8 | File download | `GET /invoices/:id/file` | 200, correct content-type |

## C. Invoices — write / lifecycle

| # | Case | Request | Expected |
|---|------|---------|----------|
| C1 | Upload PDF | `POST /invoices` multipart (sample pdf) | 201, status `uploaded` |
| C2 | Upload disallowed type | `POST /invoices` (.txt/.docx) | 400 (mime filter) |
| C3 | Upload no file | `POST /invoices` empty | 400 |
| C4 | Retry non-failed | `POST /invoices/:id/retry` on a completed one | 400 (only failed) |
| C5 | Reprocess completed | `POST /invoices/:id/reprocess` on completed | 200, status → uploaded/processing |
| C6 | Reprocess in-flight | `POST /invoices/:id/reprocess` while processing | 400 |
| C7 | Edit fields (PATCH) | `PATCH /invoices/:id {vendorName}` | 200, field updated |
| C8 | Edit bad field type | `PATCH /invoices/:id {total:"x"}` | 400 (validation) |
| C9 | Edit unknown invoice | `PATCH /<random-uuid>` | 404 |
| C10 | Delete + verify gone | `DELETE /invoices/:id` then `GET` | 204, then 404 |

## D. Export

| # | Case | Request | Expected |
|---|------|---------|----------|
| D1 | Export xlsx | `GET /invoices/export/xlsx` | 200, xlsx content-type, non-empty |
| D2 | Export csv | `GET /invoices/export/csv` | 200, csv + UTF-8 BOM |
| D3 | Export zip | `GET /invoices/export/zip` | 200, application/zip |
| D4 | Export bad format | `GET /invoices/export/pdf` | 400 |
| D5 | Export with filter | `GET /invoices/export/xlsx?status=completed` | 200, scoped |

## E. AI engine switching

| # | Case | Request | Expected |
|---|------|---------|----------|
| E1 | List extraction models | `GET /ai/models` | 200, `current` + `available[]` |
| E2 | Switch extraction model | `PUT /ai/model {valid}` | 200, current updated |
| E3 | Switch to unknown model | `PUT /ai/model {bogus}` | 400 |
| E4 | List assistant engines | `GET /ai/assistant-engine` | 200, `current` + `options[]` with `available` |
| E5 | Switch assistant engine | `PUT /ai/assistant-engine {valid}` | 200 |

## F. Assistant — answer & act

| # | Case | Request | Expected |
|---|------|---------|----------|
| F1 | Answer (stats) | `POST /assistant/messages {"how many failed?"}` | 200, numeric answer, `get_invoice_stats` in actions |
| F2 | Empty message | `POST /assistant/messages {""}` | graceful (no 500) |
| F3 | Filter tool | `{"show overdue EUR invoices"}` | `filter_invoices` ran |
| F4 | Suggest actions | `{"...what can I do next?"}` | `suggest_actions` with buttons in data |
| F5 | Delete by description | `{"delete the largest overdue invoice"}` | `filter_invoices` → `pendingConfirmation` (NOT executed) |
| F6 | Confirm delete | re-post with `confirm.token` | invoice removed |
| F7 | Analyze | `POST /assistant/analyze` | 200, `summary` + `anomalies` |
| F8 | Explain one | `POST /assistant/invoices/:id/explain` | 200, `summary` |
| F9 | SSE stream | `POST /assistant/messages/stream` | `step` frames then `result` frame |

## G. Anti-hallucination guards (the bugs we hardened)

| # | Case | Request | Expected |
|---|------|---------|----------|
| G1 | Fabricated id (delete) | `{"delete invoice 5"}` | refuses / looks it up — no fake-id delete, no crash |
| G2 | Fabricated id (get) | `{"get invoice 5"}` | UUID guard: explains ids are UUIDs, no DB error |
| G3 | Edit shows before→after | `{"change vendor of <id> to X"}` | `pendingConfirmation` with before→after, not applied yet |
| G4 | Forged confirm token | `confirm.token = "garbage.sig"` | 400 (invalid token) |

## H. Validation / robustness

| # | Case | Request | Expected |
|---|------|---------|----------|
| H1 | Unknown body field stripped | `POST /assistant/messages {message, evil:1}` | `evil` ignored (whitelist) |
| H2 | History type check | `{message, history:"notarray"}` | 400 |
| H3 | Large/odd input | very long message | handled, no 500 |

---

## Out of scope (documented, not executed here)

- Concurrency races (retry double-click) — needs a load harness.
- Real extraction accuracy — needs labelled fixtures + a real AI key budget.
- WebSocket invoice events — covered by manual UI testing.
- Rate limiting — not implemented yet (a review finding).
