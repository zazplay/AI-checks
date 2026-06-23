# Async Processing — BullMQ + Redis

> Area owner spec. Covers the full invoice processing pipeline: queue/worker wiring inside NestJS, the OCR → Claude structuring processor, status transitions persisted to Postgres at every step, retry/backoff and how it maps to the user-facing "retry" button, idempotency, concurrency, and failure handling. Implement directly from this.

## 1. Decision: `@nestjs/bullmq`, not raw `bullmq`

Use **`@nestjs/bullmq`** (the official Nest wrapper around BullMQ v5). It is the right call here and not a survey question:

- DI-native. The processor is a Nest provider, so it injects `InvoiceRepository`, the OCR service, the Claude service, and the WebSocket gateway through the constructor. With raw `bullmq` you build a `new Worker()` outside the Nest container and hand-wire every dependency.
- Lifecycle is managed. `BullModule` registers the queue, the worker boots when the Nest app boots, and workers drain/close on `app.close()` via `OnModuleDestroy` internally. No manual `worker.close()` in a shutdown hook.
- `@Processor()` / `@OnWorkerEvent()` decorators give a clean processor class and typed event hooks.

It does **not** hide BullMQ — you still pass native `BullMQ` job options (`attempts`, `backoff`, `removeOnComplete`) and the underlying `Queue`/`Worker`/`Job` objects are the real BullMQ ones. You lose nothing.

Exact packages:

```
npm i @nestjs/bullmq bullmq ioredis
```

`bullmq` pulls its own `ioredis`; we add `ioredis` explicitly because we share one connection config across the queue, the worker, and (later) the Socket.IO Redis adapter.

## 2. Queue registration

One queue: `invoice-processing`. One job type on it: `process` (one invoice = one job). Centralize the name as a const so the producer and consumer can't drift.

```ts
// src/queue/queue.constants.ts
export const INVOICE_QUEUE = 'invoice-processing';
export const INVOICE_JOB = 'process';

export interface ProcessInvoiceJobData {
  invoiceId: string; // UUID PK in Postgres — the ONLY thing we put on the job
}
```

Register the Redis connection once at the root and the queue in the feature module.

```ts
// src/app.module.ts (additions)
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', '127.0.0.1'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          // BullMQ REQUIRES this on the connection used by workers:
          maxRetriesPerRequest: null,
        },
      }),
    }),
    InvoicesModule,
  ],
})
export class AppModule {}
```

`maxRetriesPerRequest: null` is mandatory — BullMQ blocks on `BRPOPLPUSH` and ioredis will throw `"maxRetriesPerRequest must be null"` on worker start otherwise. This is the single most common BullMQ-on-Nest boot failure; bake it in.

```ts
// src/invoices/invoices.module.ts
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { INVOICE_QUEUE } from '../queue/queue.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Invoice]),
    BullModule.registerQueue({
      name: INVOICE_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: false, // keep failed jobs for inspection + retry
      },
    }),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceProcessor, OcrService, ClaudeExtractionService],
})
export class InvoicesModule {}
```

`defaultJobOptions` is where retry policy lives (section 6). `removeOnFail: false` keeps the failed BullMQ job around — but note our retry button does **not** depend on it (section 7).

## 3. Status model — Postgres is the source of truth, Redis is not

The invoice lifecycle (`uploaded → processing → completed / failed`) lives in **Postgres**, not in BullMQ job state. The queue is transport; the database is truth. The UI, the AI assistant, and retries all read Postgres. This separation is deliberate: BullMQ trims completed jobs, and a user can ask "what's the status of invoice X" long after the job is gone.

```ts
// src/invoices/invoice.entity.ts
export enum InvoiceStatus {
  UPLOADED = 'uploaded',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() originalFilename: string;
  @Column() storagePath: string;       // where the uploaded PDF/image lives
  @Column() mimeType: string;

  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.UPLOADED })
  status: InvoiceStatus;

  @Column({ type: 'jsonb', nullable: true })
  extractedData: ExtractedInvoice | null;   // populated on completion

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;              // populated on failure

  @Column({ type: 'int', default: 0 })
  attempts: number;                          // bumped each processing attempt

  @VersionColumn() version: number;          // optimistic-lock guard (section 8)

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
```

