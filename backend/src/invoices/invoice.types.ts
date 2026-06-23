/**
 * Lifecycle of an invoice:
 *   uploaded → processing → completed | failed   (failed → processing on retry)
 */
export type InvoiceStatus = 'uploaded' | 'processing' | 'completed' | 'failed';

export const INVOICE_STATUSES: InvoiceStatus[] = [
  'uploaded',
  'processing',
  'completed',
  'failed',
];

/**
 * One recorded step of the extraction pipeline — every cascade attempt and
 * every BullMQ retry — so the UI can show exactly what happened and why a
 * retry/fallback occurred.
 */
export interface ProcessingAttempt {
  at: string; // ISO timestamp
  /** BullMQ job attempt this happened on (1-based). */
  jobAttempt: number;
  /** Which engine/path was tried, e.g. "claude:claude-haiku-4-5" or "groq (pdf-text)". */
  engine: string;
  /** ok = clean result; problem = usable but flagged; error = threw; skipped = preconditions unmet. */
  outcome: 'ok' | 'problem' | 'error' | 'skipped';
  /** Short human reason for a non-ok outcome (e.g. "low confidence 0.4", "timeout"). */
  reason: string | null;
}

/** Filters shared by the export endpoints, the UI Export button, and the assistant. */
export interface ExportFilter {
  status?: InvoiceStatus;
  vendor?: string;
  minTotal?: number;
  maxTotal?: number;
  search?: string;
}

/**
 * A rich, targeted invoice filter used by the assistant's `filter_invoices`
 * tool so it can fetch and analyse a NEEDED subset instead of the whole
 * dataset. All fields are optional and ANDed together; matching runs in TS over
 * the jsonb extractedData so null / non-numeric values are handled safely.
 */
export interface InvoiceFilter {
  status?: InvoiceStatus;
  vendor?: string; // substring, case-insensitive
  minTotal?: number;
  maxTotal?: number;
  currency?: string; // exact ISO code, case-insensitive
  /** Issued on/after this ISO date (invoiceDate). */
  issuedAfter?: string;
  /** Issued on/before this ISO date (invoiceDate). */
  issuedBefore?: string;
  /** Due on/before this ISO date (dueDate). */
  dueBefore?: string;
  /** Only invoices whose dueDate is in the past (completed + dueDate < today). */
  overdue?: boolean;
  /** Only invoices the extraction flagged as problematic/empty/not-an-invoice. */
  hasProblem?: boolean;
  /** Only invoices with no usable data (no vendor AND no total). */
  empty?: boolean;
  /** Only invoices whose line items contain this text (case-insensitive). */
  lineItem?: string;
  /** Free-text across filename / vendor / invoice number. */
  search?: string;
  /** amount_asc = cheapest first; amount_desc = priciest; date_desc = newest. */
  sort?: 'amount_asc' | 'amount_desc' | 'date_desc';
  limit?: number;
}

/**
 * The extracted fields the assistant (and a future manual editor) may correct.
 * Deliberately a SAFE subset of ExtractedInvoice — scalar business fields only,
 * no line items, no classification/diagnostic fields. Every value is optional;
 * only provided keys are written.
 */
export interface EditableInvoiceFields {
  vendorName?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
}

/** The keys a caller is allowed to edit, for validation. */
export const EDITABLE_INVOICE_FIELDS: ReadonlyArray<keyof EditableInvoiceFields> = [
  'vendorName',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'currency',
  'subtotal',
  'tax',
  'total',
];

/** Supported export formats. */
export type ExportFormat = 'xlsx' | 'csv' | 'zip';

/** A single line on an invoice. */
export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

/**
 * The structured data extracted from an invoice once processing completes.
 * This is the shape Gemini fills (its responseSchema) AND the shape stored in
 * the `extractedData` jsonb column — defined once, used in both places.
 */
export interface ExtractedInvoice {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // ISO date
  dueDate: string | null; // ISO date
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: ExtractedLineItem[];

  // Upload-helper classification (the model's own assessment of the document).
  isInvoice: boolean; // false → the file is probably not an invoice
  confidence: number; // 0..1 certainty in the extraction
  docType: string | null; // invoice | receipt | statement | purchase_order | other

  // The model's verdict on this extraction — it decides whether the result is
  // usable or the invoice should be marked failed.
  //   ok            → real invoice data was extracted
  //   not_an_invoice→ the document is not an invoice (receipt, letter, photo…)
  //   empty         → an invoice/blank doc with no usable data (no vendor/total/items)
  //   unreadable    → too poor to read (blur, blank scan, garbled)
  outcome?: 'ok' | 'not_an_invoice' | 'empty' | 'unreadable';
  /** One short human sentence explaining a non-ok outcome (shown to the user). */
  outcomeReason?: string | null;

  /**
   * Fields the model could NOT find on the document, by their canonical name
   * (e.g. ["dueDate", "tax"]). Drives the "Missing: …" badge on the card.
   */
  missingFields?: string[];
  /** A short AI note about data quality / what's missing (one sentence, or null). */
  note?: string | null;

  /** Which engine produced this extraction (set by the cascade fallback). */
  extractionSource?: string; // e.g. "gemini-2.5-flash" | "gemini-2.0-flash (retry)" | "groq:openai/gpt-oss-120b (pdf-text)"
}
