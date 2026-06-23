import { Type, type FunctionDeclaration, type Schema } from '@google/genai';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoicesService } from '../invoices/invoices.service';
import { InvoiceStatus } from '../invoices/invoice.types';
import { InvoiceStatsDto } from '../invoices/dto/invoice-stats.dto';

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'donut';
export type ChartMetric =
  | 'status'
  | 'vendors'
  | 'currency'
  | 'over_time'
  | 'invoice_totals'
  | 'top_products';

/** A render-ready chart spec the frontend draws with @mantine/charts. */
export interface ChartSpec {
  type: ChartType;
  title: string;
  /** Each datum: a label + a numeric value (+ optional color for pie/donut). */
  data: Array<{ name: string; value: number; color?: string }>;
  /** Axis label for the value series (bar/line/area). */
  valueLabel: string;
}

const STATUS_COLOR: Record<string, string> = {
  uploaded: 'gray.5',
  processing: 'blue.5',
  completed: 'teal.6',
  failed: 'red.6',
};
// Rotating palette for vendor/currency slices.
const PALETTE = ['indigo.6', 'teal.6', 'orange.6', 'grape.6', 'cyan.6', 'lime.6', 'pink.6', 'yellow.6'];

/** Build a chart spec from server stats for a (type, metric) pair. */
function buildChart(
  type: ChartType,
  metric: ChartMetric,
  title: string | undefined,
  stats: InvoiceStatsDto,
): ChartSpec {
  let data: ChartSpec['data'] = [];
  let valueLabel = 'Count';
  let auto = '';

  switch (metric) {
    case 'status':
      auto = 'Invoices by status';
      valueLabel = 'Invoices';
      data = (Object.keys(stats.byStatus) as InvoiceStatus[])
        .map((s) => ({ name: s, value: stats.byStatus[s] ?? 0, color: STATUS_COLOR[s] }))
        .filter((d) => d.value > 0);
      break;
    case 'vendors':
      auto = 'Top vendors by spend';
      valueLabel = 'Total spend';
      data = stats.topVendors.map((v, i) => ({
        name: v.vendor,
        value: v.total,
        color: PALETTE[i % PALETTE.length],
      }));
      break;
    case 'currency':
      auto = 'Spend by currency';
      valueLabel = 'Total spend';
      data = stats.byCurrency.map((c, i) => ({
        name: c.currency,
        value: c.total,
        color: PALETTE[i % PALETTE.length],
      }));
      break;
    case 'over_time':
      auto = 'Invoices over time';
      valueLabel = 'Invoices';
      data = stats.overTime.map((d) => ({ name: d.day, value: d.count }));
      break;
  }

  return { type, title: title || auto, data, valueLabel };
}

/** Build a chart spec from a ready-made name/value series (with a palette). */
function buildChartFromSeries(
  type: ChartType,
  title: string,
  valueLabel: string,
  series: Array<{ name: string; value: number }>,
): ChartSpec {
  return {
    type,
    title,
    valueLabel,
    data: series.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] })),
  };
}