Status writes happen at exactly these transition points, each as its own DB write:

| When | status | other fields written |
|---|---|---|
| Upload handler, before enqueue | `uploaded` | row created |
| Processor start | `processing` | `attempts++`, `errorMessage = null` |
| Claude returns structured JSON | `completed` | `extractedData = {...}` |
| Job exhausts retries / hard error | `failed` | `errorMessage = <reason>` |

## 4. The enqueue call (upload handler)

The HTTP request does the minimum: persist the file, create the row as `uploaded`, enqueue, return `202`. **The row is committed before the job is added** — never enqueue an ID that doesn't exist yet, or the worker can dequeue and 404 on its own invoice.

```ts
// src/invoices/invoices.service.ts
@Injectable()
export class InvoicesService {
  constructor(
    @InjectRepository(Invoice) private readonly repo: Repository<Invoice>,
    @InjectQueue(INVOICE_QUEUE) private readonly queue: Queue<ProcessInvoiceJobData>,
  ) {}

  async createAndEnqueue(file: Express.Multer.File): Promise<Invoice> {
    const invoice = await this.repo.save(
      this.repo.create({
        originalFilename: file.originalname,
        storagePath: file.path,
        mimeType: file.mimetype,
        status: InvoiceStatus.UPLOADED,
      }),
    ); // committed first

    await this.queue.add(
      INVOICE_JOB,
      { invoiceId: invoice.id },
      { jobId: invoice.id }, // idempotency key — see section 8
    );

    return invoice; // controller returns 202 + this row
  }
}
```

```ts
// src/invoices/invoices.controller.ts
@Post()
@UseInterceptors(FileInterceptor('file', { /* dest, fileFilter pdf|png|jpg, limits */ }))
@HttpCode(202)
async upload(@UploadedFile() file: Express.Multer.File) {
  if (!file) throw new BadRequestException('file is required');
  return this.invoices.createAndEnqueue(file);
}
```

Only the `invoiceId` goes on the job. Do not put the file bytes or extracted data on the job payload — Redis is not your blob store, and a fat payload bloats memory and serialization. The worker re-reads everything it needs from Postgres + disk by ID.

## 5. The processor: OCR → Claude → persist

The processor is a Nest provider decorated with `@Processor`. `concurrency` is set here (section 9). Each step writes status to Postgres before/after, and emits a WebSocket event so the frontend updates with no refresh.

```ts
// src/invoices/invoice.processor.ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor(INVOICE_QUEUE, { concurrency: 4 })
export class InvoiceProcessor extends WorkerHost {
  private readonly log = new Logger(InvoiceProcessor.name);

  constructor(
    @InjectRepository(Invoice) private readonly repo: Repository<Invoice>,
    private readonly ocr: OcrService,
    private readonly claude: ClaudeExtractionService,
    private readonly events: InvoiceEventsGateway, // Socket.IO gateway
  ) {
    super();
  }

  async process(job: Job<ProcessInvoiceJobData>): Promise<void> {
    const { invoiceId } = job.data;
    const invoice = await this.repo.findOneBy({ id: invoiceId });

    // Idempotency: if a prior attempt already finished, do nothing.
    if (!invoice) {
      this.log.warn(`invoice ${invoiceId} gone; dropping job`);
      return;
    }
    if (invoice.status === InvoiceStatus.COMPLETED) {
      this.log.warn(`invoice ${invoiceId} already completed; skipping`);
      return;
    }

    // 1. -> processing
    await this.transition(invoice, InvoiceStatus.PROCESSING, {
      attempts: invoice.attempts + 1,
      errorMessage: null,
    });

    // 2. OCR / text extraction
    const text = await this.ocr.extract(invoice.storagePath, invoice.mimeType);
    if (!text?.trim()) {
      // Permanent input problem — don't waste retries (section 6).
      throw new UnrecoverableError('OCR produced no text from document');
    }

    // 3. Claude structures the raw text into JSON via tool use
    const extracted = await this.claude.structure(text);

    // 4. -> completed
    await this.transition(invoice, InvoiceStatus.COMPLETED, {
      extractedData: extracted,
      errorMessage: null,
    });
  }

  /** Single helper that persists the new status then emits over WS. */
  private async transition(
    invoice: Invoice,
    status: InvoiceStatus,
    patch: Partial<Invoice> = {},
  ) {
    await this.repo.update(invoice.id, { status, ...patch });
    Object.assign(invoice, { status, ...patch });
    this.events.emitStatus(invoice); // frontend updates live
  }

  /**
   * Fires only after BullMQ has exhausted all `attempts`. This is the ONE
   * place that sets status=failed + errorMessage.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessInvoiceJobData>, err: Error) {
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      return; // a retry is still pending — stay 'processing'
    }
    const id = job.data.invoiceId;
    await this.repo.update(id, {
      status: InvoiceStatus.FAILED,
      errorMessage: err.message?.slice(0, 1000) ?? 'processing failed',
    });
    const invoice = await this.repo.findOneBy({ id });
    if (invoice) this.events.emitStatus(invoice);
  }
}
```

