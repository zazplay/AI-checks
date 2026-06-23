/**
 * Mirrors the backend contract:
 *   backend/src/invoices/invoice.types.ts
 *   backend/src/invoices/dto/invoice-response.dto.ts
 * Dates arrive as ISO strings over JSON.
 */
export type InvoiceStatus = 'uploaded' | 'processing' | 'completed' | 'failed';

export const INVOICE_STATUSES: InvoiceStatus[] = [
  'uploaded',
  'processing',
  'completed',
  'failed',
];

export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface ExtractedInvoice {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: ExtractedLineItem[];

  // Upload-helper classification.
  isInvoice: boolean;
  confidence: number; // 0..1
  docType: string | null;

  // AI verdict + data-quality notes.
  outcome?: 'ok' | 'not_an_invoice' | 'empty' | 'unreadable';
  outcomeReason?: string | null;
  /** Canonical names of fields the model couldn't find (e.g. ["dueDate","tax"]). */
  missingFields?: string[];
  /** Short AI note about data quality / what's missing. */
  note?: string | null;

  /** Which engine produced this extraction (set by the cascade fallback). */
  extractionSource?: string;
}

/** One recorded step of the extraction pipeline (cascade attempt or retry). */
export interface ProcessingAttempt {
  at: string;
  jobAttempt: number;
  engine: string;
  outcome: 'ok' | 'problem' | 'error' | 'skipped';
  reason: string | null;
}

export interface Invoice {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  status: InvoiceStatus;
  extractedData: ExtractedInvoice | null;
  errorMessage: string | null;
  attempts: number;
  processingLog?: ProcessingAttempt[] | null;
  createdAt: string;
  updatedAt: string;
}

/** Sort keys the paginated list accepts (mirror of the backend whitelist). */
export type InvoiceSortKey =
  | 'originalFilename'
  | 'vendorName'
  | 'total'
  | 'status'
  | 'createdAt';

/** Params for the paginated GET /invoices?page=… query. */
export interface InvoicePageParams {
  page: number;
  limit: number;
  status?: InvoiceStatus;
  search?: string;
  sort?: InvoiceSortKey;
  dir?: 'asc' | 'desc';
}

/** One page of invoices plus the total count for the active filter. */
export interface InvoicePage {
  items: Invoice[];
  total: number;
  page: number;
  limit: number;
}
