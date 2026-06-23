# Run & Test Strategy (incl. no-Docker path)

This document is the implementation spec for getting the invoice-extraction system running locally and verifying it. It covers two run paths, the test strategy, how to mock Anthropic + OCR, a manual smoke-test checklist mapping every TASK.md requirement to a verification step, and CI.

## 0. Required environment variables

Both run paths read the same `.env`. Backend `.env` (at `backend/.env`):

```bash
# --- Core ---
NODE_ENV=development
PORT=3000

# --- Postgres (TypeORM) ---
DB_HOST=localhost
DB_PORT=5432
DB_USER=invoices
DB_PASSWORD=invoices
DB_NAME=invoices
DB_SYNCHRONIZE=true          # dev only; use migrations in prod

# --- Redis (BullMQ + Socket.IO adapter) ---
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# --- Anthropic ---
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6   # cost-sensitive default; see note below

# --- Uploads ---
UPLOAD_DIR=./uploads
MAX_UPLOAD_MB=20
```

Frontend `.env` (at `frontend/.env`):

```bash
VITE_API_URL=http://localhost:3000
VITE_WS_URL=http://localhost:3000
```

**Model decision:** default `CLAUDE_MODEL=claude-sonnet-4-6` ($3/$15 per MTok). It has the strongest tool-use reliability per dollar and a 1M context window — invoice text is small, so context isn't the constraint; extraction accuracy and clean tool-call JSON are. Drop to `claude-haiku-4-5` ($1/$5, 200K context) only if extraction volume dominates cost and you've confirmed accuracy holds on your invoice set — Haiku occasionally needs a more prescriptive system prompt for multi-field structured extraction. Keep `claude-opus-4-8` available as an env override for hard/degraded scans. **Never hardcode the model ID** — read `CLAUDE_MODEL` so tests and CI can pin it.

`ANTHROPIC_API_KEY` must be **absent or dummy in test/CI** — tests mock the SDK and must never hit the network (see §3.3).

---

## 1. Path A — Docker Compose (Postgres + Redis + backend)

`docker-compose.yml` at repo root:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: invoices
      POSTGRES_PASSWORD: invoices
      POSTGRES_DB: invoices
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U invoices"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  backend:
    build: ./backend
    env_file: ./backend/.env
    environment:
      DB_HOST: postgres
      REDIS_HOST: redis
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

volumes:
  pgdata:
```

Run:

```bash
docker compose up -d postgres redis      # infra only, run backend natively while developing
# or
docker compose up --build                 # full stack incl. backend
```

The `backend` service is **optional** — during development run only `postgres` + `redis` in Docker and run the NestJS backend natively (`npm run start:dev`) for fast reload. The frontend (Vite dev server) is never containerized for local dev.

---

## 2. Path B — No Docker (the user has none installed)

Redis is **mandatory, not optional**: BullMQ (the processing queue) and the Socket.IO Redis adapter both require it. There is no in-memory fallback that preserves the real-time + queue behavior the task demands. So Path B = install/obtain Postgres 16 and Redis 7 natively, then run backend + frontend with npm.

### 2.1 Postgres 16 (pick one)

- **Windows (this user is on Windows 11):** install the EnterpriseDB Postgres 16 installer, or `winget install PostgreSQL.PostgreSQL.16`. After install, create the DB:
  ```bash
  createdb -U postgres invoices
  # then set DB_USER/DB_PASSWORD in .env to a role that can access it
  ```
- **Hosted alternative (zero local install):** a free Neon or Supabase Postgres. Set `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` to the connection details and add `DB_SSL=true` (have the TypeORM config pass `ssl: { rejectUnauthorized: false }` when set).

### 2.2 Redis 7 (Windows has no official native Redis)

In order of preference:

- **Memurai** (`winget install Memurai.MemuraiDeveloper`) — a native Windows Redis-compatible server, runs as a service on `localhost:6379`. This is the recommended no-Docker, no-WSL option.
- **WSL2 + Redis:** `wsl --install`, then inside Ubuntu `sudo apt install redis-server && sudo service redis-server start`. Reachable from Windows on `localhost:6379`.
- **Hosted alternative:** Upstash or Redis Cloud free tier. Set `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` to the provider's values. Note BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection — make sure the Redis module sets that regardless of host.

Verify Redis before starting the backend:

```bash
redis-cli -h localhost -p 6379 ping   # expect: PONG  (memurai-cli on Memurai)
```

### 2.3 Step-by-step run (applies to both paths once infra is up)

**Backend:**

```bash
cd backend
npm ci
cp .env.example .env        # then fill ANTHROPIC_API_KEY
npm run start:dev           # nest start --watch, listens on :3000
```

On boot the backend must: connect TypeORM (auto-create tables when `DB_SYNCHRONIZE=true`), connect BullMQ to Redis, and attach the Socket.IO gateway. If Redis is down the process should **fail loudly at startup**, not silently degrade — a missing queue means invoices never leave `uploaded`.

**Frontend:**

```bash
cd frontend
npm ci
cp .env.example .env
npm run dev                 # Vite dev server on :5173, proxies to :3000
```

Open `http://localhost:5173`.