Key decisions in this processor:

- **`process()` throwing is the failure signal.** Any thrown error tells BullMQ the attempt failed; BullMQ decides whether to retry based on `attempts`/`backoff`. We do **not** catch-and-set-failed inside `process()` — that would defeat retries by marking the invoice failed on the very first transient blip.
- **`status=failed` is set exactly once, in `onFailed`, and only when retries are exhausted.** While retries remain pending, the invoice stays `processing` — which is the truthful state, since a retry is queued.
- The OCR service uses `pdf-parse` for text-PDFs and falls back to `tesseract.js` for images/scanned PDFs. That selection logic lives in `OcrService`; the processor doesn't care.
- `ClaudeExtractionService.structure()` calls the Anthropic SDK with tool use / structured output to coerce raw OCR text into the `ExtractedInvoice` shape (vendor, invoice number, line items, totals). That's a separate area; here it's a typed dependency. **Recommended model: `claude-sonnet-4-6`** for this extraction step — it is the cost/quality sweet spot for structured extraction from already-OCR'd text. `claude-haiku-4-5` (`claude-haiku-4-5`) is the cheaper fallback if extraction volume is high and the documents are simple; it trades some accuracy on messy multi-column invoices. Reserve `claude-opus-4-8` only if Sonnet's extraction accuracy proves insufficient on real documents.

## 6. Retry & backoff config — automatic retries

Set on the queue's `defaultJobOptions` (section 2), overridable per `add()`:

```ts
{
  attempts: 3,                                  // 1 initial + 2 retries
  backoff: { type: 'exponential', delay: 5_000 }, // 5s, 10s, 20s
}
```

`exponential` with `delay: 5000` means retry #1 waits 5s, #2 waits 10s, #3 waits 20s. This rides out transient failures that dominate this pipeline: Anthropic 429/529/5xx, a momentary OCR worker hiccup, a brief DB blip. The Anthropic SDK *also* retries 429/5xx internally with its own backoff — so a single BullMQ attempt already absorbs short rate-limit bursts, and a BullMQ retry only triggers on harder failures.

**Not everything should be retried.** A document OCR can't read, or text Claude flatly rejects as non-invoice, will fail identically on every attempt — burning three attempts and ~35s of backoff for nothing. Throw BullMQ's `UnrecoverableError` for these:

```ts
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('OCR produced no text from document');
```

`UnrecoverableError` skips remaining attempts and goes straight to `failed`. Use it for permanent input defects; let ordinary `Error` (network, timeout, 5xx) flow through the retry policy.

## 7. Automatic retries vs. the user-triggered retry button — the core distinction

These are **two different mechanisms** and conflating them is the trap:

**Automatic retries (BullMQ `attempts`/`backoff`).** Internal to a single job's lifecycle. The user never sees them. The invoice stays `processing` across all internal attempts. Only after the final attempt fails does the invoice become `failed`. This is for *transient* faults and is fully handled by config — no code beyond the `onFailed` guard.

