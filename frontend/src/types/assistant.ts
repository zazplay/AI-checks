/** A compact invoice the assistant references; the full record is read from cache by id. */
export interface CompactInvoice {
  id: string;
  file: string;
  status: import('./invoice').InvoiceStatus;
  vendor: string | null;
  invoiceNumber: string | null;
  total: number | null;
  currency: string | null;
  createdAt: string;
}

/** A render-ready chart the assistant asked to draw (data comes from the server). */
export interface ChartSpec {
  type: 'bar' | 'line' | 'area' | 'pie' | 'donut';
  title: string;
  data: Array<{ name: string; value: number; color?: string }>;
  valueLabel: string;
}

/** A request from the assistant to drive the app UI (open modal, switch tab, filter…). */
export interface NavigateIntent {
  openInvoiceId?: string;
  tab?: 'upload' | 'all' | 'analytics';
  statusFilter?: import('./invoice').InvoiceStatus | 'all';
  search?: string;
  openUpload?: boolean;
}

/** A clickable next-step the assistant offers; clicking sends `prompt` to chat. */
export interface Suggestion {
  label: string;
  prompt: string;
}

/** A file the assistant prepared for the user to download (export). */
export interface DownloadIntent {
  /** Relative API path, e.g. /invoices/export.xlsx?status=completed */
  url: string;
  filename: string;
  format: 'xlsx' | 'csv' | 'zip';
  count: number;
}

/**
 * `ToolAction` is the server-side projection of a Gemini functionCall/
 * functionResponse pair, flattened by the backend into one record per action.
 */
export interface ToolAction {
  tool: string;
  input: Record<string, unknown>;
  result: 'ok' | 'error';
  summary: string;
  /**
   * Compact payload the UI can render richly:
   * - `stats` — from get_invoice_stats, drawn as a chart
   * - `invoices` / `invoice` — from list/search/retry tools, drawn as cards
   * - `navigate` — from navigate_ui, executed against the app
   */
  data?: {
    stats?: import('./stats').InvoiceStats;
    invoices?: CompactInvoice[];
    invoice?: CompactInvoice;
    navigate?: NavigateIntent;
    chart?: ChartSpec;
    download?: DownloadIntent;
    suggestions?: Suggestion[];
  };
}

/** A conversation turn in Gemini's role vocabulary (sent back as history). */
export interface ChatTurn {
  role: 'user' | 'model';
  content: string;
}

/** A destructive action awaiting the user's confirmation. */
export interface PendingConfirmation {
  token: string;
  tool: string;
  input: Record<string, unknown>;
  prompt: string;
}

export interface AskResponse {
  content: string;
  actions: ToolAction[];
  history?: ChatTurn[];
  pendingConfirmation?: PendingConfirmation;
}

/** A live progress step streamed while the assistant works (SSE). */
export interface AssistantStep {
  kind: 'thinking' | 'tool' | 'done';
  label: string;
  tool?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: ToolAction[];
  pending?: boolean;
  /** Live progress steps shown while the message is pending (streamed). */
  steps?: AssistantStep[];
  /** Set on an assistant message that is asking the user to confirm an action. */
  confirm?: PendingConfirmation;
}

export interface Anomaly {
  type: 'duplicate' | 'high_amount';
  invoiceIds: string[];
  message: string;
}

export interface Insights {
  summary: string;
  anomalies: Anomaly[];
  stats: unknown;
}
