export const INVOICE_QUEUE = 'invoice-processing';

export interface InvoiceJobData {
  invoiceId: string;
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Worker throughput limits — the "queue on the backend" that keeps bursts of
 * uploads from blowing the AI provider's free-tier quota.
 *
 * `concurrency` caps how many invoices extract at once; `limiter` caps how many
 * jobs *start* per time window (BullMQ parks the rest as rate-limited — they
 * are NOT failed, so no quota is wasted). Defaults are tuned for free-tier
 * Gemini/Groq (a handful of requests per minute, with the extraction cascade
 * possibly making several AI calls per invoice). Override via env for a paid key.
 *
 * Read straight from process.env (not ConfigService) because the `@Processor`
 * decorator is evaluated at module-load time, before Nest's DI runs — `main.ts`
 * imports `dotenv/config` first so these values are populated by then.
 */
export const INVOICE_WORKER_OPTIONS = {
  concurrency: intFromEnv('EXTRACTION_CONCURRENCY', 2),
  limiter: {
    max: intFromEnv('EXTRACTION_RATE_MAX', 8),
    duration: intFromEnv('EXTRACTION_RATE_DURATION_MS', 60_000),
  },
} as const;

/**
 * Backpressure ceiling: the most jobs allowed to sit in the queue (waiting +
 * delayed + active) before new uploads are rejected with 429. Without this a
 * burst of N uploads enqueues N jobs unbounded — at 100k that's an 8-day
 * backlog the worker (a few/min) can never drain. Rejecting early fails fast
 * and lets the client back off instead of silently piling up. Override per
 * deployment via env (a paid AI key with higher worker throughput can raise it).
 */
export const QUEUE_BACKPRESSURE_LIMIT = intFromEnv('QUEUE_BACKPRESSURE_LIMIT', 5000);
