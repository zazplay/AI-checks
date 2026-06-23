# Scalability audit — what happens as the number of invoices (and uploads) grows

**Method.** Two multi-agent workflows over the real source: (1) a race-condition
analysis of the upload→minimize→upload spam flow (12 agents, each claimed bug
adversarially refuted before confirming); (2) a per-operation scalability audit
of every invoice operation (16 agents — one auditor per operation reading the
actual code, then a skeptic re-reading to refute each bottleneck, then a
synthesis). Findings below are the **confirmed** set (refuted claims dropped).

**Status legend:** ✅ FIXED (implemented + runtime-verified) · 📋 BACKLOG (logged
here for later) .

---

## The single root cause

Five of six bottlenecks converge on one method —
[`backend/src/invoices/invoices.service.ts`](../../backend/src/invoices/invoices.service.ts) `findAll()`:

```ts
async findAll(status?) {
  return this.invoices.find({ where: status ? { status } : {}, order: { createdAt: 'DESC' } });
  // SELECT * FROM invoices — no skip/take, no WHERE beyond status, no LIMIT
}
```

The systemic anti-pattern is **materialize-then-process**: the whole table is
loaded into Node as JS objects, then `.filter()/.sort()/.slice(limit)` run in
JavaScript. The limit is applied **last**, so it saves neither memory nor time.
Indexes are absent on the JSONB-extracted fields that filters/search hit.

---

## ✅ FIXED in this pass

### #1 (critical) — `filterInvoices` / `queryByAmount` / `findEmpty` / `queryForExport`: filtering pushed into SQL

**Was:** all called `findAll()` then filtered/sorted/sliced in JS. At N=100k this
loads ~1.2 GB into memory; filter+sort takes 30–50 s (exceeds the 30–120 s
platform HTTP timeout → 504); at N=1M the process OOMs before responding.
`filterInvoices` was worst due to a nested `lineItems.some()` (O(N×M) per row).