/** The function-calling tools exposed to Gemini. */
export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'list_invoices',
    description: 'List invoices, newest first. Optional status filter and limit.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          enum: ['uploaded', 'processing', 'completed', 'failed'],
        },
        limit: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'get_invoice',
    description:
      'Get one invoice by its id, including extracted data. The id must be a real ' +
      'invoice UUID taken from a finder result (list/search/filter) — never invent one.',
    parameters: {
      type: Type.OBJECT,
      properties: { id: { type: Type.STRING, description: 'Real invoice UUID from a tool result.' } },
      required: ['id'],
    },
  },
  {
    name: 'search_invoices',
    description: 'Search invoices by vendor name, invoice number, or file name.',
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING } },
      required: ['query'],
    },
  },
  {
    name: 'list_empty_invoices',
    description:
      'List "empty" invoices — ones where extraction produced no useful data ' +
      '(no vendor name AND no total). Use this when the user mentions empty, ' +
      'blank, or invoices with no data. Returns their ids so they can be deleted.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'query_invoices',
    description:
      'Query invoices BY AMOUNT or vendor. Use this for ANY request about the ' +
      'cheapest/smallest, most expensive/largest, highest/lowest, top-N by value, ' +
      'invoices over/under a number, sorting by amount, or "all invoices from <vendor>". ' +
      'For the single cheapest, use sort=amount_asc, limit=1; for the most expensive, ' +
      'sort=amount_desc, limit=1. Returns matching invoices (with ids) so you can then act.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sort: {
          type: Type.STRING,
          enum: ['amount_asc', 'amount_desc', 'date_desc'],
          description: 'amount_asc = cheapest first, amount_desc = most expensive first.',
        },
        minTotal: { type: Type.NUMBER, description: 'Only invoices with total >= this.' },
        maxTotal: { type: Type.NUMBER, description: 'Only invoices with total <= this.' },
        vendor: { type: Type.STRING, description: 'Vendor name substring filter.' },
        limit: { type: Type.NUMBER, description: 'Max results (e.g. 1 for the single cheapest).' },
      },
    },
  },
  {
    name: 'filter_invoices',
    description:
      'Fetch a TARGETED SUBSET of invoices by any combination of filters, with ' +
      'FULL per-invoice details (totals, dates, line items) so you can analyse ' +
      'just those — instead of pulling the whole dataset. Prefer this over ' +
      'get_dataset whenever the user scopes the question (a status, a vendor, a ' +
      'currency, a date range, overdue ones, problem/empty ones, a product, an ' +
      'amount range). Combine filters freely (they AND together). Returns the ' +
      'matched invoices (with ids) ready to analyse or act on.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          enum: ['uploaded', 'processing', 'completed', 'failed'],
          description: 'Only invoices in this status.',
        },
        vendor: { type: Type.STRING, description: 'Vendor name substring.' },
        currency: { type: Type.STRING, description: 'Exact ISO currency code, e.g. EUR, GBP.' },
        minTotal: { type: Type.NUMBER, description: 'total >= this.' },
        maxTotal: { type: Type.NUMBER, description: 'total <= this.' },
        issuedAfter: { type: Type.STRING, description: 'Issued on/after this ISO date (YYYY-MM-DD).' },
        issuedBefore: { type: Type.STRING, description: 'Issued on/before this ISO date.' },
        dueBefore: { type: Type.STRING, description: 'Due on/before this ISO date.' },
        overdue: { type: Type.BOOLEAN, description: 'Only past-due invoices (completed, dueDate in the past).' },
        hasProblem: {
          type: Type.BOOLEAN,
          description: 'Only flagged invoices: failed, low confidence, not-an-invoice, or missing fields.',
        },
        empty: { type: Type.BOOLEAN, description: 'Only invoices with no vendor AND no total.' },
        lineItem: { type: Type.STRING, description: 'Only invoices whose line items mention this text.' },
        search: { type: Type.STRING, description: 'Free-text across filename / vendor / invoice number.' },
        sort: {
          type: Type.STRING,
          enum: ['amount_asc', 'amount_desc', 'date_desc'],
          description: 'amount_asc = cheapest first; amount_desc = priciest; date_desc = newest.',
        },
        limit: { type: Type.NUMBER, description: 'Cap the number of results.' },
      },
    },
  },
  {
    name: 'get_dataset',
    description:
      'Get the WHOLE invoice dataset in ONE call, with full per-invoice fields ' +
      '(totals, subtotal, tax, dates, currency AND line items / products). Use this ' +
      'whenever you need to analyse, summarise, trend, or compare across MANY invoices, ' +
      'or answer "what products / line items" across more than one invoice. ' +
      'NEVER loop get_invoice for each id — call get_dataset once instead.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          enum: ['uploaded', 'processing', 'completed', 'failed'],
          description: 'Optional status filter.',
        },
        includeLineItems: {
          type: Type.BOOLEAN,
          description: 'Include each invoice\'s line items (products). Default true.',
        },
      },
    },
  },
  {
    name: 'get_invoice_stats',
    description:
      'Aggregate stats: counts by status, total spend by currency, top vendors, average value, overdue count.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'render_chart',
    description:
      'Draw a chart for the user. Pick the chart TYPE and the METRIC to visualise. ' +
      'Use this whenever the user wants a graph, chart, plot, breakdown, or visual — and ' +
      'choose the most fitting type for the data: pie/donut for shares (status, currency), ' +
      'bar for comparisons (top vendors), line/area for trends over time. The data comes ' +
      'from the server stats, so it is always accurate.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: {
          type: Type.STRING,
          enum: ['bar', 'line', 'area', 'pie', 'donut'],
          description: 'The chart style.',
        },
        metric: {
          type: Type.STRING,
          enum: ['status', 'vendors', 'currency', 'over_time', 'invoice_totals', 'top_products'],
          description:
            'What to plot: status = count by status; vendors = top vendors by spend; ' +
            'currency = total spend per currency; over_time = invoices per day; ' +
            'invoice_totals = each invoice\'s total in time order (use this for a PRICE TREND line); ' +
            'top_products = top line-item products by amount spent.',
        },
        title: { type: Type.STRING, description: 'Optional chart title.' },
      },
      required: ['type', 'metric'],
    },
  },
  {
    name: 'retry_invoice',
    description:
      'Re-queue a FAILED invoice for processing. Only works on failed invoices. ' +
      'The id must be a real invoice UUID from a finder result — never invent one.',
    parameters: {
      type: Type.OBJECT,
      properties: { id: { type: Type.STRING, description: 'Real invoice UUID from a tool result.' } },
      required: ['id'],
    },
  },
  {
    name: 'retry_all_failed',
    description:
      'Re-queue EVERY failed invoice for processing in one step. Prefer this over calling retry_invoice many times.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'retry_failed_then_cleanup',
    description:
      'Re-queue every failed invoice AND, in the background, automatically delete any that fail AGAIN after re-processing. ' +
      'Use this for requests like "retry the failed ones and delete them if they still fail". ' +
      'Processing is async: this returns right away after re-queuing; a server-side watcher waits for the outcome and ' +
      'deletes the still-failing ones (the UI updates live). Do NOT separately call delete afterwards.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'reprocess_invoice',
    description:
      'Re-run AI extraction on ONE invoice to re-check / read it again — works on ' +
      'ANY status (use it for a COMPLETED invoice whose data looks wrong, not just ' +
      'failed ones; for a failed invoice retry_invoice is equivalent). The invoice ' +
      'goes back through processing and its extracted data is refreshed.',
    parameters: {
      type: Type.OBJECT,
      properties: { id: { type: Type.STRING, description: 'Real invoice UUID from a tool result.' } },
      required: ['id'],
    },
  },
  {
    name: 'update_invoice',
    description:
      'Correct one or more EXTRACTED FIELDS on an invoice when the user points out ' +
      'a mistake (e.g. wrong vendor, total, currency, or a date). Provide the id and ' +
      'only the fields to change. Editable: vendorName, invoiceNumber, invoiceDate, ' +
      'dueDate (ISO YYYY-MM-DD), currency (ISO code), subtotal, tax, total (numbers). ' +
      'The system asks the user to CONFIRM the change before applying it. Look the ' +
      'invoice up first (never invent the id); do not change fields the user did not ask about.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: 'The invoice id to edit.' },
        vendorName: { type: Type.STRING },
        invoiceNumber: { type: Type.STRING },
        invoiceDate: { type: Type.STRING, description: 'ISO date YYYY-MM-DD.' },
        dueDate: { type: Type.STRING, description: 'ISO date YYYY-MM-DD.' },
        currency: { type: Type.STRING, description: 'ISO 4217 code, e.g. EUR.' },
        subtotal: { type: Type.NUMBER },
        tax: { type: Type.NUMBER },
        total: { type: Type.NUMBER },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_invoice',
    description:
      'Permanently delete ONE invoice by id. Requires user confirmation (the system will ask). ' +
      'To delete MORE THAN ONE invoice, use delete_invoices instead — never call this in a loop.',
    parameters: {
      type: Type.OBJECT,
      properties: { id: { type: Type.STRING } },
      required: ['id'],
    },
  },
  {
    name: 'delete_invoices',
    description:
      'Permanently delete MULTIPLE invoices in one step by their ids. Use this whenever the ' +
      'user wants to remove several invoices (e.g. duplicates, all failed, a filtered set) — ' +
      'it asks for a SINGLE confirmation for the whole batch instead of one per invoice.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Invoice ids to delete.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'navigate_ui',
    description:
      'Drive the app UI for the user: open an invoice detail modal, switch the main tab, ' +
      'apply a status filter, or set the search box. Use this to SHOW the user something ' +
      'rather than only describing it. You can combine fields (e.g. switch to the "all" tab ' +
      'and filter by status "failed"). Call it whenever the user asks to see, open, show, ' +
      'filter, or go to something.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        openInvoiceId: {
          type: Type.STRING,
          description: 'Open the detail modal for this invoice id.',
        },
        tab: {
          type: Type.STRING,
          enum: ['upload', 'all', 'analytics'],
          description: 'Switch the main panel tab. "analytics" shows charts/insights.',
        },
        statusFilter: {
          type: Type.STRING,
          enum: ['uploaded', 'processing', 'completed', 'failed', 'all'],
          description: 'Filter the invoice list by status; "all" clears the filter.',
        },
        search: {
          type: Type.STRING,
          description: 'Put this text in the invoice search box.',
        },
        openUpload: {
          type: Type.BOOLEAN,
          description: 'Open the file picker so the user can upload a new invoice.',
        },
      },
    },
  },
  {
    name: 'suggest_actions',
    description:
      'Offer the user 2–4 concrete NEXT STEPS as clickable buttons after you answer ' +
      'or analyse something. Each suggestion has a short button "label" and the exact ' +
      '"prompt" that will be sent back to you if the user clicks it. Use this instead ' +
      'of (or alongside) listing suggestions in prose — the buttons render under your ' +
      'reply. Suggest only genuinely useful, relevant actions (e.g. "Export these to ' +
      'Excel", "Retry the failed ones", "Delete the empty ones", "Open the largest"). ' +
      'Make each prompt self-contained and specific so clicking it does the right thing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        suggestions: {
          type: Type.ARRAY,
          description: '2–4 suggested next actions.',
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING, description: 'Short button text, e.g. "Export to Excel".' },
              prompt: {
                type: Type.STRING,
                description: 'The full request sent back if clicked, e.g. "Export the overdue EUR invoices to Excel".',
              },
            },
            required: ['label', 'prompt'],
          },
        },
      },
      required: ['suggestions'],
    },
  },
  {
    name: 'export_invoices',
    description:
      'Export a filtered set of invoices for the user to download. ' +
      'format "xlsx" or "csv" exports the invoice DATA (vendor, number, dates, amounts, status); ' +
      'format "zip" downloads an archive of the ORIGINAL uploaded files. ' +
      'Apply filters to scope the export: status, vendor substring, min/max total, or a free-text ' +
      'search. Use this for requests like "download all completed invoices as Excel", "export ' +
      'invoices over 1000 to csv", or "give me a zip of the failed ones". The download starts ' +
      'automatically in the browser.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        format: {
          type: Type.STRING,
          enum: ['xlsx', 'csv', 'zip'],
          description: 'xlsx/csv = spreadsheet of data; zip = archive of original files.',
        },
        status: {
          type: Type.STRING,
          enum: ['uploaded', 'processing', 'completed', 'failed'],
          description: 'Only export invoices in this status. Omit for all.',
        },
        vendor: { type: Type.STRING, description: 'Only invoices whose vendor name contains this.' },
        minTotal: { type: Type.NUMBER, description: 'Only invoices with total >= this.' },
        maxTotal: { type: Type.NUMBER, description: 'Only invoices with total <= this.' },
        search: {
          type: Type.STRING,
          description: 'Free-text match across filename, vendor and invoice number.',
        },
      },
      required: ['format'],
    },
  },
];