---

## 3. Test strategy

Test runner: **Jest** (`@nestjs/testing`, `jest`, `ts-jest`, `supertest` for HTTP). Frontend: **Vitest** + **@testing-library/react**. Three layers.

### 3.1 Unit tests (no Postgres, no Redis, no network)

**a) Status machine.** The lifecycle `uploaded → processing → completed/failed` with `failed → processing` (retry) is the highest-value unit to test because it gates everything. Implement transitions as a pure function and test the matrix:

```typescript
// status-machine.ts
export type Status = 'uploaded' | 'processing' | 'completed' | 'failed';
const ALLOWED: Record<Status, Status[]> = {
  uploaded: ['processing'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['processing'],          // retry re-enters the pipeline
};
export function canTransition(from: Status, to: Status): boolean {
  return ALLOWED[from].includes(to);
}
export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to))
    throw new Error(`illegal transition ${from} -> ${to}`);
}
```

```typescript
// status-machine.spec.ts
it('allows the happy path', () => {
  expect(canTransition('uploaded', 'processing')).toBe(true);
  expect(canTransition('processing', 'completed')).toBe(true);
});
it('allows retry only from failed', () => {
  expect(canTransition('failed', 'processing')).toBe(true);
  expect(canTransition('completed', 'processing')).toBe(false);
});
it('rejects skipping processing', () => {
  expect(canTransition('uploaded', 'completed')).toBe(false);
});
it('treats completed and failed-from-completed as terminal/illegal', () => {
  expect(() => assertTransition('completed', 'failed')).toThrow();
});
```

**b) Extraction parsing.** The OCR/pdf-parse → Claude step returns structured JSON; the parser that maps Claude's tool-use output into the `Invoice` entity must be tested in isolation with fixed inputs. Cover: well-formed extraction, missing optional fields, malformed line items, currency/number coercion, and the empty-OCR case. Feed the parser a captured Claude tool-use `input` object (a fixture JSON) — not a live call:

```typescript
it('maps a complete extraction to entity fields', () => {
  const parsed = parseExtraction(fixtures.completeToolInput);
  expect(parsed.invoiceNumber).toBe('INV-1001');
  expect(parsed.total).toBeCloseTo(1234.56);
  expect(parsed.lineItems).toHaveLength(3);
});
it('defaults missing optional fields to null, not undefined', () => {
  const parsed = parseExtraction(fixtures.noDueDate);
  expect(parsed.dueDate).toBeNull();
});
it('throws a typed ExtractionError on empty/garbage OCR', () => {
  expect(() => parseExtraction(fixtures.emptyText)).toThrow(ExtractionError);
});
```

**c) Assistant tool dispatch.** The AI assistant exposes tools (`list_invoices`, `get_invoice`, `retry_invoice`, `filter_invoices`). Test the **dispatcher** — the code that takes a Claude `tool_use` block and routes it to a service method — independent of Claude. Mock the services, assert the right method is called with the right args, and assert the `tool_result` shape:

```typescript
it('routes retry_invoice to InvoiceService.retry with the id', async () => {
  const svc = { retry: jest.fn().mockResolvedValue({ id: 'a', status: 'processing' }) };
  const result = await dispatchTool(
    { name: 'retry_invoice', input: { id: 'a' }, id: 'toolu_1' }, { invoiceService: svc },
  );
  expect(svc.retry).toHaveBeenCalledWith('a');
  expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
});
it('returns is_error tool_result for unknown tool, never throws', async () => {
  const result = await dispatchTool({ name: 'nope', input: {}, id: 'x' }, {});
  expect(result.is_error).toBe(true);
});
```

### 3.2 Integration / e2e (full upload → processing → completed)

One end-to-end Jest test using **Supertest** against the real Nest app, with Postgres and Redis real but **Anthropic and OCR stubbed**. This proves the queue, status machine, persistence, and websocket emit all wire together.

For CI and local determinism, run Postgres + Redis via the Docker dependencies already in CI (services in §5) or the natively-installed ones. Use a separate `DB_NAME=invoices_test` and a Redis db index (`REDIS_DB=1`) so e2e never clobbers dev data.

Process the BullMQ job **inline/synchronously in test** by configuring the queue with no separate worker process and awaiting job completion via `queueEvents.waitUntilFinished(queue, jobId)`, then poll the invoice row until status is terminal (bounded, e.g. 5s timeout):

```typescript
it('upload -> processing -> completed with stubbed Claude + OCR', async () => {
  const res = await request(app.getHttpServer())
    .post('/invoices')
    .attach('file', fixturePath('sample-invoice.pdf'))
    .expect(201);
  const id = res.body.id;
  expect(res.body.status).toBe('uploaded');

  await waitForStatus(app, id, 'completed', 5000);  // polls GET /invoices/:id

  const done = await request(app.getHttpServer()).get(`/invoices/${id}`).expect(200);
  expect(done.body.status).toBe('completed');
  expect(done.body.extracted.invoiceNumber).toBe('INV-FIXTURE');
});
```

Add a second e2e test for the **failure + retry** path: configure the Claude stub to throw on first call, assert the invoice lands in `failed`, `POST /invoices/:id/retry`, then with the stub now succeeding assert it reaches `completed`. This is the single most important integration test — it exercises the retry edge of the status machine through the real queue.

A websocket e2e: connect a `socket.io-client` to the app's HTTP server, upload, and assert an `invoice:updated` event arrives with `status: 'completed'`.

### 3.3 Mocking Anthropic + OCR

**Anthropic.** Inject the SDK behind a provider token so it's swappable in the test module. Production wraps `@anthropic-ai/sdk`:

```typescript
// claude.module.ts
export const ANTHROPIC = Symbol('ANTHROPIC');
export const anthropicProvider = {
  provide: ANTHROPIC,
  useFactory: (cfg: ConfigService) =>
    new Anthropic({ apiKey: cfg.get('ANTHROPIC_API_KEY') }),
  inject: [ConfigService],
};
```

In tests, override the provider with a fake that returns canned tool-use responses — no network, no SDK internals:

```typescript
const fakeAnthropic = {
  messages: {
    create: jest.fn().mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'record_invoice',
          input: { invoiceNumber: 'INV-FIXTURE', total: 100, lineItems: [] } },
      ],
    }),
  },
};
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(ANTHROPIC).useValue(fakeAnthropic)
  .compile();
```

For unit tests of the assistant, the same fake drives different `tool_use` blocks per `mockResolvedValueOnce` to simulate a multi-turn tool loop. **Never** mock by patching `@anthropic-ai/sdk` module internals — go through the injected provider; it stays valid across SDK upgrades.

**OCR.** Same pattern: put OCR behind an `ExtractionTextSource` interface with two real impls (`pdf-parse` for text PDFs, `tesseract.js` for images) selected by MIME type. In tests inject a stub that returns fixed text from a fixture, keyed by filename:

```typescript
const fakeOcr = { extractText: jest.fn().mockResolvedValue('INVOICE INV-FIXTURE TOTAL 100') };
// .overrideProvider(OCR_SOURCE).useValue(fakeOcr)
```

This keeps tests fast (Tesseract is slow and downloads language data) and deterministic, and decouples extraction-pipeline tests from real image processing. Keep **one** non-mocked OCR smoke test, marked slow and excluded from the default Jest run (`testPathIgnorePatterns` or a `@slow` project), that runs `tesseract.js` on a real fixture image to catch real OCR regressions.

### 3.4 Seed / fixture invoice files

Commit a small fixtures set under `backend/test/fixtures/` and reference them by absolute path in tests:

- `sample-invoice.pdf` — a clean text PDF (extractable by `pdf-parse`, no OCR). Primary happy-path fixture.
- `sample-invoice.png` / `.jpg` — a rendered image of the same invoice, forces the Tesseract path.
- `scanned-invoice.png` — a deliberately noisy/low-contrast scan for the slow OCR test.
- `corrupt.pdf` — zero-byte / truncated file to test upload validation and the failure path.
- `multi-page.pdf` — multi-line-item invoice to exercise line-item parsing.
- `tool-inputs/*.json` — captured Claude `tool_use.input` objects (complete, missing-fields, empty) for the parser unit tests, so those tests need neither OCR nor Claude.

Provide a seed script `backend/scripts/seed.ts` (`npm run seed`) that inserts 3–4 invoices directly via the repository in mixed states (`completed`, `failed`, `processing`) so the frontend list, the assistant queries, and the retry button have something to act on without manually uploading. Seeding writes rows only — it does **not** enqueue jobs.

---

## 4. Manual smoke-test checklist (TASK.md requirement → verification step)

Run after `npm run start:dev` (backend) + `npm run dev` (frontend) with infra up and `npm run seed` executed.

| # | TASK.md requirement | Verification step |
|---|---|---|
| 1 | **Invoice upload (PDF or image)** | In the UI, upload `sample-invoice.pdf`, then `sample-invoice.png`. Both accepted; a new row appears in the list with status `uploaded` → `processing`. Upload `corrupt.pdf` → rejected with a validation error, no row stuck in `processing`. |
| 2 | **List of uploaded invoices with current status** | Seeded + uploaded invoices all visible with a status badge. Refresh the page — list persists (data is in Postgres, not memory). |
| 3 | **Real-time status updates (no refresh)** | Upload a PDF and **do not touch the page**. The row transitions `uploaded → processing → completed` on its own. Open browser devtools → Network → WS: confirm `invoice:updated` frames arrive. Kill nothing manually. |
| 4 | **Extracted data visible once completed** | Click a `completed` invoice → detail view shows invoice number, dates, totals, and line items matching the source file. A `processing` invoice shows no extracted data yet. |
| 5 | **Retry mechanism for failed invoices** | Find a seeded `failed` invoice (or force one: temporarily set an invalid `ANTHROPIC_API_KEY` and upload). Click **Retry** → status returns to `processing` then `completed` (after restoring the key). Retry button is absent/disabled on non-failed invoices. |
| 6 | **AI assistant — answer questions** | In the assistant chat, ask "How many invoices failed?" and "What's the total on invoice INV-1001?". Answers match the list/detail data. |
| 7 | **AI assistant — take actions** | Ask "Retry all failed invoices" or "Retry invoice <id>". Confirm via the list that the targeted invoice(s) moved to `processing` — i.e. the assistant invoked the `retry_invoice` tool, not just described it. Then ask "Show me only completed invoices" and confirm it filters. |

If any row in this table fails, that requirement is not done — fix before claiming completion.

---

## 5. CI

