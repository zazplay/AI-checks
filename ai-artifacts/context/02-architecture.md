# System Architecture & Module Decomposition

This is the implementation spec for the backend module layout, the upload-to-completed flow, and the directory trees. It is opinionated: where there is a choice, this document makes it.

## 1. Starting point (existing scaffold)

The repo root is `invoice-system/`. The relevant facts you build on top of:

- `backend/` is a stock NestJS 10 app: `app.module.ts` imports only `ConfigModule.forRoot({ isGlobal: true })`; `main.ts` calls `app.enableCors()` and listens on `PORT ?? 3000`. There are **empty** `src/invoices/` and `src/assistant/` folders (`.gitkeep` only). `app.controller.ts`/`app.service.ts` are the default health stub — keep them as `GET /` liveness.
- `backend/.env` already defines `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `UPLOAD_DIR=./uploads`, `MAX_UPLOAD_SIZE_MB=10`, `ANTHROPIC_API_KEY`. **Every module reads config through these exact keys.** Do not invent new ones.
- `docker-compose.yml` provides `postgres:16-alpine` and `redis:7-alpine`. The backend service is behind a `backend` profile (off by default), so the default dev story is **native node against compose-provided infra** — and since the user has no Docker, also against any local Postgres/Redis on those ports.
- `frontend/` is Vite + React 18 with a placeholder `App.tsx`.

Packages to add (exact names): backend — `@nestjs/typeorm typeorm pg @nestjs/bullmq bullmq @nestjs/websockets @nestjs/platform-socket.io socket.io @anthropic-ai/sdk multer @types/multer class-validator class-transformer tesseract.js pdf-parse uuid`. Frontend — `socket.io-client`.

## 2. Module decomposition

Five feature modules plus shared infra. Each module owns one responsibility and exposes a narrow provider surface.

| Module | Owns | Exports | Depends on |
|---|---|---|---|
| `ConfigModule` (global) | env validation, typed config | config | — |
| `DatabaseModule` | TypeORM connection (`forRootAsync`) | — (global pool) | Config |
| `InvoicesModule` | `Invoice` entity, REST CRUD, upload, retry, status transitions | `InvoicesService` | Database, Processing |
| `ProcessingModule` | BullMQ queue registration, `invoice-processing` worker, OCR + Claude extraction | `QueueProducer` | Database, Realtime, Extraction |
| `ExtractionModule` | OCR (`tesseract.js`/`pdf-parse`) + Claude structuring via tool use | `ExtractionService` | Config |
| `RealtimeModule` | Socket.IO gateway, emits invoice events | `RealtimeService` | — |
| `AssistantModule` | Claude chat with tool use; tools call `InvoicesService`/`QueueProducer` | `AssistantService` | Invoices, Processing |

**Decision: the producer lives in `ProcessingModule`, not `InvoicesModule`.** `InvoicesModule` imports `ProcessingModule` and calls `producer.enqueue(invoiceId)`. This keeps all BullMQ knowledge (queue name, job options, retry policy) in one place. To break the natural `Invoices ↔ Processing` cycle (the worker must update invoice rows, and Invoices must enqueue), the **worker writes to the DB via the repository directly**, not by importing `InvoicesService`. So the dependency is one-directional: `Invoices → Processing`. The worker depends on `Repository<Invoice>` + `RealtimeService` + `ExtractionService` only.

**Decision: `RealtimeService` is a thin emit-only facade** over the gateway so non-gateway code (the worker) never touches `@WebSocketServer()` directly. The gateway is for connection lifecycle; the service is for `emitStatusChange()`.

## 3. The Invoice entity & status machine

```ts
// invoices/entities/invoice.entity.ts
export type InvoiceStatus = 'uploaded' | 'processing' | 'completed' | 'failed';