/** Tools that must not execute until the user confirms (delete + field edits). */
export const DESTRUCTIVE_TOOLS = new Set([
  'delete_invoice',
  'delete_invoices',
  'update_invoice',
]);

/** Of the gated tools, which are edits (vs deletes) — routed to a different confirm flow. */
export const EDIT_TOOLS = new Set(['update_invoice']);

/**
 * Convert a Gemini Schema (the SDK's uppercase Type enum) into a plain JSON
 * Schema usable by OpenAI-compatible APIs (Groq). Recursive over object
 * properties; passes enums and required through unchanged.
 */
function geminiSchemaToJsonSchema(schema?: Schema): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} };
  const typeMap: Record<string, string> = {
    [Type.OBJECT]: 'object',
    [Type.STRING]: 'string',
    [Type.NUMBER]: 'number',
    [Type.INTEGER]: 'integer',
    [Type.BOOLEAN]: 'boolean',
    [Type.ARRAY]: 'array',
  };
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = typeMap[schema.type] ?? 'string';
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [
        k,
        geminiSchemaToJsonSchema(v as Schema),
      ]),
    );
  }
  if (schema.items) out.items = geminiSchemaToJsonSchema(schema.items as Schema);
  if (schema.required) out.required = schema.required;
  return out;
}

/** The same tool surface, expressed in the OpenAI "tools" format for Groq. */
export const OPENAI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] =
  TOOL_DECLARATIONS.map((decl) => ({
    type: 'function',
    function: {
      name: decl.name ?? '',
      description: decl.description,
      parameters: geminiSchemaToJsonSchema(decl.parameters),
    },
  }));