GitHub Actions, `.github/workflows/ci.yml`. Postgres + Redis as service containers (CI runners have Docker even though the user doesn't). Anthropic + OCR are mocked, so **no `ANTHROPIC_API_KEY` secret is needed** — set a dummy value to satisfy config validation.

```yaml
name: ci
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: invoices, POSTGRES_PASSWORD: invoices, POSTGRES_DB: invoices_test }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U invoices" --health-interval 5s
          --health-timeout 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DB_HOST: localhost
      DB_NAME: invoices_test
      DB_USER: invoices
      DB_PASSWORD: invoices
      REDIS_HOST: localhost
      ANTHROPIC_API_KEY: dummy-key-tests-mock-the-sdk
      CLAUDE_MODEL: claude-sonnet-4-6
    defaults: { run: { working-directory: backend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test -- --ci --runInBand        # unit + e2e; runInBand avoids Redis/PG races

  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test -- --run                    # vitest, non-watch
```

Notes: `--runInBand` is required because the e2e tests share one Postgres/Redis and parallel Jest workers race on the same tables/keys. The slow real-OCR test stays out of the default `npm test` (separate `npm run test:ocr`) so CI doesn't download Tesseract language data on every run — run it on a nightly/manual workflow if you want coverage. Keep CI green as the definition of "tests pass" in the README's run+test instructions.
```

Relevant file paths referenced in this spec (to be created during implementation):
- `c:\Users\Viktor\Documents\GitHub\Kosher\docker-compose.yml`
- `c:\Users\Viktor\Documents\GitHub\Kosher\backend\.env` (+ `.env.example`)
- `c:\Users\Viktor\Documents\GitHub\Kosher\frontend\.env` (+ `.env.example`)
- `c:\Users\Viktor\Documents\GitHub\Kosher\backend\test\fixtures\` (seed/fixture invoices + `tool-inputs/*.json`)
- `c:\Users\Viktor\Documents\GitHub\Kosher\backend\scripts\seed.ts`
- `c:\Users\Viktor\Documents\GitHub\Kosher\.github\workflows\ci.yml`

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

I have the model IDs and SDK details verified against the reference. Now reviewing the draft for factual/technical errors.

Verified facts relevant to this review:
- `claude-sonnet-4-6` ($3/$15, 1M context), `claude-haiku-4-5` ($1/$5, 200K context), `claude-opus-4-8` ($5/$25, 1M context) — all correct model IDs and pricing.
- Tool-use structure: assistant emits `tool_use` blocks (`id`, `name`, `input`); user returns `tool_result` blocks (`tool_use_id`, `content`, optional `is_error: true`). `stop_reason: "tool_use"`. Tool IDs are `toolu_...`.

Now the review of the runtest draft.

The draft is strong overall. The Anthropic SDK mocking, tool-use/tool_result block shapes, role conventions, model IDs, and pricing are all correct. The errors are concentrated in two non-Anthropic areas the draft asserts confidently: a BullMQ test-helper API call and a Sonnet context-window claim. Concrete corrections:

- [SEVERITY high] The model note claims `claude-sonnet-4-6` has "a 1M context window" and contrasts it against Haiku's "200K context" as if 1M were Sonnet-specific. Per the model catalog, Sonnet 4.6 does have a 1M window — but so does `claude-opus-4-8` (1M). The pricing tokens ($3/$15 Sonnet, $1/$5 Haiku, and implicitly Opus elsewhere) are all correct. The factual slip is only that the prose frames 1M context as a Sonnet differentiator vs Opus; Opus 4.8 is also 1M, so "context isn't the constraint" reasoning is fine but the implied Sonnet-vs-Opus context edge does not exist. -> Sonnet 4.6, Opus 4.8 are both 1M context; Haiku 4.5 is 200K. The pricing figures are correct as written.

- [SEVERITY high] `queueEvents.waitUntilFinished(queue, jobId)` is the wrong BullMQ signature. `waitUntilFinished` is a method on the `QueueEvents` instance and takes `(queueEvents, ttl?)` — it is called on a `Job` instance, not given the queue. -> The correct BullMQ API is `await job.waitUntilFinished(queueEvents, ttl?)` where `job` is the returned `Job` and `queueEvents` is an initialized `QueueEvents` instance (which must have `.waitUntilReady()` awaited first). There is no `queueEvents.waitUntilFinished(queue, jobId)` form.

- [SEVERITY med] "Process the BullMQ job inline/synchronously in test by configuring the queue with no separate worker process and awaiting job completion" conflates two things. BullMQ has no in-process "inline"/synchronous mode — a `Worker` always processes off Redis asynchronously (unlike Bull v3's `process` sandbox or some queue libs). To process in-test you still instantiate a real `Worker` in the test process pointed at the same Redis; jobs do not run without a Worker. -> Reword: spin up a real `Worker` inside the test process (same Redis connection), then await completion via `job.waitUntilFinished(queueEvents)`. There is no worker-less/synchronous execution path in BullMQ.

- [SEVERITY med] The `dispatchTool` unit test asserts the dispatcher returns an object with `type: 'tool_result'` and `tool_use_id`, and the assistant-dispatch example reads the incoming block as `{ name, input, id }`. That is internally consistent and matches the real Anthropic shape (incoming `tool_use` has `id`; outgoing `tool_result` has `tool_use_id`) — good. But note `is_error` on a `tool_result` is a boolean field that must sit on the tool_result block itself; the test `expect(result.is_error).toBe(true)` is correct only if `dispatchTool` returns the raw tool_result block (not a wrapper). This is a design assertion, not a bug — flagging only that the returned object must be the literal `{ type: 'tool_result', tool_use_id, content, is_error }` block to be valid when fed back to the API. -> No correction needed if `dispatchTool` returns the canonical tool_result block; just ensure `content` is present alongside `is_error` (the API requires `content` even on error results).

- [SEVERITY low] The Anthropic mock returns `stop_reason: 'tool_use'` with a single `tool_use` content block — correct. One omission: a faithful mock of a multi-turn loop should also drive a terminal turn with `stop_reason: 'end_turn'` (via `mockResolvedValueOnce`), which the prose mentions but the code fixture does not show. Not an error, just incomplete relative to the "multi-turn tool loop" claim. -> Add a second `mockResolvedValueOnce` returning `stop_reason: 'end_turn'` so the assistant loop actually terminates.

- [SEVERITY low] `REDIS_DB=1` is referenced for the e2e Redis index but the env-var block in §0 only lists `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — no `REDIS_DB`. Minor internal inconsistency: the variable the e2e section relies on isn't declared in the canonical env list. -> Add `REDIS_DB` to the §0 env block (and note ioredis uses the `db` connection option), or the e2e isolation knob is undefined.

- [SEVERITY low] `maxRetriesPerRequest: null` is correctly called out as required for BullMQ's blocking connection — accurate. Worth noting it's specifically required for the connection used by `Worker`/`QueueEvents` (the blocking BRPOPLPUSH consumer); a plain `Queue` producer connection tolerates the default. The draft's blanket "regardless of host" phrasing is fine and not wrong. -> No correction; accurate as stated.

Sections that are solid, briefly:
- Anthropic provider injection, `overrideProvider(ANTHROPIC).useValue(fakeAnthropic)`, and the `messages.create` mock shape are all correct NestJS + SDK usage.
- tool_use/tool_result block fields (`id` in, `tool_use_id` out, `is_error`, `content`), `stop_reason: 'tool_use'`, and `toolu_` ID convention are all correct.
- Model IDs and pricing ($3/$15, $1/$5) are correct; the Sonnet-vs-Haiku recommendation tradeoff is sound.
- Multer/upload usage isn't shown in code here (only `.attach('file', ...)` in Supertest, which is correct), so no upload-API errors to flag.
- TypeORM specifics (jsonb/enum/uuid columns) aren't present in this doc — the status machine is a plain TS union, correctly not tied to a DB enum — so nothing to correct there.
- CI service-container config, `--runInBand` rationale, and the dummy `ANTHROPIC_API_KEY` for mocked tests are all correct.