@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() originalFilename: string;
  @Column() storedPath: string;          // path under UPLOAD_DIR
  @Column() mimeType: string;            // application/pdf | image/*
  @Column({ type: 'varchar', default: 'uploaded' }) status: InvoiceStatus;
  @Column({ type: 'jsonb', nullable: true }) extractedData: ExtractedInvoice | null;
  @Column({ type: 'text', nullable: true }) rawText: string | null;  // OCR output, audit
  @Column({ type: 'text', nullable: true }) errorMessage: string | null;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
```

`ExtractedInvoice` is the structured target Claude fills: `{ invoiceNumber, vendorName, invoiceDate, dueDate, currency, subtotal, tax, total, lineItems: {description, quantity, unitPrice, amount}[] }`. It is the Claude tool's `input_schema` **and** the persisted jsonb — one shape, defined once in `extraction/extraction.types.ts`.

Legal transitions (enforced in `InvoicesService`, never by callers):
`uploaded → processing → completed` | `processing → failed` | `failed → processing` (retry only). Retry is rejected with `409` unless `status === 'failed'`.

**Use `synchronize: true` in dev** (driven by `NODE_ENV !== 'production'`) so there are no migrations to run — this matters because the user has no Docker and minimal setup. Note in the README that production would use migrations.

## 4. Request + job flow

### 4.1 Upload (synchronous part, returns in <50ms)

1. `POST /invoices` (multipart, field `file`) hits `InvoicesController` with `FileInterceptor('file')`. Multer is configured with `diskStorage` into `UPLOAD_DIR`, `limits.fileSize = MAX_UPLOAD_SIZE_MB * 1MB`, and a `fileFilter` allowing only `application/pdf`, `image/png`, `image/jpeg`. A bad type → `400` before any DB write.
2. `InvoicesService.createFromUpload()` inserts a row with `status='uploaded'`, returns the `Invoice`.
3. Service calls `producer.enqueue(invoice.id)`, then `realtime.emitStatusChange(invoice)`.
4. Controller responds `201` with the invoice DTO. **The HTTP request never waits for OCR/Claude.**

### 4.2 Processing (async worker)

The `@Processor('invoice-processing')` worker runs in the same node process (acceptable for this assignment — documented as a scale-out seam). Per job:

1. Load invoice, set `status='processing'`, `attempts++`, save, `realtime.emitStatusChange`.
2. `ExtractionService.extract(invoice)`: branch on mime — text PDF → `pdf-parse`; image or scanned PDF → `tesseract.js`. Produce `rawText`.
3. Pass `rawText` to Claude (`@anthropic-ai/sdk`) with a single `extract_invoice` tool whose `input_schema` is `ExtractedInvoice`. Read `tool_use.input` as the structured result. **Model default: `claude-haiku-4-5-20251001`** — extraction over already-OCR'd text is a cheap, well-bounded structuring task; Haiku 4.5 is the right cost/latency pick, with `claude-sonnet-4-6` as the env-switchable upgrade for messy scans. Set this via a config key, not hardcoded.
4. On success: persist `extractedData` + `rawText`, `status='completed'`, save, emit.
5. On throw: BullMQ retries per job options (`attempts: 3, backoff: { type: 'exponential', delay: 2000 }`). On final failure the worker's `failed` handler sets `status='failed'`, writes `errorMessage`, emits. Manual retry (§4.3) is independent of BullMQ's auto-retries.

### 4.3 Retry

`POST /invoices/:id/retry` → `InvoicesService.retry()` guards `status==='failed'`, clears `errorMessage`, and re-enqueues the same `invoiceId`. The worker is idempotent on `invoiceId` (it reloads and overwrites), so re-running is safe.

## 5. Component + sequence diagram

```
                              HTTP (REST + multipart)                     WebSocket (Socket.IO)
        ┌──────────────┐  POST /invoices ───────────►┌──────────────────┐◄════ status events ════┐
        │   Frontend   │  GET  /invoices             │  NestJS backend  │                        │
        │ (Vite/React) │  POST /invoices/:id/retry   │   :3000          │                        │
        │              │  POST /assistant/chat       │                  │                        │
        └──────────────┘                             └──────────────────┘                        │
                                                            │                                     │
   ┌────────────────────────────────────────────────────────┼─────────────────────────────────┐ │
   │ NestJS process                                          ▼                                 │ │
   │  ┌───────────────┐    enqueue(id)    ┌──────────────────────────┐                         │ │
   │  │ InvoicesModule│──────────────────►│      ProcessingModule    │                         │ │
   │  │  Controller   │                   │  Producer ─► BullMQ Queue │                         │ │
   │  │  Service ─────┼─► Postgres        │             (Redis)       │                         │ │
   │  └──────┬────────┘   (TypeORM)       │                 │         │                         │ │
   │         │                            │                 ▼         │                         │ │
   │         │                            │   @Processor('invoice-    │   emitStatusChange()    │ │
   │  ┌──────▼────────┐                   │      processing') Worker  │──────────┐              │ │
   │  │AssistantModule│  tool calls       │     │            │        │          ▼              │ │
   │  │ Claude + tools├──────────────────►│     ▼            ▼        │   ┌───────────────┐     │ │
   │  └───────────────┘ (list/retry/get)  │ ExtractionService        │   │ RealtimeModule│═════╪═┘
   │                                      │  OCR → Claude structure   │   │   Gateway     │
   │                                      └─────────────┬─────────────┘   └───────────────┘
   │                                          writes extractedData,
   │                                          status to Postgres ◄────────────────┘
   └────────────────────────────────────────────────────────────────────────────────────────┘

Sequence (happy path):
 Frontend        Controller       Service        Producer/Queue      Worker         Extraction      Realtime      Frontend
    │ POST /invoices  │               │                 │               │              │               │             │
    ├────────────────►│ create()      │                 │               │              │               │             │
    │                 ├──────────────►│ INSERT status=uploaded          │              │               │             │
    │                 │               ├─enqueue(id)────►│               │              │               │             │
    │                 │               ├─emit(uploaded)──┼───────────────┼──────────────┼──────────────►│ row appears │
    │ 201 invoice     │◄──────────────┤                 │               │              │               │             │
    │◄────────────────┤               │                 │ job ready     │              │               │             │
    │                 │               │                 ├──────────────►│ status=processing            │             │
    │                 │               │                 │               ├─emit(processing)────────────►│ spinner     │
    │                 │               │                 │               ├─OCR─────────►│ rawText        │             │
    │                 │               │                 │               ├─Claude tool─►│ ExtractedInvoice            │
    │                 │               │                 │               ├─UPDATE status=completed,data │             │
    │                 │               │                 │               ├─emit(completed)─────────────►│ data shows  │
   (failure path: Extraction throws → BullMQ retries → on exhaustion status=failed → emit(failed) → Retry button)
```

## 6. WebSocket contract

One namespace (default `/`), CORS-open in dev to match `app.enableCors()`. Server→client event `invoice:status` with payload `{ id, status, extractedData?, errorMessage?, updatedAt }`. **The frontend treats the full list endpoint as source-of-truth on mount and patches rows by `id` from socket events** — no per-invoice subscriptions, no rooms. This is enough for a single-user assignment and avoids room-management complexity. Document rooms-per-invoice as a future improvement.

## 7. AI assistant wiring

`AssistantModule` imports `InvoicesModule` and `ProcessingModule`. `POST /assistant/chat` takes `{ messages }`, runs the Anthropic tool-use loop with these tools, each a thin wrapper over existing services (no business logic in the assistant):

- `list_invoices({ status? })` → `InvoicesService.findAll(filter)`
- `get_invoice({ id })` → `InvoicesService.findOne`
- `retry_invoice({ id })` → `InvoicesService.retry` (this is the "take actions" requirement)
- `get_stats()` → counts by status

The loop: send messages + tools → if `stop_reason === 'tool_use'`, execute the tool, append `tool_result`, resend → repeat until a text answer. This reuses the exact code paths the REST API uses, so the assistant can never get into a state the API can't.

## 8. Directory trees

```
backend/src/
├── main.ts                      # bootstrap, CORS, global ValidationPipe, port
├── app.module.ts                # imports Config, Database, Invoices, Processing,
│                                #   Realtime, Assistant
├── app.controller.ts            # GET / liveness (keep scaffold)
├── app.service.ts
├── config/
│   ├── configuration.ts         # typed factory reading process.env
│   └── env.validation.ts        # class-validator schema for required vars
├── database/
│   └── database.module.ts       # TypeOrmModule.forRootAsync (DATABASE_URL)
├── invoices/
│   ├── invoices.module.ts
│   ├── invoices.controller.ts   # POST / , GET / , GET /:id , POST /:id/retry
│   ├── invoices.service.ts      # transitions, retry guard, enqueue, emit
│   ├── entities/invoice.entity.ts
│   ├── dto/{create-invoice,invoice-response,list-query}.dto.ts
│   └── multer.config.ts         # diskStorage, fileFilter, size limit
├── processing/
│   ├── processing.module.ts     # BullModule.registerQueue('invoice-processing')
│   ├── queue.producer.ts        # enqueue(invoiceId)
│   ├── invoice.processor.ts     # @Processor worker
│   └── processing.constants.ts  # QUEUE_NAME, JOB_OPTS
├── extraction/
│   ├── extraction.module.ts
│   ├── extraction.service.ts    # ocr() + structureWithClaude()
│   ├── ocr.ts                   # pdf-parse | tesseract branch
│   └── extraction.types.ts      # ExtractedInvoice + Claude input_schema
├── realtime/
│   ├── realtime.module.ts
│   ├── invoices.gateway.ts      # @WebSocketGateway, connection lifecycle
│   └── realtime.service.ts      # emitStatusChange()
└── assistant/
    ├── assistant.module.ts
    ├── assistant.controller.ts  # POST /assistant/chat
    ├── assistant.service.ts     # Anthropic tool-use loop
    └── tools.ts                 # tool defs + dispatch → services

frontend/src/
├── main.tsx
├── App.tsx                      # layout: upload + list + assistant panel
├── api/
│   ├── client.ts                # fetch wrapper, VITE_API_URL
│   └── socket.ts                # socket.io-client singleton
├── hooks/
│   ├── useInvoices.ts           # fetch list + patch from socket events
│   └── useAssistant.ts          # chat state, POST /assistant/chat
├── components/
│   ├── UploadDropzone.tsx
│   ├── InvoiceList.tsx          # rows with live status badge
│   ├── InvoiceDetail.tsx        # extractedData view + Retry button
│   └── AssistantPanel.tsx
└── types.ts                     # Invoice, InvoiceStatus, ExtractedInvoice (mirror backend)
```

## 9. Wiring `app.module.ts`

```ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate }),
    DatabaseModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        connection: { host: c.get('REDIS_HOST'), port: c.get<number>('REDIS_PORT') },
      }),
    }),
    InvoicesModule, ProcessingModule, RealtimeModule, AssistantModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