/** The same tool surface in Anthropic's tool format (name + input_schema) for Claude. */
export const ANTHROPIC_TOOLS = TOOL_DECLARATIONS.map((decl) => ({
  name: decl.name ?? '',
  description: decl.description,
  input_schema: geminiSchemaToJsonSchema(decl.parameters) as Anthropic.Tool.InputSchema,
}));

export interface ToolResult {
  result: 'ok' | 'error';
  summary: string;
  /** Compact payload fed back to the model (kept small to save tokens). */
  data: Record<string, unknown>;
}

/** Project an invoice to a tiny shape for the model (no raw files / line items). */
function compact(i: Invoice) {
  return {
    id: i.id,
    file: i.originalFilename,
    status: i.status,
    vendor: i.extractedData?.vendorName ?? null,
    invoiceNumber: i.extractedData?.invoiceNumber ?? null,
    total: i.extractedData?.total ?? null,
    currency: i.extractedData?.currency ?? null,
    createdAt: i.createdAt,
  };
}

/**
 * A richer projection for the bulk get_dataset tool: compact + the analysis
 * fields (subtotal, tax, dates) and a token-bounded line-item list (products).
 * This lets the model answer "what products / price trend across all invoices"
 * from ONE call instead of N get_invoice loops.
 */
function compactDetailed(i: Invoice, includeLineItems: boolean) {
  const ed = i.extractedData;
  const items = (ed?.lineItems ?? []).slice(0, 20).map((li) => ({
    description: li.description,
    quantity: li.quantity,
    amount: li.amount,
  }));
  return {
    ...compact(i),
    subtotal: ed?.subtotal ?? null,
    tax: ed?.tax ?? null,
    invoiceDate: ed?.invoiceDate ?? null,
    dueDate: ed?.dueDate ?? null,
    ...(includeLineItems ? { lineItems: items, lineItemCount: ed?.lineItems?.length ?? 0 } : {}),
  };
}

