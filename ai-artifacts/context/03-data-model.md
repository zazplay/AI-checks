# Data Model, TypeORM Entities & Status Machine

This is the persistence-layer spec for the invoice processing service. It defines the schema, the TypeORM entities, the status state machine, and how `attempts` interacts with BullMQ retries. Implement directly from this.

## Decision summary (read first)

1. **Extracted data lives in a separate `extracted_invoice_data` entity** (1:1 with `Invoice`), **not** a `jsonb` column on `Invoice`. Line items are a `jsonb` array *inside* that entity. Justification below.
2. **Status is a Postgres enum** with a code-enforced transition table. The DB stores the enum; legality is enforced in a service method, not via DB triggers.
3. **Use TypeORM migrations, never `synchronize: true`** — even for this assignment. `synchronize` will silently drop the `extracted` data on a column rename. One generated migration is cheap insurance.
4. **Retry transitions `failed -> processing`** (not `failed -> uploaded`). The retry re-enqueues a BullMQ job directly; there is no separate "re-upload" step. `uploaded` is only ever the initial state.

---

## 1. Why a separate entity, not a `jsonb` column

The choice is between:

- **(A)** `Invoice.extractedData jsonb` — one table, blob column.
- **(B)** `ExtractedInvoiceData` entity, 1:1 FK to `Invoice`, with scalar columns for the queryable fields and `jsonb` only for `lineItems`.

**Pick (B).** Reasons, in priority order:

1. **The extracted fields are queryable business data.** `total`, `vendor`, `invoiceNumber`, `dueDate` are exactly the things the AI assistant will filter and aggregate on ("which invoices over $5k are overdue", "sum of completed invoices this month"). As real `numeric`/`date`/`text` columns they are indexable and you get correct typed comparisons and `SUM`. Inside a `jsonb` blob every value is text-ish, every numeric comparison needs a cast, and you cannot put a normal btree index on `vendor` without an expression index.
2. **Clean nullability and lifecycle separation.** An `Invoice` exists from upload onward with *no* extraction. With (B) the absence of a row is the natural "not extracted yet" signal and every extracted column is `NOT NULL` within its row. With (A) you carry a nullable blob and litter the code with `?.` chains.
3. **Schema is enforced on the structured fields.** `subtotal`, `tax`, `total` are real `numeric(14,2)` — the DB rejects garbage. In a blob, nothing stops a malformed write.

**`lineItems` stays `jsonb`** inside the entity: it is a variable-length, write-once array that is never filtered on individually. Normalizing it into an `invoice_line_item` table buys nothing for this assignment and adds joins. `jsonb` is the right call there.

Net: the queryable scalars are columns (indexable, typed); the one genuinely document-shaped field is `jsonb`. Best of both.

---

## 2. Status enum and state machine

### Enum

```ts
// src/invoices/invoice-status.enum.ts
export enum InvoiceStatus {
  UPLOADED = 'uploaded',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
```

### Legal transitions

```
uploaded   -> processing                 (worker picks up the job)
processing -> completed                  (extraction + structuring succeeded)
processing -> failed                     (attempts exhausted, or fatal error)
failed     -> processing                 (RETRY: re-enqueue)
```

Everything else is illegal, including:
- `completed -> *` (terminal; re-processing a completed invoice is out of scope)
- `failed -> uploaded` (we do not bounce back to the upload state)
- `uploaded -> completed` (must pass through `processing`)
- `processing -> uploaded`

`completed` is terminal. `failed` is terminal *unless* a retry is requested. The retry path goes straight to `processing` because the file is already stored — there is nothing to re-upload.

### Transition table (single source of truth)