**User-triggered retry (the button).** A brand-new operation on an invoice that is already in terminal `failed` state and whose original BullMQ job has long since completed-as-failed (and may be trimmed). The user is saying "try this one again." This is **not** `job.retry()`.

**Decision: the retry endpoint re-enqueues a fresh job; it does not call `job.retry()`.**

Why not `job.retry()`:
- The original job may be evicted (and even with `removeOnFail: false`, depending on retention, it can be gone). `job.retry()` on a missing job throws.
- It couples the user action to BullMQ's internal job object, which we deliberately keep out of the controller layer. The controller knows about *invoices*, not *jobs*.
- Re-enqueueing gives the new attempt the current `defaultJobOptions` (fresh `attempts` budget) and a clean status trail, instead of resurrecting a job whose `attemptsMade` is already maxed.

The implementation re-adds a job for the same `invoiceId`. The `jobId: invoiceId` idempotency key blocks a *concurrent* duplicate but would also block a *legitimate* re-run, since BullMQ refuses to add a job whose `jobId` already exists. So the retry path first removes any stale job by that id, then re-adds:

```ts
// src/invoices/invoices.service.ts
async retry(invoiceId: string): Promise<Invoice> {
  const invoice = await this.repo.findOneBy({ id: invoiceId });
  if (!invoice) throw new NotFoundException();
  if (invoice.status !== InvoiceStatus.FAILED) {
    // Only failed invoices are retryable — guards against double-clicks
    // on a processing/completed row.
    throw new ConflictException(`cannot retry invoice in '${invoice.status}'`);
  }

  // Reset to a clean pre-processing state.
  await this.repo.update(invoiceId, {
    status: InvoiceStatus.UPLOADED,
    errorMessage: null,
  });

  // Clear any leftover job under this id, then enqueue fresh.
  const existing = await this.queue.getJob(invoiceId);
  if (existing) await existing.remove();

  await this.queue.add(INVOICE_JOB, { invoiceId }, { jobId: invoiceId });

  const updated = await this.repo.findOneBy({ id: invoiceId });
  this.events.emitStatus(updated!);
  return updated!;
}
```

```ts
// src/invoices/invoices.controller.ts
@Post(':id/retry')
@HttpCode(202)
retry(@Param('id', ParseUUIDPipe) id: string) {
  return this.invoices.retry(id);
}
```

The AI assistant's "retry a failed invoice" action calls this exact same `InvoicesService.retry()` — one code path for the button and the assistant, so behavior can't diverge.

## 8. Idempotency

Two layers protect against duplicate processing:

1. **Stable `jobId = invoiceId`.** Calling `queue.add(..., { jobId: invoice.id })` makes the enqueue idempotent: a double-submitted upload (network retry, double-click) produces one job, not two, because BullMQ dedupes by `jobId`. One invoice ↔ at most one in-flight job.

2. **State check at the top of `process()`.** Before doing any work the processor short-circuits if the invoice is already `completed` or gone. This covers the at-least-once delivery reality: if a worker crashes *after* writing `completed` but *before* BullMQ marks the job done, the job is redelivered — and the guard makes redelivery a no-op instead of a second (billable) Claude call.

The `@VersionColumn` on the entity adds optimistic locking so two workers (or a worker and a retry) can't silently clobber each other's status write; a stale write throws and the loser is discarded.

## 9. Concurrency

`concurrency` is set in the `@Processor` decorator: `@Processor(INVOICE_QUEUE, { concurrency: 4 })`. This means **one worker process handles up to 4 invoices in parallel**.

Sizing rationale: the pipeline is I/O-bound (OCR can be CPU-heavy for Tesseract, but the Claude call is pure wait). 4 keeps a few invoices moving without (a) saturating the Anthropic rate limit or (b) pinning CPU if multiple Tesseract OCRs land at once. If Tesseract CPU becomes the bottleneck, drop to 2 and scale out by running **more worker instances** (each its own Nest process, same queue) rather than cranking single-process concurrency — BullMQ distributes jobs across all workers on the queue. That horizontal path is the production answer; `concurrency: 4` in one process is the right default for this assignment.