`BullModule.forRoot` lives at app level (one Redis connection); each module that needs the queue calls `BullModule.registerQueue({ name: 'invoice-processing' })`. Add a global `ValidationPipe({ transform: true, whitelist: true })` in `main.ts` so DTOs are enforced.

## 10. Key decisions, restated

- **Worker writes DB directly** (via repository), breaking the Invoices↔Processing cycle; dependency flows one way `Invoices → Processing`.
- **Single ExtractedInvoice shape** is the Claude tool schema and the jsonb column — defined once.
- **`synchronize: true` in dev** — no migration step, critical for the no-Docker run path.
- **Assistant tools wrap existing services** — zero duplicated business logic; "take actions" = `retry_invoice`.
- **Haiku 4.5 default** for extraction, Sonnet 4.6 via config for hard scans.
- **List-as-source-of-truth + socket patches** — no rooms, simplest correct real-time model for one user.

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

## Claude / Anthropic SDK

- [SEVERITY low] The doc hardcodes `claude-haiku-4-5-20251001` as the extraction model default and `claude-sonnet-4-6` as the upgrade. Both ids are valid (the dated Haiku full id and the Sonnet alias resolve correctly), so this is not an error. One nuance worth flagging: the alias `claude-haiku-4-5` is also valid and is the more idiomatic form — the dated suffix `-20251001` is only needed if you want to pin. Not wrong, just inconsistent with the alias-style `claude-sonnet-4-6` used right beside it. -> Prefer `claude-haiku-4-5` for consistency, or pin both with full ids; don't mix one aliased and one dated.
- [SEVERITY none] Tool-use structure is correct. `input_schema` (snake_case) is the right field name for a tool definition; reading `tool_use.input` for the structured result is correct; the loop (`stop_reason === 'tool_use'` → execute → append `tool_result` → resend) matches the documented agentic loop; `tool_result` blocks go in a `user`-role message and the assistant's `tool_use` is echoed back in the `assistant` turn. All accurate. Note `stop_reason` values are snake_case strings (`"tool_use"`), which the doc uses correctly.