**Now:** each method builds a TypeORM `QueryBuilder` that applies every predicate
as SQL `WHERE` (status, vendor `ILIKE`, amount range, currency exact, issue/due
dates, overdue, empty, hasProblem, line-item via `EXISTS jsonb_array_elements`,
free-text search) and sorts in SQL with a regex-guarded `CASE … ::numeric`
(NULLS LAST) so a malformed total never throws. A hard `MAX_FINDER_ROWS = 1000`
cap is applied as `.limit()` in SQL (via a `cap()` clamp) — the result set can
never be unbounded. Export is capped too (with a `logger.warn` if it truncates,
so a huge export isn't silently partial).

**Runtime-verified** against the live app (14 invoices, varied
vendor/total/currency + 1 failed/empty), each filter cross-checked against
ground truth computed independently from the full JSON:

| Filter (real HTTP) | Result | Ground truth |
|---|---|---|
| export all | 14 | 14 ✅ |
| `vendor=Aurora` (ILIKE) | 4 | 4 ✅ |
| `minTotal=2000` | 5 | 5 ✅ |
| `minTotal=2000&maxTotal=3000` | 4 | 4 ✅ |
| `search=Nordwind` | 1 | 1 ✅ |
| `status=failed` | 1 | 1 ✅ |
| assistant "3 most expensive" (amount_desc + limit) | 9749.41 > 2648.93 > 2438.11 | correct order ✅ |
| assistant "empty / no data" (`findEmpty`) | 1 | 1 ✅ |
| assistant "EUR only" (currency exact) | 7 | 7 ✅ |
| assistant "line item mentions thermal" (`EXISTS`) | 5 | 5 ✅ |

### #2 (critical) — Upload backpressure: client concurrency cap + server 429

**Was:** the dropzone fired `Promise.all` over **all** dropped files at once (no
cap), saturating the browser's ~6-socket pool and the backend DB/queue in one
burst. Each upload enqueued a BullMQ job with **no queue-depth check** — a 100k
drop enqueues 100k jobs the worker (concurrency 2, 8/min) can't drain for days.

**Now:**
- Client ([`frontend/src/hooks/useBatchUpload.ts`](../../frontend/src/hooks/useBatchUpload.ts)):
  a bounded worker-pool of `MAX_CONCURRENT_UPLOADS = 4` (shared cursor hands the
  next file to whichever worker is free) replaces the unbounded `Promise.all`.
- Server ([`backend/src/invoices/invoices.service.ts`](../../backend/src/invoices/invoices.service.ts)
  `assertQueueHasRoom`): before saving the file, sum waiting+delayed+active jobs;
  if ≥ `QUEUE_BACKPRESSURE_LIMIT` (default 5000, env-overridable) throw **429**.
  Fail-open: if the count check itself errors (Redis blip) the upload is allowed.

**Runtime-verified:**
- Spam recovery: 6 concurrent uploads → all `201`, drained from
  `uploaded:2,processing:2` to `completed:19,failed:1` in ~24 s, nothing stuck.
- 429 path: a throwaway backend with `QUEUE_BACKPRESSURE_LIMIT=1` rejected all 8
  uploads in a burst with `429` once ≥1 job was pending.

---

## 📋 BACKLOG — confirmed, not yet fixed

### #3 (high) — Main list `GET /invoices` → `useInvoices` → `AllInvoicesTable` renders everything

- **Mechanism:** `findAll()` returns all rows; `api.listInvoices` returns the full
  array; React-Query caches it whole; `AllInvoicesTable` does `rows.map()` over
  every row (no pagination, no virtualization). Filter/sort run client-side over
  the full array.
- **Breaking point:** N=10k → 14 MB payload, 120k DOM nodes, 200–500 ms
  main-thread blocks (practical UX ceiling). N=100k → ~143 MB cache, 1.2M DOM
  nodes, 2–5 s freezes. N=1M → browser crash.
- **Fix:** DB pagination end-to-end — `findAll(skip, take)`, controller parses
  `?page=&limit=`, `useInvoices` stores page metadata; composite index
  `(status, createdAt DESC)`; `React.memo` rows + `react-window` virtualization if
  long lists are kept.
- **Note:** the real-time socket path (`upsertInvoice` cache mutation, **scales OK**
  on its own) inherits this — each upsert re-renders the table, which re-sorts all
  N rows. So #3's fix also de-risks live updates at scale.

### #4 (high) — `search_invoices`: 3 unindexed `ILIKE '%q%'` via OR over filename + JSONB

- **Mechanism:** wildcard-both-sides `ILIKE` defeats B-tree/GIN; `->>'…'` JSON
  extraction per row; no narrowing `WHERE` → O(N) full table scan with regex per
  row. `.limit(50)` caps output but not the scan, and hides results past 50.
- **Breaking point:** 50k → 100–300 ms; 100k → 0.5–2 s, concurrent searches starve
  the pool; 1M → 5–30 s, silent timeout.
- **Fix:** `pg_trgm` GIN index on `originalFilename`; move `vendorName` /
  `invoiceNumber` to native columns (or FTS) and index them; split the OR into
  three indexed queries merged in memory; pagination + "more available" flag;
  a >2 s query circuit-breaker.

### #5 (high) — Assistant finder tools feed the LLM without a hard cap → silent **correctness** risk

- **Mechanism:** `filter_invoices` / `get_dataset` (and the old in-memory finders)
  could serialize a huge matched set into the LLM context. The SDK then **silently
  truncates** to the context window. The model sees a partial set but the summary
  says "Matched 100k". The user asks "delete all completed" → the assistant acts on
  the first ~1000 ids and reports "Done", leaving the rest — **silent data
  loss**, worse than a hang.
- **Partially mitigated by #1:** the finder service methods are now SQL-capped at
  `MAX_FINDER_ROWS = 1000`, so the payload to the model is bounded. **Still
  missing:** an explicit *truncation flag* in the tool summary so the model knows
  the set was capped and tells the user "showing the first 1000 — refine filters",
  instead of implying completeness. Add that to every finder's summary when
  `rows.length === cap`.

### #6 (high) — `delete_invoices`: sequential `for (id) await remove(id)` loop

- **Mechanism:** each `remove` = 1 DB delete + 1 R2 object delete (network
  round-trip), run one at a time; the HTTP confirm request blocks until done.
- **Breaking point:** ~200 ms/invoice (R2 dominates) → 500–600 deletes hit the
  120 s timeout, leaving a partial delete. A 100k-UUID token also exceeds the
  ~100 KB body limit (413).
- **Fix:** return `202 Accepted` + async BullMQ job; parallelize DB deletes and
  chunk R2 deletes (e.g. pLimit 10); progress via Socket.IO (as
  `retryFailedThenCleanup` already does); reject `ids` arrays over ~5000 in the DTO.

---

## 📋 BACKLOG — upload-spam UI race conditions (from workflow #1)

All three share one root: `useBatchUpload.start()` does `setRows(batch)` —
**replaces** the rows array instead of appending.

1. **(med) Second multi-file batch opens stuck in the corner pill.** `collapsed`
   resets only when `opened` (`rows.length > 1`) goes false; replacing rows keeps
   length > 1, so `opened` never flips and the new batch stays minimized in the
   corner instead of re-expanding.
   *Fix:* reset `collapsed` on a new-batch signal (e.g. `rows[0]?.key`), not on
   `opened`.
2. **(med) First batch's still-uploading rows vanish.** Dropping batch 2 mid-flight
   replaces batch 1's rows; their in-flight `patch(key)` calls become no-ops, so
   batch 1 disappears from the modal — but the requests aren't cancelled.
3. **(med) Orphaned-from-UI but server-persisted.** Consequence of #2: batch 1
   still uploads and lands in the list/cache, but the user never sees it finish and
   thinks it was cancelled.

**Answers a user question** ("can I see a combined queue of both sessions in the
top-left corner, or does it say wait for the current session?"): today the corner
pill shows **only the latest session**, there is **no "please wait" message**, and
the previous session is silently dropped from view. The intended behavior (a single
growing queue across sessions) is exactly the append fix:

```ts
// useBatchUpload.ts — append instead of replace
setRows((prev) => [...prev, ...batch]);
```

…paired with resetting `collapsed` on a new-batch signal and clearing settled rows
on dismiss. Alternative (if one-batch-at-a-time is the product intent): guard
`start()` to ignore/queue a new drop while `active`, and show a "finish current
uploads first" notice.

---

## Prioritized remediation plan

**Phase 0 — emergency guards (hours; mostly DONE):**
- ✅ Hard SQL `.limit(MAX_FINDER_ROWS)` on finder paths (kills OOM for #1/#3/#5).
- 📋 Truncation flag in finder tool summaries (closes the #5 silent-delete risk).
- 📋 `ids` array-size validation in `delete_invoices` (caps #6 blast radius).

**Phase 1 — fix the root (highest leverage):**
- ✅ Rewrite `findAll`-path filters to QueryBuilder (`WHERE`/`limit` in SQL). *(done
  for filter/amount/empty/export; the plain `findAll()` used by `GET /invoices`
  still needs `skip/take` — that's #3.)*
- 📋 Server-side pagination end-to-end for `GET /invoices` (#3).

**Phase 2 — indexes & search (cheap after Phase 1):** composite `(status, createdAt)`,
`pg_trgm` GIN on filename, GIN on JSONB vendor/number; server-side search (#4).

**Phase 3 — throughput & background (write paths):**
- ✅ Upload backpressure: client cap 4 + server 429 (#2). *(DB pool size bump to ~20
  still pending.)*
- 📋 Async bulk delete via BullMQ + chunked R2 deletes (#6).

**Phase 4 — UI virtualization (last):** `React.memo` rows + `react-window` (#3 tail).

**Plus:** the upload-spam append fix (3 UI races above) — small, independent.

---

## Key files

- [`backend/src/invoices/invoices.service.ts`](../../backend/src/invoices/invoices.service.ts) — `findAll` (root), `filterInvoices`/`queryByAmount`/`findEmpty`/`queryForExport` (✅ SQL), `assertQueueHasRoom` (✅ 429), `remove` (#6).
- [`backend/src/processing/processing.constants.ts`](../../backend/src/processing/processing.constants.ts) — `QUEUE_BACKPRESSURE_LIMIT`, worker concurrency/rate.
- [`frontend/src/hooks/useBatchUpload.ts`](../../frontend/src/hooks/useBatchUpload.ts) — `MAX_CONCURRENT_UPLOADS` pool (✅), `setRows` replace (spam races).
- [`frontend/src/hooks/useInvoices.ts`](../../frontend/src/hooks/useInvoices.ts) + [`frontend/src/components/invoices/AllInvoicesTable.tsx`](../../frontend/src/components/invoices/AllInvoicesTable.tsx) — full-list fetch/render (#3).
- [`backend/src/assistant/assistant.service.ts`](../../backend/src/assistant/assistant.service.ts) — finder tool truncation flag (#5), sequential delete loop (#6).