Throughput cap = `concurrency × worker_instances`. Postgres connection pool must be ≥ that, or workers block on connections.

## 10. Failure-handling summary — what sets `status=failed` + `errorMessage`

Single rule: **`status=failed` is written in exactly one place — the `@OnWorkerEvent('failed')` handler, and only once BullMQ has exhausted `attempts` (or an `UnrecoverableError` collapsed them).** `errorMessage` is the final error's message, truncated. Everything else — transient retries, the `processing` window — leaves status untouched so the row tells the truth about what's actually happening. The user clears a `failed` invoice via the retry endpoint (section 7), which resets it to `uploaded` and re-enqueues a fresh job.

## 11. Local run without Docker (user has no Docker)

The queue needs a running Redis. The user has no Docker, so the run instructions must offer a native path:

- **Redis:** native install (`redis-server` from the OS package manager / Homebrew / Memurai on Windows) listening on `127.0.0.1:6379`. Set `REDIS_HOST`/`REDIS_PORT` in `.env`.
- **Postgres:** native Postgres 16 with a `invoices` database; set the TypeORM connection env vars.
- The `docker-compose.yml` (postgres + redis) remains for users who *do* have Docker, but the backend reads connection details from env, so nothing is Docker-coupled. If the user has neither service available, that's the documented gap: the backend boots but the queue can't connect and processing won't run until a Redis is provided.

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

## Review: "Async Processing with BullMQ + Redis"

Overall this is a strong, internally-consistent spec. The BullMQ/`@nestjs/bullmq` API, TypeORM decorators, and Multer/Nest upload usage are essentially all correct. The errors that exist are concentrated in two places: the Claude model recommendation and a couple of BullMQ behavioral claims.