## BullMQ + @nestjs/bullmq

- [SEVERITY high] The doc lists the package as `@nestjs/bullmq` in the install list but then writes `BullModule.forRootAsync(...)` and `BullModule.registerQueue(...)`. The module/import names are consistent with `@nestjs/bullmq` (which exports `BullModule`), so that is fine — **but** §9 mixes APIs: under `@nestjs/bullmq` the root config key for the connection is correct as `connection: { host, port }`, which the doc uses. The actual problem is the decorator/worker model described in §4.2: it says `@Processor('invoice-processing')` "worker runs in the same node process" and refers to a `failed` handler "the worker's `failed` handler sets `status='failed'`." In `@nestjs/bullmq`, a `@Processor`-decorated class extends `WorkerHost` and implements `process()`; lifecycle events like `failed` are handled with the `@OnWorkerEvent('failed')` decorator, not an ad-hoc "failed handler." -> State that the processor class extends `WorkerHost` with a `process(job)` method, and that the failed-after-retries hook is `@OnWorkerEvent('failed')`.
- [SEVERITY med] §4.2 step 5 says "On final failure the worker's `failed` handler sets `status='failed'`." With BullMQ auto-retries (`attempts: 3`), the `failed` event fires on **every** failed attempt, not only the last. Code that sets `status='failed'` in the failed handler unconditionally will flip the row to `failed` after attempt 1 even though attempts 2 and 3 will still run. -> Guard on `job.attemptsMade >= job.opts.attempts` (or move the terminal write into `process()` when retries are exhausted) so `status='failed'` is only written after the final attempt.
- [SEVERITY med] §4.2 increments `attempts++` on the entity inside the processor and also relies on BullMQ's `attempts: 3`. These are two independent counters (the DB `attempts` column vs. `job.attemptsMade`). That is a legitimate design choice, but the doc never reconciles them, and §4.3 (manual retry) re-enqueues "the same `invoiceId`" — manual re-enqueue creates a **new** job with its own `attemptsMade` reset to 0, while the DB `attempts` keeps climbing. -> Not a bug per se, but call out that the DB `attempts` is cumulative across manual retries while BullMQ's `attemptsMade` resets per job; otherwise the two diverge silently.