```ts
// src/invoices/invoice-status.machine.ts
import { InvoiceStatus } from './invoice-status.enum';

const LEGAL: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.UPLOADED]: [InvoiceStatus.PROCESSING],
  [InvoiceStatus.PROCESSING]: [InvoiceStatus.COMPLETED, InvoiceStatus.FAILED],
  [InvoiceStatus.COMPLETED]: [],
  [InvoiceStatus.FAILED]: [InvoiceStatus.PROCESSING],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return LEGAL[from].includes(to);
}

export class IllegalStatusTransitionError extends Error {
  constructor(from: InvoiceStatus, to: InvoiceStatus) {
    super(`Illegal invoice status transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalStatusTransitionError(from, to);
  }
}
```

Enforce this in **one** place — a `InvoicesService.transitionStatus()` method that loads the row, calls `assertTransition`, writes the new status, and emits the Socket.IO event. No other code path may write `invoice.status` directly. This keeps the machine honest without DB triggers.

---

## 3. TypeORM entities

### Invoice

```ts
// src/invoices/entities/invoice.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { InvoiceStatus } from '../invoice-status.enum';
import { ExtractedInvoiceData } from './extracted-invoice-data.entity';

@Entity('invoices')
@Index('idx_invoices_status_created_at', ['status', 'createdAt'])
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'original_filename', type: 'text' })
  originalFilename: string;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType: string;

  // bigint -> string in JS to avoid precision loss; cast at the edge.
  @Column({ name: 'file_size', type: 'bigint' })
  fileSize: string;

  // Path on disk / object key. Not the bytes.
  @Column({ name: 'storage_path', type: 'text' })
  storagePath: string;

  @Index('idx_invoices_status')
  @Column({
    name: 'status',
    type: 'enum',
    enum: InvoiceStatus,
    default: InvoiceStatus.UPLOADED,
  })
  status: InvoiceStatus;

  // Number of processing attempts made so far (incremented when a run starts).
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  // Ceiling. Once attempts >= maxAttempts and the run fails, status -> failed.
  @Column({ name: 'max_attempts', type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  // BullMQ job id of the most recent enqueue, for traceability / dedupe.
  @Column({ name: 'last_job_id', type: 'text', nullable: true })
  lastJobId: string | null;

  @OneToOne(() => ExtractedInvoiceData, (data) => data.invoice)
  extractedData: ExtractedInvoiceData | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

Notes:
- `fileSize` is `bigint`. TypeORM maps Postgres `bigint` to a JS **string** (a `number` can't hold the full range). Parse with `Number()` only when you know it's small, which for invoice files it always is — but keep the column type honest.
- The composite index `(status, createdAt)` backs the default list query (filter by status, order by newest). The standalone `status` index covers status-only counts the assistant runs. Keep both; the composite is not a substitute for status-only aggregate scans on small-cardinality enums, but at assignment scale either is fine — the composite is the load-bearing one.

### ExtractedInvoiceData

```ts
// src/invoices/entities/extracted-invoice-data.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Invoice } from './invoice.entity';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

@Entity('extracted_invoice_data')
export class ExtractedInvoiceData {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => Invoice, (invoice) => invoice.extractedData, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'invoice_id' })
  invoice: Invoice;

  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId: string;

  @Column({ name: 'vendor', type: 'text', nullable: true })
  vendor: string | null;

  @Column({ name: 'invoice_number', type: 'text', nullable: true })
  invoiceNumber: string | null;

  @Column({ name: 'issue_date', type: 'date', nullable: true })
  issueDate: string | null; // ISO date string; 'date' has no time zone

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  // ISO 4217, e.g. 'USD'. Default applied by the structuring step, not the DB.
  @Column({ name: 'currency', type: 'varchar', length: 3, nullable: true })
  currency: string | null;

  @Column({ name: 'subtotal', type: 'numeric', precision: 14, scale: 2, nullable: true })
  subtotal: string | null;

  @Column({ name: 'tax', type: 'numeric', precision: 14, scale: 2, nullable: true })
  tax: string | null;

  @Column({ name: 'total', type: 'numeric', precision: 14, scale: 2, nullable: true })
  total: string | null;

  @Column({ name: 'line_items', type: 'jsonb', default: () => "'[]'::jsonb" })
  lineItems: LineItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

Notes:
- **`numeric` columns map to `string` in TypeORM**, deliberately — never `float`. Money in IEEE floats is a defect. Keep them as strings end-to-end and format/parse with a decimal library or `Number.parseFloat` only at display time. `precision: 14, scale: 2` handles up to ~999 billion with cents.
- **Extracted scalar fields are `nullable`.** Claude's structured output can legitimately fail to find a `dueDate`. The *row* existing means "extraction ran"; individual nulls mean "this field wasn't present." This is the right granularity — do not make them `NOT NULL`.
- `onDelete: 'CASCADE'` so deleting an invoice cleans up its extraction.
- Unique-by-construction: the FK column is also effectively unique via the 1:1. Add a unique index on `invoice_id` (the migration below does).

---

## 4. Migrations, not `synchronize`

**Set `synchronize: false` everywhere.** Generate and run migrations.

`DataSource` config (`src/data-source.ts`, used by the TypeORM CLI):

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Invoice } from './invoices/entities/invoice.entity';
import { ExtractedInvoiceData } from './invoices/entities/extracted-invoice-data.entity';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [Invoice, ExtractedInvoiceData],
  migrations: ['dist/migrations/*.js'],
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
```

In the Nest module, `TypeOrmModule.forRootAsync` also gets `synchronize: false` and `migrationsRun: true` so migrations apply on boot:

```ts
TypeOrmModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    type: 'postgres',
    url: config.get<string>('DATABASE_URL'),
    entities: [Invoice, ExtractedInvoiceData],
    migrations: ['dist/migrations/*.js'],
    synchronize: false,
    migrationsRun: true,
  }),
  inject: [ConfigService],
})
```

Packages: `typeorm`, `@nestjs/typeorm`, `pg`. Dev: `ts-node`, `typescript`.

CLI scripts in `package.json`:

```json
{
  "scripts": {
    "typeorm": "typeorm-ts-node-commonjs -d src/data-source.ts",
    "migration:generate": "npm run typeorm -- migration:generate src/migrations/Init",
    "migration:run": "npm run typeorm -- migration:run",
    "migration:revert": "npm run typeorm -- migration:revert"
  }
}
```

**Why this matters for an assignment, not just prod:** the grader runs against a fresh DB. `synchronize: true` "works" until a column rename or enum change, at which point it drops and recreates — silently wiping extracted data and giving non-reproducible behavior. A single committed `Init` migration makes `npm run migration:run` deterministic. It costs one command to generate. Do it.

The initial migration must:
1. `CREATE TYPE invoice_status AS ENUM ('uploaded','processing','completed','failed')`.
2. Create both tables.
3. Create indexes: `idx_invoices_status_created_at` on `invoices(status, created_at)`, `idx_invoices_status` on `invoices(status)`, and a **unique** index on `extracted_invoice_data(invoice_id)`.

Generate it with `npm run migration:generate` (build first so the entity metadata is current), then review the SQL — TypeORM's generator gets enums and the composite index right, but eyeball the `jsonb` default and the unique constraint.

---

## 5. attempts / maxAttempts vs BullMQ retries

There are **two** retry counters and they must not be confused.

- **BullMQ's own `attempts`** (job option) — how many times the queue re-runs the *same job* on throwable error, with backoff. This is transient/infra-level.
- **Our `Invoice.attempts` / `maxAttempts`** — the *business* record of how many processing runs this invoice has had, surviving across job re-enqueues and user-initiated retries.

**Configuration decision:** set BullMQ job `attempts: 1` (no automatic queue-level retry) and drive *all* retry logic from our column. This keeps one source of truth and makes the "retry failed invoice" button the only retry path — which is exactly the assignment requirement. Auto-retrying inside BullMQ would make `Invoice.attempts` and the UI lie about how many times we actually tried.

```ts
await invoiceQueue.add(
  'process-invoice',
  { invoiceId },
  {
    jobId: `invoice:${invoiceId}:${attemptNumber}`, // idempotent enqueue
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false, // keep failed jobs for inspection
  },
);
```

### The processing flow, concretely

**On enqueue (upload or retry):**
1. `transitionStatus(invoice, PROCESSING)` (legal from `uploaded` and from `failed`).
2. Add the job; store `lastJobId`.

**In the worker, at the start of a run:**
1. Increment `invoice.attempts` (`UPDATE ... SET attempts = attempts + 1`).
2. Run OCR -> Claude structuring.

**On success:**
1. Upsert the `ExtractedInvoiceData` row.
2. `transitionStatus(invoice, COMPLETED)`, clear `errorMessage`.

**On error:**
1. Set `errorMessage`.
2. Because BullMQ won't retry (`attempts: 1`), `transitionStatus(invoice, FAILED)`.
3. Leave `attempts` as-is (it reflects the run that just failed).

**On user retry (REST `POST /invoices/:id/retry`):**
1. Guard: only allowed when `status === FAILED`. Reject otherwise with 409.
2. Guard: `if (invoice.attempts >= invoice.maxAttempts)` reject with 409 "max attempts reached" — this is the ceiling that prevents infinite manual retries.
3. Otherwise re-enqueue (transition `failed -> processing`, new `jobId` using the next attempt number).

So `maxAttempts` (default 3) is the **business ceiling on total tries**, enforced at the retry endpoint, independent of BullMQ. `attempts` is the running count. The Socket.IO layer emits on every `transitionStatus`, giving the frontend its no-refresh updates for free.

### Why `attempts: 1` and not BullMQ backoff

If you let BullMQ retry with `attempts: 3, backoff`, then a single user-visible "failed" only appears after 3 internal tries, our `Invoice.attempts` either over- or under-counts depending on where you increment, and the retry button becomes redundant with the queue. One counter, one retry path, one truth. For a graded assignment that must *demonstrate* a retry mechanism, explicit beats clever.

---

## Index summary

| Index | Columns | Purpose |
|---|---|---|
| `idx_invoices_status_created_at` | `invoices(status, created_at)` | Default list view: filter by status, sort newest-first |
| `idx_invoices_status` | `invoices(status)` | Status counts / assistant aggregates |
| `uq_extracted_invoice_id` | `extracted_invoice_data(invoice_id)` UNIQUE | Enforce 1:1, fast join |

Primary keys give you the `uuid` lookups for free. No index on `vendor`/`total` for this assignment — add expression/btree indexes only if the assistant's query volume warrants it, which at this scale it does not.

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

## Review: Data model, TypeORM entities, migrations, status machine

Overall this is a strong, internally-consistent spec. The TypeORM decorators, column types (`jsonb`, `enum`, `uuid`, `numeric`→string, `bigint`→string, `timestamptz`), the separate-entity-vs-jsonb decision, and the status machine are all correct and well-justified. Most of what follows is minor; only a couple are real bugs.

- [SEVERITY med] The `@OneToOne` between `Invoice` and `ExtractedInvoiceData` is declared bidirectional with the inverse side (`extractedData`) carrying **no `@JoinColumn`** and the owning side (`ExtractedInvoiceData.invoice`) carrying it — that part is correct — but `Invoice.extractedData` is typed `ExtractedInvoiceData | null` with **no eager/lazy or nullable hint**, and the doc later relies on "absence of a row = not extracted." That works, but note: with a plain `@OneToOne` inverse side, `invoice.extractedData` is `undefined` (not loaded) unless you explicitly `relations: ['extractedData']` or use `eager: true`. The spec never says which, so "litter the code with `?.` chains" (the thing it criticizes option A for) reappears here as "remember to join or get `undefined`." -> Not wrong, but the spec should state `eager: true` on the inverse side or mandate the relation be requested, otherwise reads silently return `undefined` and look like "not extracted."

- [SEVERITY low] `onDelete: 'CASCADE'` is placed in the `@OneToOne(...)` **options object on the owning side**. In TypeORM, `onDelete` belongs on the relation that owns the FK (which this is — it has the `@JoinColumn`), so this is correct. No error here — calling it out only to confirm it's right, since reviewers often flag it wrongly.

- [SEVERITY low] `default: () => "'[]'::jsonb"` for `lineItems` is valid TypeORM (function-form raw SQL default), and pairs correctly with the `jsonb` type. Correct. One subtlety: with a DB-level default, a freshly-`create()`d-but-unsaved entity will have `lineItems === undefined` in JS until reloaded, so code that reads `entity.lineItems.length` right after `create()` (before save/reload) will throw. Worth a one-line caveat, not a bug.

- [SEVERITY low] `fileSize` typed as `string` for `bigint` is correct (TypeORM maps `bigint` to string to avoid precision loss). The justification text is accurate. Fine.

- [SEVERITY low] The composite index `@Index('idx_invoices_status_created_at', ['status', 'createdAt'])` plus a second standalone `@Index('idx_invoices_status')` on `status` is **redundant for most queries** — a btree on `(status, created_at)` already serves `WHERE status = ?` and `WHERE status = ? ORDER BY created_at` via the leading column. The standalone `status` index only helps if you need a smaller index for count-only scans, which at assignment scale is negligible. The doc half-acknowledges this ("either is fine") but still says "keep both," which contradicts its own "the composite is the load-bearing one." -> Drop `idx_invoices_status`; the composite covers status-only predicates via its leading column.

- [SEVERITY low] `currency` is `varchar(3)` nullable with a comment "Default applied by the structuring step, not the DB" — consistent, but note `length: 3` will hard-reject a 4+ char value at the DB (a malformed extraction writing e.g. `"US$"` or `"Dollars"` throws). Given the doc's stance that extracted fields should tolerate Claude returning imperfect data, a `text`/`varchar` without a tight length cap would be more forgiving. Minor design tension, not an error.

- [SEVERITY low] State machine / BullMQ section: setting BullMQ job `attempts: 1` to disable queue-level retry is the correct API (BullMQ's `attempts` option on `queue.add`), and `removeOnComplete`/`removeOnFail` are valid `JobsOptions`. The `jobId` idempotency key is a real BullMQ feature. All correct. One caveat the doc gets *right* and is worth affirming: BullMQ deduplicates on `jobId`, so reusing `invoice:${id}:${attemptNumber}` across a genuine retry requires the attempt number to actually change — which the retry flow does (`next attempt number`). Consistent.

- [SEVERITY low] `transitionStatus()` "loads the row, calls `assertTransition`, writes the new status, and emits the Socket.IO event" — as written this is a read-modify-write with **no concurrency control**. Two concurrent transitions (e.g. worker writing `COMPLETED` while a user retry writes `PROCESSING`) can interleave and bypass the guard. For an assignment it's fine, but the doc presents this method as "the machine honest without DB triggers" — that honesty assumes serialized access. -> Worth one line noting an optimistic lock (`@VersionColumn`) or `UPDATE ... WHERE status = :expected` would make the guard race-safe; as written it's advisory only.

- [SEVERITY low] Migration step says `CREATE TYPE invoice_status AS ENUM (...)` but the entity uses `enum: InvoiceStatus` **without an explicit `enumName`**. TypeORM auto-generates the Postgres enum type name (typically `invoices_status_enum`), which will **not** match the hand-named `invoice_status` in the prose. If someone hand-writes the migration with `invoice_status` but the entity metadata expects `invoices_status_enum`, a later `migration:generate` will produce a spurious diff (drop/recreate). -> Either add `enumName: 'invoice_status'` to the `@Column`, or let the generator name it and drop the hand-specified name in the migration prose. As-is they're inconsistent.

Everything else — the numeric precision/scale reasoning, `timestamptz` for created/updated, `date` columns as ISO strings, the 1:1 unique index on `invoice_id`, `synchronize: false` + `migrationsRun: true`, and the lifecycle `uploaded→processing→completed/failed` with retry to `processing` — is correct and consistent. No wrong Claude model ids, Anthropic tool-use structure, `@nestjs/websockets`, or Multer claims appear in this section (it correctly scopes them out).
