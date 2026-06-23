# REST API Surface (as built)

> **Updated to match the shipped code.** The original plan listed an `/api`
> prefix, paginated lists, and a smaller endpoint set. The system actually built
> serves **unprefixed** routes, returns plain arrays (no pagination yet), and has
> a larger surface (field edit, reprocess, SSE chat, engine switch, export,
> auth). This doc reflects the real controllers. Swagger UI is at `/docs`.

## Conventions

- **No global prefix** — routes are at the bare path (`/invoices`, not
  `/api/invoices`). The frontend `lib/api.ts` targets the same.
- **Auth** — a global `JwtAuthGuard` protects everything except `@Public()`
  routes (`POST /auth/login`, `GET /health`). Send
  `Authorization: Bearer <jwt>`. The same JWT authenticates the Socket.IO
  handshake.
- **IDs** — UUID v4 (`@PrimaryGeneratedColumn('uuid')`), validated by
  `ParseUUIDPipe` → `400` on a bad UUID.
- **Validation** — a global `ValidationPipe({ whitelist: true, transform: true })`;
  unknown body fields are stripped.
- **Upload** — `POST /invoices` is `multipart/form-data` (field `file`); Multer
  allows `application/pdf` / `image/png` / `image/jpeg`, max `MAX_UPLOAD_SIZE_MB`
  (default 10 MB) → `400`/`413` on reject. (MIME is checked by header, not magic
  bytes — see [../reviews/04-broken-file-tests.md](../reviews/04-broken-file-tests.md).)

## Endpoints (20 routes)

### Auth & health (public)

| Method & path | Purpose | Codes |
|---|---|---|
| `POST /auth/login` | `{username, password}` → `{accessToken}` | 200/201, 401 wrong creds, 400 missing |
| `GET /health` | Liveness | 200 |

### Invoices

| Method & path | Purpose | Codes |
|---|---|---|
| `POST /invoices` | Upload (multipart `file`) → row `uploaded`, enqueue job | 201, 400 bad/no file, 413 too large |
| `GET /invoices?status=` | List, newest first, optional status filter (plain array) | 200, 400 bad status |
| `GET /invoices/stats` | Aggregates: byStatus, byCurrency, topVendors, overdue, averages, overTime | 200 |
| `GET /invoices/export/:format` | `xlsx`/`csv`/`zip`; filters `status,vendor,minTotal,maxTotal,search` | 200, 400 bad format |
| `GET /invoices/:id` | One invoice incl. `extractedData` | 200, 400 bad uuid, 404 |
| `GET /invoices/:id/file` | Download/preview the original file | 200, 404 |
| `PATCH /invoices/:id` | **Correct extracted fields** (vendor, total, dates, currency, subtotal, tax) | 200, 400 bad field, 404 |
| `POST /invoices/:id/retry` | Retry a **failed** invoice | 200, 400 not-failed, 404 |
| `POST /invoices/:id/reprocess` | **Re-run extraction** on any status (re-check) | 200, 400 in-flight, 404 |
| `DELETE /invoices/:id` | Delete row + file | 204, 404 |

### Assistant

| Method & path | Purpose | Codes |
|---|---|---|
| `POST /assistant/messages` | Chat (answer + act); `{message, history?, confirm?}` → `{content, actions, history, pendingConfirmation?}` | 200, 503 engine unavailable |
| `POST /assistant/messages/stream` | Same, **streamed as SSE** (`step` frames then `result`) | 200 (event-stream) |
| `POST /assistant/analyze` | Anomalies (duplicates / high-amount) + narrative summary | 200/201 |
| `POST /assistant/invoices/:id/explain` | 2-sentence plain-language summary | 200/201, 404 |

### AI engine switch

| Method & path | Purpose |
|---|---|
| `GET /ai/models` · `PUT /ai/model` | List / switch the **primary extraction** engine |
| `GET /ai/assistant-engine` · `PUT /ai/assistant-engine` | List / switch the **chat** engine (provider + model) |

## Editable fields (`PATCH /invoices/:id`)

Only a safe scalar subset may be edited (no line items, no classification
fields): `vendorName`, `invoiceNumber`, `invoiceDate`, `dueDate`, `currency`,
`subtotal`, `tax`, `total`. Each is optional and nullable; unknown keys → 400.
The same method backs the assistant's confirmed `update_invoice`.

## Confirmation tokens (assistant)

Destructive assistant actions (`delete_*`, `update_invoice`) return a
`pendingConfirmation` with an HMAC-signed token (5-min TTL). The client re-posts
`{ confirm: { token } }`; the backend verifies and applies it without re-invoking
the LLM. See [07-ai-assistant.md](07-ai-assistant.md).

## CORS

`app.enableCors()` is **open** (any origin) in the shipped build, and the
Socket.IO gateway uses `cors: { origin: true }`. The code review flags this as a
hardening item — see
[../reviews/00-code-review-report.md](../reviews/00-code-review-report.md).

## Quick smoke test

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H content-type:application/json \
  -d '{"username":"admin","password":"admin"}' | jq -r .accessToken)
H="-H authorization:Bearer $TOKEN"

curl -s $H localhost:3000/invoices/stats | jq
curl -s $H localhost:3000/assistant/messages -H content-type:application/json \
  -d '{"message":"How many invoices failed?"}' | jq .content
curl -s $H "localhost:3000/invoices/export/xlsx?status=completed" -o invoices.xlsx
```

Full results of running every route are in
[../reviews/03-api-test-results.md](../reviews/03-api-test-results.md) (42/42).