## @nestjs/websockets

- [SEVERITY none] The described usage is correct: `@WebSocketGateway` for the gateway, `@WebSocketServer()` to grab the Socket.IO `Server`, a thin `RealtimeService` that calls `server.emit(...)`. Server→client emit of `invoice:status` is fine. No API error here. (Minor: the gateway needs CORS configured in the `@WebSocketGateway({ cors: ... })` decorator — `app.enableCors()` covers the HTTP server but **not** the Socket.IO handshake. The doc says "CORS-open in dev to match `app.enableCors()`" which implies they're the same; they are configured separately.) -> Flag: Socket.IO CORS is set in the `@WebSocketGateway` decorator options, independently of `app.enableCors()`.

## TypeORM entity

- [SEVERITY med] `@Column({ type: 'varchar', default: 'uploaded' }) status: InvoiceStatus` — the doc deliberately uses `varchar` instead of a Postgres enum, which is a defensible choice (avoids enum-migration pain) and is internally consistent with the union type. Not an error. However, with `synchronize: true` and a `varchar` column, there is **no DB-level constraint** enforcing the four states — the "legal transitions" are app-enforced only, which the doc does claim ("enforced in `InvoicesService`"). Consistent. No correction needed beyond noting the enum safety is purely application-level.
- [SEVERITY low] `@Column({ type: 'jsonb', nullable: true }) extractedData: ExtractedInvoice | null` — correct. `jsonb` is the right Postgres type and TypeORM maps it properly; storing a typed object is fine. No error.
- [SEVERITY low] `@PrimaryGeneratedColumn('uuid')` — correct; generates `uuid` via `gen_random_uuid()`/`uuid_ossp` depending on driver. With `synchronize: true` on Postgres 16, TypeORM uses `uuid_generate_v4()` which requires the `uuid-ossp` extension to be present, or it relies on `pgcrypto`. -> Minor gap to flag in README: the `uuid` generation strategy may need a Postgres extension enabled; on a user-provided local Postgres this can fail at `synchronize` time.

## Multer / NestJS upload

- [SEVERITY none] §4.1 usage is correct: `FileInterceptor('file')`, `diskStorage` into `UPLOAD_DIR`, `limits.fileSize`, and a `fileFilter` for the three mime types. A rejected `fileFilter` does surface as a `400` when wired through Nest's exception layer (the multer error is thrown before controller logic). The "<50ms" / "never waits for OCR" claims are architecturally sound given the enqueue-then-respond flow. One nit: `limits.fileSize = MAX_UPLOAD_SIZE_MB * 1MB` — multer's `fileSize` limit is in **bytes**, so it must be `MAX_UPLOAD_SIZE_MB * 1024 * 1024`; "1MB" is pseudocode, fine as written but make sure the implementation uses bytes. -> Confirm `fileSize` is computed in bytes (`MB * 1024 * 1024`), not a literal `1MB`.

## Cross-cutting / internal consistency

- [SEVERITY med] §2 table says `ProcessingModule` exports `QueueProducer` and `InvoicesModule` "imports `ProcessingModule` and calls `producer.enqueue(invoiceId)`," while the worker "writes to the DB via the repository directly." This is clean and the cycle-break reasoning is valid. But the worker is also said to depend on `RealtimeService` (from `RealtimeModule`) and `ExtractionService` (from `ExtractionModule`), yet the dependency table lists `ProcessingModule` depends on "Database, Realtime, Extraction" — consistent. No error. The decomposition is sound.
- [SEVERITY low] §9 wiring: `BullModule.forRootAsync` is at app level and `registerQueue({ name: 'invoice-processing' })` per module — correct `@nestjs/bullmq` pattern. The text says "`BullModule.forRoot` lives at app level" but the code uses `forRootAsync`; trivial prose/code mismatch (both exist; the code is the correct one). -> Align prose with code (`forRootAsync`).
- [SEVERITY none] `synchronize: true` in dev gated on `NODE_ENV !== 'production'` is a normal, correct pattern and the README caveat about migrations in prod is the right call-out.

### Net assessment
The Anthropic/tool-use content is **accurate** — model ids valid, `input_schema`/`tool_use`/`tool_result`/`stop_reason` all correct. The TypeORM, Multer, and websockets usage are essentially correct with only minor caveats (Socket.IO CORS, byte units, uuid extension). The one area a senior engineer would push back on hardest is the **BullMQ failure handling**: the `@nestjs/bullmq` worker is `WorkerHost`/`@OnWorkerEvent`, not an ad-hoc "failed handler," and writing `status='failed'` in the failed event without guarding on `attemptsMade` vs `opts.attempts` will mark invoices failed after the first retry rather than after exhaustion. That's the highest-severity correctness issue in the doc.