### Claude model IDs / Anthropic SDK
- [SEVERITY high] The doc writes the Haiku model id as `claude-haiku-4-5` in the recommendation prose, but the redundant parenthetical `` `claude-haiku-4-5` (`claude-haiku-4-5`) `` is just a duplicated token (looks like a copy-paste stub, not a real alias). The canonical alias is `claude-haiku-4-5`; the full id is `claude-haiku-4-5-20251001`. -> Drop the duplicate parenthetical; if showing the dated id, use `claude-haiku-4-5-20251001`, not a repeat of the alias.
- [SEVERITY low] Model ids `claude-sonnet-4-6` and `claude-opus-4-8` are correct as written, and recommending Sonnet 4.6 for cost-sensitive structured extraction with Haiku 4.5 as the cheaper fallback is sound and matches the brief. No correction needed — this section is accurate.
- [SEVERITY low] The doc says Claude "structures the raw text into JSON via tool use / structured output" — fine as a one-liner, but note the modern canonical path is `output_config.format` (structured outputs) or strict tool use; the deprecated top-level `output_format` param should not be used. Not an error in the doc (it doesn't name a param), just flagging since the sibling "Claude extraction" area must get this right. The actual tool-use wire structure (assistant `tool_use` blocks with `id`/`name`/`input`; user-turn `tool_result` blocks keyed by `tool_use_id`) is not described here, so nothing to correct.

### BullMQ / `@nestjs/bullmq` API
- [SEVERITY high] In `onFailed`, the retry-exhaustion guard is `job.attemptsMade < (job.opts.attempts ?? 1)`. With BullMQ, the `'failed'` event fires on every failed attempt, and by the time the handler runs for the final attempt, `attemptsMade` has already been incremented to equal `attempts` — but for a job killed by `UnrecoverableError`, `attemptsMade` is whatever it was (e.g. 1) and will be **less than** `attempts` (3), so this guard returns early and **never sets `status=failed`** for unrecoverable errors. -> The guard must also treat `job.finishedOn`/no-more-retries as terminal. Idiomatically: check `if (job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError)`. As written, Section 6's `UnrecoverableError` path ("goes straight to `failed`") contradicts Section 5's `onFailed` guard — the invoice would be left stuck in `processing`. This is an internal inconsistency, not just an API nit.
- [SEVERITY med] The claim that `jobId: invoiceId` makes a re-add idempotent and that "BullMQ refuses to add a job whose `jobId` already exists" (Section 7/8) is imprecise. BullMQ does **not** throw on a duplicate `jobId`; it silently ignores the add and returns the existing job (the add is a no-op). The doc's Section 7 retry code correctly removes the stale job first, so the implementation is fine — but the stated rationale ("BullMQ refuses to add… throws") is wrong about the mechanism. -> Correct the description: a duplicate `jobId` add is silently deduplicated (returns the existing job), it does not raise. Also note that once a job has completed/failed and been retained, re-adding the same `jobId` is rejected/ignored until that job is removed — which is exactly why the explicit `getJob`+`remove` in Section 7 is needed.
- [SEVERITY low] `@OnWorkerEvent('failed')` handler signature is `(job, err, prev?)` — the doc uses `(job, err)`, which is fine. `WorkerHost` + `@Processor(QUEUE, { concurrency })` + `process(job)` is the correct `@nestjs/bullmq` v5 API. `@InjectQueue`, `BullModule.forRootAsync`, `registerQueue`, and `defaultJobOptions` are all correct.
- [SEVERITY low] `maxRetriesPerRequest: null` is correctly described as mandatory for the worker connection; the exact thrown message wording ("maxRetriesPerRequest must be null") is paraphrased but the requirement is real. Accurate enough — no correction needed.

### TypeORM decorators / column types
- [SEVERITY low] `@PrimaryGeneratedColumn('uuid')`, `@Column({ type: 'enum', enum: InvoiceStatus, default: ... })`, `@Column({ type: 'jsonb', nullable: true })`, `@VersionColumn`, `@CreateDateColumn`/`@UpdateDateColumn` are all correct for Postgres. The enum column will create a Postgres enum type — valid. No corrections. This section is solid.
- [SEVERITY low] `@VersionColumn` provides optimistic locking, but note it only enforces the check on `repository.save(entity)` of a loaded entity — **not** on `repository.update(id, {...})`, which is what the `transition()` helper and `onFailed` actually call. So the "optimistic-lock guard" (Section 8) does not actually protect the writes the processor performs (they go through `repo.update`, which issues an unconditional `UPDATE` and bypasses version checking). -> Either persist via `save()` of a loaded entity to get the version guard, or drop the claim that `@VersionColumn` protects these specific writes. This is an internal inconsistency between the entity design and the write path.

### Multer / NestJS upload
- [SEVERITY low] `@UseInterceptors(FileInterceptor('file', {...}))` + `@UploadedFile() file: Express.Multer.File` + `@Post` + `@HttpCode(202)` is all correct standard `@nestjs/platform-express` usage. `file.path` exists only when using disk storage (the doc implies `dest` in the interceptor options, so `storagePath: file.path` is consistent). No correction.

### Other
- [SEVERITY low] `@Processor(INVOICE_QUEUE, { concurrency: 4 })` meaning "one worker process handles up to 4 jobs in parallel" is correct for BullMQ. The horizontal-scaling description (more worker instances on the same queue, BullMQ distributes) is accurate.
- [SEVERITY low] Note the doc's own preamble claims grounding "empty `invoices/` module dir" — the repo confirms `invoice-system/backend/src/invoices/` exists with only a `.gitkeep`, and `@nestjs/config` is present, but **`@nestjs/bullmq`, `bullmq`, `ioredis`, `@nestjs/typeorm`, `typeorm`, `pg`, and `@anthropic-ai/sdk` are NOT yet in `package.json`** (only `@nestjs/common/core/config/platform-express` are). Not a factual error in the spec, but the "Exact packages" list is incomplete relative to what the spec actually uses — implementers will also need `@nestjs/typeorm typeorm pg`, the WebSocket packages, and `@anthropic-ai/sdk`.

Relevant files inspected: `c:\Users\Viktor\Documents\GitHub\Kosher\assignment-zazplay-8uglrU2K\invoice-system\backend\package.json`, `c:\Users\Viktor\Documents\GitHub\Kosher\assignment-zazplay-8uglrU2K\invoice-system\backend\src\invoices\.gitkeep`.