/**
 * Execute a (non-destructive) tool call against InvoicesService and return a
 * compact result. delete_invoice is NOT handled here — it is gated by the
 * confirmation flow in AssistantService.
 */
/** Tools whose `id` argument must be a real invoice UUID (from a finder result). */
const ID_TOOLS = new Set(['get_invoice', 'retry_invoice', 'reprocess_invoice']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  invoices: InvoicesService,
): Promise<ToolResult> {
  // Grounding guard: the model must take ids from a finder result, never invent
  // them (e.g. "1"). Reject a non-UUID id with a friendly, model-readable error
  // instead of letting it reach the DB as an opaque "invalid uuid" 500.
  if (ID_TOOLS.has(name) && !UUID_RE.test(String(args.id ?? ''))) {
    return {
      result: 'error',
      summary:
        `"${String(args.id)}" is not a real invoice id. Find the invoice first ` +
        '(list_invoices / search_invoices / filter_invoices), then use the id from that result.',
      data: { error: 'invalid_id' },
    };
  }

  try {
    switch (name) {
      case 'list_invoices': {
        const status = args.status as InvoiceStatus | undefined;
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const rows = (await invoices.findAll(status)).slice(0, limit);
        return {
          result: 'ok',
          summary: `Listed ${rows.length} invoice(s)${status ? ` with status ${status}` : ''}.`,
          data: { invoices: rows.map(compact) },
        };
      }
      case 'get_invoice': {
        const inv = await invoices.findOne(String(args.id));
        return {
          result: 'ok',
          summary: `Fetched invoice ${inv.originalFilename}.`,
          data: { invoice: { ...compact(inv), extractedData: inv.extractedData } },
        };
      }
      case 'search_invoices': {
        const rows = await invoices.search(String(args.query));
        return {
          result: 'ok',
          summary: `Found ${rows.length} invoice(s) matching "${String(args.query)}".`,
          data: { invoices: rows.map(compact) },
        };
      }
      case 'list_empty_invoices': {
        const rows = await invoices.findEmpty();
        return {
          result: 'ok',
          summary:
            rows.length === 0
              ? 'No empty invoices found.'
              : `Found ${rows.length} empty invoice(s) (no vendor or total).`,
          data: { invoices: rows.map(compact) },
        };
      }
      case 'query_invoices': {
        const rows = await invoices.queryByAmount({
          sort: args.sort as 'amount_asc' | 'amount_desc' | 'date_desc' | undefined,
          minTotal: typeof args.minTotal === 'number' ? args.minTotal : undefined,
          maxTotal: typeof args.maxTotal === 'number' ? args.maxTotal : undefined,
          vendor: typeof args.vendor === 'string' ? args.vendor : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        return {
          result: 'ok',
          summary: `Matched ${rows.length} invoice(s).`,
          data: { invoices: rows.map(compact) },
        };
      }
      case 'filter_invoices': {
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
        const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
        const rows = await invoices.filterInvoices({
          status: args.status as InvoiceStatus | undefined,
          vendor: str(args.vendor),
          currency: str(args.currency),
          minTotal: num(args.minTotal),
          maxTotal: num(args.maxTotal),
          issuedAfter: str(args.issuedAfter),
          issuedBefore: str(args.issuedBefore),
          dueBefore: str(args.dueBefore),
          overdue: args.overdue === true,
          hasProblem: args.hasProblem === true,
          empty: args.empty === true,
          lineItem: str(args.lineItem),
          search: str(args.search),
          sort: args.sort as 'amount_asc' | 'amount_desc' | 'date_desc' | undefined,
          limit: num(args.limit),
        });
        return {
          result: 'ok',
          summary: `Matched ${rows.length} invoice(s) for the given filters.`,
          // Cards for the UI + full per-invoice detail (incl. line items) for analysis.
          data: {
            invoices: rows.map(compact),
            dataset: rows.map((r) => compactDetailed(r, true)),
          },
        };
      }
      case 'get_dataset': {
        const status = args.status as InvoiceStatus | undefined;
        const includeLineItems = args.includeLineItems !== false; // default true
        const rows = await invoices.findAll(status);
        return {
          result: 'ok',
          summary: `Fetched ${rows.length} invoice(s) with full details${
            includeLineItems ? ' and line items' : ''
          }.`,
          // `invoices` (compact) still drives the UI cards; `dataset` carries the
          // rich fields the model analyses. One call, no N+1.
          data: {
            invoices: rows.map(compact),
            dataset: rows.map((r) => compactDetailed(r, includeLineItems)),
          },
        };
      }
      case 'get_invoice_stats': {
        const stats = await invoices.getStats();
        return {
          result: 'ok',
          summary: `Stats: ${stats.total} total, ${stats.byStatus.failed} failed, ${stats.byStatus.completed} completed.`,
          data: { stats },
        };
      }
      case 'render_chart': {
        const type = String(args.type) as ChartType;
        const metric = String(args.metric) as ChartMetric;
        const title = typeof args.title === 'string' ? args.title : undefined;
        // Most metrics come from getStats(); the two new series need their own
        // queries — fetch only what's needed.
        let chart;
        if (metric === 'invoice_totals') {
          chart = buildChartFromSeries(
            type,
            title || 'Invoice totals (price trend)',
            'Total',
            (await invoices.getInvoiceTotalsSeries()).map((p) => ({ name: p.label, value: p.total })),
          );
        } else if (metric === 'top_products') {
          chart = buildChartFromSeries(
            type,
            title || 'Top products by spend',
            'Amount',
            (await invoices.getTopProducts(8)).map((p) => ({ name: p.description, value: p.totalAmount })),
          );
        } else {
          chart = buildChart(type, metric, title, await invoices.getStats());
        }
        return {
          result: 'ok',
          summary: `Rendered a ${type} chart of ${metric}.`,
          data: { chart },
        };
      }
      case 'retry_invoice': {
        const inv = await invoices.retry(String(args.id));
        return {
          result: 'ok',
          summary: `Re-queued invoice ${inv.originalFilename} for processing.`,
          data: { invoice: compact(inv) },
        };
      }
      case 'reprocess_invoice': {
        const inv = await invoices.reprocess(String(args.id));
        return {
          result: 'ok',
          summary: `Re-checking invoice ${inv.originalFilename} — re-running extraction now.`,
          data: { invoice: compact(inv) },
        };
      }
      case 'retry_all_failed': {
        const failed = await invoices.findAll('failed');
        const retried = [];
        for (const f of failed) {
          try {
            retried.push(compact(await invoices.retry(f.id)));
          } catch {
            // Skip any that slipped out of the failed state between the list and the retry.
          }
        }
        return {
          result: 'ok',
          summary:
            retried.length === 0
              ? 'No failed invoices to retry.'
              : `Re-queued ${retried.length} failed invoice(s) for processing.`,
          data: { invoices: retried },
        };
      }
      case 'retry_failed_then_cleanup': {
        const { retried } = await invoices.retryFailedThenCleanup();
        return {
          result: 'ok',
          summary:
            retried.length === 0
              ? 'No failed invoices to retry.'
              : `Re-queued ${retried.length} failed invoice(s). Any that fail again will be deleted automatically once processing finishes.`,
          data: { invoices: retried.map(compact) },
        };
      }
      case 'navigate_ui': {
        // No DB work — this returns a UI intent the frontend executes. We echo it
        // back so the model knows the screen changed.
        const intent: Record<string, unknown> = {};
        if (typeof args.openInvoiceId === 'string') intent.openInvoiceId = args.openInvoiceId;
        if (typeof args.tab === 'string') intent.tab = args.tab;
        if (typeof args.statusFilter === 'string') intent.statusFilter = args.statusFilter;
        if (typeof args.search === 'string') intent.search = args.search;
        if (args.openUpload === true) intent.openUpload = true;
        const parts: string[] = [];
        if (intent.openInvoiceId) parts.push('opened the invoice');
        if (intent.tab) parts.push(`switched to the ${String(intent.tab)} tab`);
        if (intent.statusFilter) parts.push(`filtered by ${String(intent.statusFilter)}`);
        if (intent.search) parts.push(`searched for "${String(intent.search)}"`);
        if (intent.openUpload) parts.push('opened the upload dialog');
        return {
          result: 'ok',
          summary: parts.length ? `Navigated the UI: ${parts.join(', ')}.` : 'Nothing to navigate.',
          data: { navigate: intent },
        };
      }
      case 'suggest_actions': {
        const raw = Array.isArray(args.suggestions) ? args.suggestions : [];
        const suggestions = raw
          .map((s) => {
            const o = (s ?? {}) as { label?: unknown; prompt?: unknown };
            return {
              label: typeof o.label === 'string' ? o.label.trim() : '',
              prompt: typeof o.prompt === 'string' ? o.prompt.trim() : '',
            };
          })
          .filter((s) => s.label && s.prompt)
          .slice(0, 4);
        return {
          result: 'ok',
          summary:
            suggestions.length > 0
              ? `Offered ${suggestions.length} suggested action(s).`
              : 'No suggestions.',
          // Forwarded to the UI, which renders them as clickable buttons.
          data: { suggestions },
        };
      }
      case 'export_invoices': {
        const format = String(args.format ?? 'xlsx').toLowerCase();
        if (format !== 'xlsx' && format !== 'csv' && format !== 'zip') {
          return {
            result: 'error',
            summary: `Unsupported export format "${format}". Use xlsx, csv, or zip.`,
            data: { error: 'bad_format' },
          };
        }
        const filter = {
          status: typeof args.status === 'string' ? (args.status as InvoiceStatus) : undefined,
          vendor: typeof args.vendor === 'string' ? args.vendor : undefined,
          minTotal: typeof args.minTotal === 'number' ? args.minTotal : undefined,
          maxTotal: typeof args.maxTotal === 'number' ? args.maxTotal : undefined,
          search: typeof args.search === 'string' ? args.search : undefined,
        };
        const matched = await invoices.queryForExport(filter);

        // Build the relative download URL with the same filters; the frontend
        // fetches it (with auth) and saves the file. No file is built here.
        const params = new URLSearchParams();
        if (filter.status) params.set('status', filter.status);
        if (filter.vendor) params.set('vendor', filter.vendor);
        if (filter.minTotal != null) params.set('minTotal', String(filter.minTotal));
        if (filter.maxTotal != null) params.set('maxTotal', String(filter.maxTotal));
        if (filter.search) params.set('search', filter.search);
        const qs = params.toString();
        const url = `/invoices/export/${format}${qs ? `?${qs}` : ''}`;
        const stamp = new Date().toISOString().slice(0, 10);

        return {
          result: 'ok',
          summary:
            matched.length === 0
              ? 'No invoices matched those filters — nothing to export.'
              : `Prepared a ${format.toUpperCase()} export of ${matched.length} invoice(s); the download will start.`,
          data: {
            download: {
              url,
              filename: `invoices_${stamp}.${format}`,
              format,
              count: matched.length,
            },
          },
        };
      }
      default:
        return { result: 'error', summary: `Unknown tool "${name}".`, data: { error: 'unknown_tool' } };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: 'error', summary: message, data: { error: message } };
  }
}
