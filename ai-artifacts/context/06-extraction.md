# Invoice Data Extraction — Multi-engine vision cascade (as built)

> **Updated to match the shipped code.** The original plan here was
> OCR (`pdf-parse`/`tesseract.js`) → Claude-from-text. The system actually built
> reads the document **directly with a vision model** and runs a **fallback
> cascade** across engines. `tesseract.js` was dropped; `pdf-parse` survives only
> as a last-resort text fallback. This doc describes the real
> `backend/src/processing/extraction.service.ts`.

## What it does

A BullMQ worker hands each uploaded PDF/image to `ExtractionService.extract()`,
which returns a strict `ExtractedInvoice` plus a per-attempt `processingLog`, or
throws (the worker then marks the invoice `failed` with a user-facing message).

Lifecycle: `uploaded → processing → completed | failed`, retry/reprocess
re-enqueues the same job.

## Design decisions

1. **Vision, not OCR.** The file bytes are sent **directly to a vision model**
   (Claude or Gemini), which reads scans, photos, and multi-column layouts that
   line-based OCR mangles. There is no `tesseract.js` step. Cost is higher per
   call than text, but accuracy on real-world scans is far better and the
   pipeline is simpler.
2. **Fallback cascade across engines.** A single engine hiccup or a hard document
   shouldn't doom an invoice. The primary engine is tried first; if its result is
   weak, the next engine is tried; the **best-scoring attempt wins**.
3. **The model owns the verdict.** Rather than a separate "is this an invoice?"
   pass, the schema makes the model classify and self-assess (`isInvoice`,
   `confidence`, `outcome`), and the worker fails deterministically-bad documents
   immediately instead of burning retries.
4. **Schema-constrained output.** Gemini gets a `responseSchema`; Claude/Groq
   outputs are normalised in code. No "ask for JSON and hope" parsing.

npm packages actually used: `@anthropic-ai/sdk`, `@google/genai`, `openai`
(for Groq), `pdf-parse`. (No `tesseract.js`, no `zod`.)

## The cascade order

The primary engine comes from the runtime selector
(`ExtractionEngineService`, default `claude-haiku-4-5`). Order:

1. **Primary vision engine** — Claude Haiku, or the selected Gemini model.
2. **The other vision engine(s)** — if Claude was primary, Gemini (primary model
   then an alternate Gemini model on retry); if Gemini was primary, Claude.
3. **PDF-text fallback (PDFs only)** — `pdf-parse` extracts the text layer and
   **Groq (GPT-OSS)** structures it. Skipped if there's no usable text.

```
extract(invoice):
  bytes = read file
  for engine in ordered cascade:           # leads with the selected primary
    r = engine.vision(bytes)               # Claude or Gemini reads the document
    if not detectProblem(r): return best(attempts)   # clean → done
    else record 'problem' and continue     # weak → try next engine
  # all vision attempts weak/failed:
  if PDF and Groq configured:
    text = pdf-parse(bytes)
    if text: r = groq.structure(text)       # last-resort text path
  return best(attempts)                      # best of everything tried, or throw
```

Each step is appended to the `processingLog` live (via an `onAttempt` callback)
and broadcast over Socket.IO, so the detail view shows, in real time, which
engine is being tried and why a fallback happened. The winning engine is stored
as `extractionSource` (e.g. `claude:claude-haiku-4-5`, `gemini-2.5-flash`,
`groq:openai/gpt-oss-120b (pdf-text)`).

## "Is this a good result?" — `detectProblem` / `best`

An attempt is a **problem** (→ try the next engine) when any of:

- `outcome !== 'ok'` (the model said not-an-invoice / empty / unreadable), or
- `isInvoice === false`, or
- `confidence < MIN_CONFIDENCE` (**0.4**), or
- no vendor name **and** no total, or
- broken math: `total` present but `≉ subtotal + tax`.

`best(attempts)` picks the highest-scoring attempt across everything tried, so
even if no single attempt was "clean", the invoice completes with the strongest
result rather than failing outright.

## Terminal failures (fail fast, don't retry)

Some verdicts won't change on a re-run, so the worker throws an
`UnrecoverableError` (skips BullMQ retries) and marks the invoice `failed`
immediately with a plain message:

- `outcome === 'not_an_invoice'` → "This looks like a receipt, not an invoice."
- `outcome === 'empty'` → "The page is blank — no invoice data to extract."
- `outcome === 'unreadable'` / `confidence < 0.4` → "The image is too blurry/low
  quality to read reliably."

Transient errors (quota 429, timeouts, network) fall through to BullMQ's normal
retry/backoff instead.

## The extracted shape (`ExtractedInvoice`)

Defined once in `invoice.types.ts`, used as the Gemini `responseSchema` **and**
stored in the `extractedData` jsonb column:

```ts
{
  vendorName, invoiceNumber, invoiceDate, dueDate, currency,   // all string|null
  subtotal, tax, total,                                        // number|null
  lineItems: [{ description, quantity, unitPrice, amount }],

  // classification + self-assessment (drive the UI badges & fail decision)
  isInvoice: boolean,
  confidence: number,                  // 0..1  (NOTE: a number, not high/med/low)
  docType: string | null,              // invoice|receipt|statement|purchase_order|other
  outcome: 'ok' | 'not_an_invoice' | 'empty' | 'unreadable',
  outcomeReason: string | null,        // one user-facing sentence for non-ok
  missingFields: string[],             // canonical field names not found
  note: string | null,                 // one data-quality sentence
  extractionSource: string,            // which engine won
}
```

Every scalar is nullable on purpose — a real invoice often omits a due date or
tax, and the rules tell the model to return `null` rather than guess. The
**anti-hallucination rules** in the prompt are explicit: never reconstruct
smudged digits; lower confidence sharply for poor scans; a wrong value is worse
than a missing one.

## Model & cost

- **Primary: `claude-haiku-4-5`** vision — fast, cheap, strong on structured
  extraction. Gemini vision models back it up; Groq (GPT-OSS) handles the
  PDF-text last resort.
- All engines are **runtime-switchable** (`PUT /ai/model` + a UI switcher); a
  provider is active only when its key is set.
- A typical invoice is a few image/text tokens in + a few hundred JSON tokens
  out. The BullMQ rate limiter (default 8 jobs / 60 s, concurrency 2) meters
  bursts so a batch upload doesn't blow a free-tier quota — excess jobs are
  parked, not failed.

## Error → `failed` with a message

| Case | Detection | User-facing message |
|---|---|---|
| No engine configured | no Claude/Gemini key | "No extraction engine configured." |
| Not an invoice | `outcome='not_an_invoice'` | "This looks like a receipt, not an invoice." |
| Empty/blank | `outcome='empty'` | "The page is blank — no invoice data to extract." |
| Unreadable / low confidence | `outcome='unreadable'` or `confidence<0.4` | "Too blurry/low quality to read reliably." |
| Bad PDF | `pdf-parse` throws | "Invalid PDF structure." |
| Transient | 429 / timeout / 5xx | retried by BullMQ; surfaced only after retries exhaust |

See [07-ai-assistant.md](07-ai-assistant.md) for how the assistant uses these
fields, and [04-async-processing.md](04-async-processing.md) for the worker /
retry wiring.
