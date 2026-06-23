import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/** Postgres UUID shape — guards against the model inventing ids like "1","2". */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
import type { Content } from '@google/genai';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoicesService } from '../invoices/invoices.service';
import { GeminiService } from '../ai/gemini.service';
import { GroqService } from '../ai/groq.service';
import { ClaudeService } from '../ai/claude.service';
import { AssistantEngineService } from '../ai/assistant-engine.service';
import {
  ANTHROPIC_TOOLS,
  DESTRUCTIVE_TOOLS,
  EDIT_TOOLS,
  OPENAI_TOOLS,
  TOOL_DECLARATIONS,
  dispatchTool,
} from './assistant.tools';
import { EDITABLE_INVOICE_FIELDS, EditableInvoiceFields } from '../invoices/invoice.types';

export interface ChatTurn {
  role: 'user' | 'model';
  content: string;
}

export interface ToolAction {
  tool: string;
  input: Record<string, unknown>;
  result: 'ok' | 'error';
  summary: string;
  /** Compact structured payload for tools the UI can visualise (e.g. stats). */
  data?: Record<string, unknown>;
}

export interface PendingConfirmation {
  token: string;
  tool: string;
  input: Record<string, unknown>;
  prompt: string;
}

export interface AskResult {
  content: string;
  actions: ToolAction[];
  history: ChatTurn[];
  pendingConfirmation?: PendingConfirmation;
}

/**
 * A live progress step emitted while the agentic loop runs, so the UI can show
 * "what's happening" instead of a mute spinner. `kind: 'thinking'` is emitted
 * before each model call; `kind: 'tool'` before each tool executes (label is a
 * human-friendly verb, tool is the raw name).
 */
export interface AssistantStep {
  kind: 'thinking' | 'tool' | 'done';
  label: string;
  tool?: string;
}

export type StepEmitter = (step: AssistantStep) => void;

/** Human-friendly verb shown live while a tool runs (mirrors the UI labels). */
const TOOL_STEP_LABEL: Record<string, string> = {
  list_invoices: 'Looking up invoices',
  get_invoice: 'Opening an invoice',
  search_invoices: 'Searching invoices',
  list_empty_invoices: 'Finding empty invoices',
  query_invoices: 'Querying invoices',
  filter_invoices: 'Filtering invoices',
  get_dataset: 'Loading the dataset',
  get_invoice_stats: 'Gathering statistics',
  render_chart: 'Drawing a chart',
  retry_invoice: 'Retrying an invoice',
  reprocess_invoice: 'Re-checking an invoice',
  update_invoice: 'Preparing an edit',
  retry_all_failed: 'Retrying all failed',
  retry_failed_then_cleanup: 'Retrying failed & cleaning up',
  delete_invoice: 'Preparing a delete',
  delete_invoices: 'Preparing a delete',
  navigate_ui: 'Navigating the app',
  export_invoices: 'Exporting invoices',
  suggest_actions: 'Suggesting next steps',
};

const toolStepLabel = (tool: string): string =>
  TOOL_STEP_LABEL[tool] ?? `Running ${tool.replace(/_/g, ' ')}`;

const SYSTEM_PROMPT = [
  'You are a helpful, conversational assistant for an invoice-processing app.',
  'You can answer questions, DRIVE THE APP using tools, AND reason freely in prose.',
  'Not every message maps to a tool. When a request is open-ended — "evaluate this",',
  '"what do you think?", "is this normal/suspicious?", "summarize it", "compare them",',
  '"any issues?", general questions, or small talk — just respond thoughtfully in your',
  'own words. Use tools to FETCH the data you need (e.g. get_invoice for full details',
  'including line items), then give a genuine answer or assessment. Do NOT fall back to',
  're-running navigation or repeating a canned line when the user asks for your opinion',
  'or analysis — actually analyze and say something useful.',
  'When you assess an invoice, consider things like: totals vs subtotal+tax consistency,',
  'whether a due date has passed, unusually high/low amounts, low extraction confidence,',
  'missing fields, or anything that looks off — and explain it plainly.',
  'Rules:',
  '- NEVER invent or guess an invoice id, and never use a position/number like "1" as an id.',
  '  Real ids are UUIDs and ONLY ever come from a tool result.',
  '- When the user refers to an invoice by DESCRIPTION rather than a literal id — e.g.',
  '  "the most expensive overdue one", "the cheapest", "the Acme invoice", "the first',
  '  failed one", "that blank invoice" — you MUST first call a finder (filter_invoices,',
  '  query_invoices, search_invoices, or list_invoices) with the right filters/sort to',
  '  get the actual invoice(s), THEN take the real id from that result and act on it.',
  '  Example: "delete the largest overdue invoice" → filter_invoices(overdue=true,',
  '  sort="amount_desc", limit=1) → take the returned id → delete_invoice(id). Do this',
  '  in the SAME turn; never call delete/update/retry with an id you did not get from a tool.',
  '- When the user names a status (failed / completed / uploaded / processing), ALWAYS pass',
  '  that status as the filter argument (e.g. list_invoices(status="failed"), or the status',
  '  param on get_dataset / export_invoices) — do not fetch everything and eyeball it.',
  '  To show failed invoices, prefer list_invoices(status="failed"). To retry the failed',
  '  ones, call retry_all_failed (it targets only failed and safely reports when there are none).',
  '- For "empty"/"blank"/"no data" invoices, call list_empty_invoices to find them',
  '  (do NOT search for the word "empty"); then act on the ids it returns.',
  '- For anything about amount — cheapest, most expensive, highest/lowest, top-N,',
  '  over/under a number, or sorting by value — call query_invoices (NOT a text search).',
  '  e.g. cheapest = sort amount_asc limit 1; most expensive = sort amount_desc limit 1.',
  '  To "delete the cheapest", call query_invoices first to get the id, then delete_invoice.',
  '- When the request is SCOPED — a status, vendor, currency, date range, overdue,',
  '  problem/empty ones, a product, or an amount range — call filter_invoices with the',
  '  matching filters. It returns ONLY that subset WITH full details (totals, dates,',
  '  line items), so analyse those directly. Prefer it over get_dataset for any',
  '  narrowed question (e.g. "overdue EUR invoices", "completed ones over 1000 with',
  '  shipping"). Combine filters freely.',
  '- Only when the user genuinely means EVERYTHING (no scope) call get_dataset ONCE',
  '  (every invoice with totals, dates AND line items). NEVER call get_invoice in a',
  '  loop over many ids — that is slow and hits the step limit. get_invoice is only',
  '  for ONE specific invoice.',
  '- To RE-CHECK or re-read an invoice whose data looks wrong, call reprocess_invoice',
  '  (it re-runs extraction on ANY status, not just failed ones).',
  '- To CORRECT a field the user says is wrong (vendor, total, currency, a date, etc.),',
  '  call update_invoice with the id and only the changed fields. The system shows the',
  '  user a before→after confirmation; do not claim it changed until confirmed, and',
  '  never edit fields the user did not mention.',
  '- BE PROACTIVE: after answering or analysing, when there are obvious useful next',
  '  steps, call suggest_actions with 2–4 of them so they render as CLICKABLE BUTTONS',
  '  under your reply. Each needs a short label and a self-contained prompt (e.g. label',
  '  "Export to Excel" / prompt "Export the overdue EUR invoices to Excel"). Only',
  '  suggest genuinely relevant actions (retry/reprocess weak ones, fix an obviously',
  '  wrong field, export/delete a filtered set, open the biggest for detail). Suggest,',
  '  do not perform — clicking a button is what triggers the action. Prefer buttons over',
  '  a prose list of options.',
  '- When the user wants a chart, graph, plot, or visual breakdown, call render_chart and',
  '  pick the best type+metric: pie/donut for status or currency shares, bar for top',
  '  vendors or top_products, line/area for trends. For a PRICE TREND of invoices use',
  '  metric=invoice_totals; for products use metric=top_products. The chart renders inline.',
  '- NEVER write markdown image tags or links for charts (no ![](...) , no /chart/ urls,',
  '  no data:image, no placeholders). render_chart already draws the chart visually — just',
  '  describe it in words; do not try to embed an image.',
  '- When the user asks to SEE, SHOW, OPEN, FILTER, or GO TO something, call navigate_ui',
  '  to actually change the screen (open a detail modal, switch tab, set a status filter,',
  '  set the search box, or open the upload dialog) — do not just describe it.',
  '- When you LIST or FIND invoices, the UI shows them as interactive cards automatically;',
  '  keep that particular reply short and let the cards speak. But when the user asks for',
  '  analysis or an opinion, give a full, substantive answer instead of a one-liner.',
  '- Follow-ups refer to context: if the user just saw one invoice and says "evaluate it"',
  '  or "оцени его", call get_invoice for that same invoice and assess it — do not ask',
  '  which one or just re-open it.',
  '- retry_invoice only works on invoices whose status is "failed".',
  '- To retry every failed invoice, call retry_all_failed once (not retry_invoice repeatedly).',
  '- If the user wants to retry failed invoices AND delete the ones that still fail,',
  '  call retry_failed_then_cleanup ONCE. Processing is async, so do not check status',
  '  again or call delete yourself — a server watcher deletes the still-failing ones.',
  '- When the user wants to DOWNLOAD, EXPORT, or SAVE invoices as a file (Excel/xlsx,',
  '  CSV, or a zip archive of the original documents), call export_invoices with the',
  '  requested format and any filters they mention (status, vendor, amount range, search).',
  '  Use "zip" when they want the original files/documents; "xlsx" or "csv" for the data.',
  '  The download starts automatically — just confirm what was exported.',
  '- For deletions, the system asks the user to confirm; do not claim a delete',
  '  happened until it is confirmed.',
  '- To delete MORE THAN ONE invoice (duplicates, a filtered set, etc.), call',
  '  delete_invoices ONCE with all the ids — it asks for a single confirmation.',
  '  NEVER call delete_invoice repeatedly in a loop.',
  '- Be concise. After an action, report the outcome in one or two sentences.',
  '- If a tool returns an error, tell the user plainly; do not retry in a loop.',
].join(' ');

// Tools whose compact result should be forwarded to the UI for rich rendering
// (invoice cards, navigation intents, stat charts) rather than only narrated.
const UI_DATA_TOOLS = new Set([
  'list_invoices',
  'search_invoices',
  'list_empty_invoices',
  'query_invoices',
  'filter_invoices',
  'get_dataset',
  'get_invoice',
  'get_invoice_stats',
  'render_chart',
  'retry_invoice',
  'reprocess_invoice',
  'retry_all_failed',
  'retry_failed_then_cleanup',
  'navigate_ui',
  'export_invoices',
  'suggest_actions',
]);

const MAX_TURNS = 8;
const CONFIRM_TTL_MS = 5 * 60_000;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly gemini: GeminiService,
    private readonly groq: GroqService,
    private readonly claude: ClaudeService,
    private readonly engine: AssistantEngineService,
    private readonly invoices: InvoicesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run a chat turn on whichever engine is selected. Both engines share the
   * confirmation flow, the tool dispatcher, the destructive-tool gate, and the
   * MAX_TURNS cap; only the SDK/message format differs.
   */
  async ask(
    message: string,
    history: ChatTurn[] = [],
    confirm?: { token: string },
    onStep: StepEmitter = () => {},
  ): Promise<AskResult> {
    const actions: ToolAction[] = [];

    // A confirmation token executes the previously-gated action.
    if (confirm) {
      const payload = this.verifyToken(confirm.token);

      // Field edit (update_invoice): apply the signed patch to the invoice.
      if (EDIT_TOOLS.has(payload.tool)) {
        const id = String(payload.input.id ?? '');
        const patch = (payload.input.patch ?? {}) as EditableInvoiceFields;
        try {
          await this.invoices.updateExtractedFields(id, patch);
          actions.push({
            tool: payload.tool,
            input: payload.input,
            result: 'ok',
            summary: `Updated invoice ${id}.`,
          });
          return { content: 'Done — the invoice has been updated.', actions, history };
        } catch (error) {
          const m = error instanceof Error ? error.message : String(error);
          actions.push({ tool: payload.tool, input: payload.input, result: 'error', summary: m });
          return { content: `Could not update the invoice: ${m}`, actions, history };
        }
      }

      // A confirm token may carry one id or a list (bulk delete).
      const rawIds: string[] = Array.isArray(payload.input.ids)
        ? (payload.input.ids as unknown[]).map(String)
        : [String(payload.input.id)];
      // Last-resort guard: only ever hand real UUIDs to the DB. Tokens are now
      // only signed for resolved ids, but this keeps a malformed/forged token
      // from reaching Postgres with a bogus id.
      const ids = rawIds.filter(isUuid);
      let okCount = 0;
      for (const id of ids) {
        try {
          await this.invoices.remove(id);
          okCount += 1;
        } catch (error) {
          const m = error instanceof Error ? error.message : String(error);
          actions.push({ tool: payload.tool, input: { id }, result: 'error', summary: m });
        }
      }
      if (okCount > 0) {
        actions.push({
          tool: payload.tool,
          input: payload.input,
          result: 'ok',
          summary:
            ids.length === 1
              ? `Deleted invoice ${ids[0]}.`
              : `Deleted ${okCount} invoice(s).`,
        });
      }
      // A confirmation click carries no new user text — DON'T re-invoke the LLM
      // (an empty user message 400s on Claude). Just report the outcome.
      let content: string;
      if (ids.length === 0) {
        content = 'Nothing was deleted — those invoices could not be found.';
      } else if (okCount === ids.length) {
        content =
          okCount === 1
            ? 'Done — the invoice has been deleted.'
            : `Done — ${okCount} invoices deleted.`;
      } else {
        content = `Deleted ${okCount} of ${ids.length}; the rest could not be removed.`;
      }
      return {
        content,
        actions,
        history,
      };
    }

    const { provider, model } = this.engine.choice;
    if (provider === 'groq') {
      return this.askGroq(model, message, history, actions, onStep);
    }
    if (provider === 'claude') {
      return this.askClaude(model, message, history, actions, onStep);
    }
    return this.askGemini(model, message, history, actions, onStep);
  }

  /** Gemini function-calling loop (also handles the destructive-tool gate). */
  private async askGemini(
    model: string,
    message: string,
    history: ChatTurn[],
    actions: ToolAction[],
    onStep: StepEmitter,
  ): Promise<AskResult> {
    if (!this.gemini.client) {
      throw new ServiceUnavailableException('AI is not configured (missing GEMINI_API_KEY).');
    }

    const contents: Content[] = [
      ...history.map(toGeminiContent),
      { role: 'user', parts: [{ text: message }] },
    ];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        onStep({ kind: 'thinking', label: turn === 0 ? 'Thinking' : 'Working on it' });
        const res = await this.gemini.client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          },
        });

        const calls = res.functionCalls ?? [];
        if (calls.length === 0) {
          // Some models (esp. *-lite) end a turn without a final text after a
          // tool call. Fall back to narrating the actions so the user always
          // gets a reply.
          const content = groundReplyText(
            res.text?.trim() ||
              (actions.length ? actions.map((a) => a.summary).join(' ') : 'Done.'),
            actions,
          );
          return {
            content,
            actions,
            history: [
              ...history,
              { role: 'user', content: message },
              { role: 'model', content },
            ],
          };
        }

        // Record the model's function-call turn.
        const modelContent = res.candidates?.[0]?.content;
        if (modelContent) contents.push(modelContent);

        for (const call of calls) {
          const name = call.name ?? '';
          const args = (call.args ?? {}) as Record<string, unknown>;

          if (DESTRUCTIVE_TOOLS.has(name)) {
            // Same validating gate as the Groq/Claude paths: resolve real ids
            // and ask to confirm (or reject invented ids) — never sign a token
            // for ids that don't exist.
            return this.buildGatedPending(name, args, actions, history);
          }

          onStep({ kind: 'tool', label: toolStepLabel(name), tool: name });
          const r = await dispatchTool(name, args, this.invoices);
          actions.push({
            tool: name,
            input: args,
            result: r.result,
            summary: r.summary,
            // Forward the compact payload so the chat can render invoice cards,
            // navigate the app, or draw the stats chart.
            data: UI_DATA_TOOLS.has(name) ? r.data : undefined,
          });
          contents.push({
            role: 'user',
            parts: [{ functionResponse: { name, response: r.data } }],
          });
        }
      }

      return {
        content: 'I could not complete that within the step limit — please narrow the request.',
        actions,
        history,
      };
    } catch (error) {
      throw new ServiceUnavailableException(this.gemini.humanizeError(error));
    }
  }

  /**
   * Groq (OpenAI-compatible) tool-calling loop. Same tools and gating as the
   * Gemini path, expressed in OpenAI's messages/tool_calls format.
   */
  private async askGroq(
    model: string,
    message: string,
    history: ChatTurn[],
    actions: ToolAction[],
    onStep: StepEmitter,
  ): Promise<AskResult> {
    if (!this.groq.client) {
      throw new ServiceUnavailableException('Groq is not configured (missing GROQ_API_KEY).');
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(toOpenAIMessage),
      { role: 'user', content: message },
    ];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        onStep({ kind: 'thinking', label: turn === 0 ? 'Thinking' : 'Working on it' });
        const res = await this.groqCompletionWithRetry(model, messages);

        const choice = res.choices[0]?.message;
        const calls = choice?.tool_calls ?? [];

        if (calls.length === 0) {
          const content = groundReplyText(
            choice?.content?.trim() ||
              (actions.length ? actions.map((a) => a.summary).join(' ') : 'Done.'),
            actions,
          );
          return {
            content,
            actions,
            history: [
              ...history,
              { role: 'user', content: message },
              { role: 'model', content },
            ],
          };
        }

        // Normalize each call up front (recovering names Groq mangled), and
        // rewrite them on the assistant message BEFORE pushing it back — Groq
        // re-validates historical tool_calls against request.tools, so a bad
        // name left in history 400s the next turn.
        const normalized = calls.map((call) =>
          call.type === 'function'
            ? normalizeToolCall(call.function.name, call.function.arguments)
            : { name: '', args: {} },
        );
        calls.forEach((call, i) => {
          if (call.type === 'function') {
            call.function.name = normalized[i].name;
            call.function.arguments = JSON.stringify(normalized[i].args);
          }
        });
        messages.push(choice as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          if (call.type !== 'function') continue;
          const { name, args } = normalized[i];

          if (DESTRUCTIVE_TOOLS.has(name)) {
            return this.buildGatedPending(name, args, actions, history);
          }

          onStep({ kind: 'tool', label: toolStepLabel(name), tool: name });
          const r = await dispatchTool(name, args, this.invoices);
          actions.push({
            tool: name,
            input: args,
            result: r.result,
            summary: r.summary,
            data: UI_DATA_TOOLS.has(name) ? r.data : undefined,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(r.data),
          });
        }
      }

      return {
        content: 'I could not complete that within the step limit — please narrow the request.',
        actions,
        history,
      };
    } catch (error) {
      throw new ServiceUnavailableException(this.groq.humanizeError(error));
    }
  }

  /**
   * Call Groq's chat completion, retrying the intermittent
   * "400 Failed to call a function" that Llama-class models occasionally emit
   * (a malformed tool call in the generation). Because generation is
   * non-deterministic, a plain re-request almost always succeeds. We retry only
   * that specific transient error — never rate limits or auth failures.
   */
  private async groqCompletionWithRetry(
    model: string,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ) {
    const MAX_ATTEMPTS = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.groq.client!.chat.completions.create({
          model,
          messages,
          tools: OPENAI_TOOLS,
          tool_choice: 'auto',
        });
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message.toLowerCase() : '';
        const isTransientToolCall =
          msg.includes('failed to call a function') ||
          msg.includes('failed_generation') ||
          msg.includes('tool call validation');
        if (!isTransientToolCall || attempt === MAX_ATTEMPTS) throw error;
        this.logger.warn(
          `Groq malformed tool-call (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying.`,
        );
      }
    }
    throw lastError;
  }

  /**
   * Claude (Haiku 4.5) tool-use loop. Same tools and gating as the other
   * engines, in Anthropic's messages/tool_use/tool_result format.
   */
  private async askClaude(
    model: string,
    message: string,
    history: ChatTurn[],
    actions: ToolAction[],
    onStep: StepEmitter,
  ): Promise<AskResult> {
    if (!this.claude.client) {
      throw new ServiceUnavailableException('Claude is not configured (missing ANTHROPIC_API_KEY).');
    }

    const messages: Anthropic.MessageParam[] = [
      ...history.map(toAnthropicMessage),
      { role: 'user', content: message },
    ];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        onStep({ kind: 'thinking', label: turn === 0 ? 'Thinking' : 'Working on it' });
        const res = await this.claude.client.messages.create({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: ANTHROPIC_TOOLS,
          messages,
        });

        const toolUses = res.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        const textOut = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();

        if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
          const content = groundReplyText(
            textOut ||
              (actions.length ? actions.map((a) => a.summary).join(' ') : 'Done.'),
            actions,
          );
          return {
            content,
            actions,
            history: [
              ...history,
              { role: 'user', content: message },
              { role: 'model', content },
            ],
          };
        }

        // Record the assistant's tool-use turn verbatim (required before results).
        messages.push({ role: 'assistant', content: res.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const call of toolUses) {
          const name = call.name;
          const args = (call.input ?? {}) as Record<string, unknown>;

          if (DESTRUCTIVE_TOOLS.has(name)) {
            return this.buildGatedPending(name, args, actions, history);
          }

          onStep({ kind: 'tool', label: toolStepLabel(name), tool: name });
          const r = await dispatchTool(name, args, this.invoices);
          actions.push({
            tool: name,
            input: args,
            result: r.result,
            summary: r.summary,
            data: UI_DATA_TOOLS.has(name) ? r.data : undefined,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(r.data),
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      return {
        content: 'I could not complete that within the step limit — please narrow the request.',
        actions,
        history,
      };
    } catch (error) {
      throw new ServiceUnavailableException(this.claude.humanizeError(error));
    }
  }

  /** AI insights over all invoices: deterministic anomalies + one Gemini summary. */
  async analyze(): Promise<{ summary: string; anomalies: Anomaly[]; stats: unknown }> {
    const [all, stats] = await Promise.all([
      this.invoices.findAll(),
      this.invoices.getStats(),
    ]);
    const completed = all.filter((i) => i.status === 'completed' && i.extractedData);
    const anomalies = detectAnomalies(completed);

    let summary = `${stats.total} invoices, ${stats.byStatus.completed} completed and ${stats.byStatus.failed} failed.`;
    try {
      const facts = JSON.stringify({
        total: stats.total,
        byStatus: stats.byStatus,
        byCurrency: stats.byCurrency,
        topVendors: stats.topVendors,
        overdue: stats.overdue,
        averageInvoiceValue: stats.averageInvoiceValue,
        averageCurrency: stats.averageCurrency,
        anomalies: anomalies.map((a) => ({ type: a.type, message: a.message })),
      });
      // Uses the currently-selected assistant engine (Claude Haiku by default).
      const narrative = await this.completeText(
        'You are a finance assistant. Write a concise 3-4 sentence narrative ' +
          'summary of these invoice statistics and anomalies for a manager. ' +
          'Do not list raw numbers verbatim; interpret them. ' +
          'IMPORTANT: never add amounts across different currencies — report ' +
          'spend per currency (use byCurrency) and never present a blended total ' +
          'or a single combined figure across currencies. Facts:\n' +
          facts,
      );
      summary = narrative || summary;
    } catch (error) {
      this.logger.warn(`analyze summary skipped: ${String(error)}`);
    }

    return { summary, anomalies, stats };
  }

  /** Plain-language explanation of a single invoice. */
  async explain(id: string): Promise<{ summary: string }> {
    const inv = await this.invoices.findOne(id);
    if (!inv.extractedData) {
      return { summary: 'This invoice has no extracted data yet.' };
    }
    // Uses the currently-selected assistant engine (Claude Haiku by default).
    const summary = await this.completeText(
      'Explain this invoice in 2 plain sentences for a non-finance user. ' +
        'Invoice data:\n' +
        JSON.stringify(inv.extractedData),
    );
    return { summary: summary || 'No summary available.' };
  }

  /**
   * Get a plain-text completion from the CURRENTLY-SELECTED assistant engine
   * (Claude / Groq / Gemini) — no tools. Used by explain() and analyze() so
   * those features honour the user's engine choice and aren't pinned to Gemini.
   */
  private async completeText(prompt: string): Promise<string> {
    const { provider, model } = this.engine.choice;

    if (provider === 'claude') {
      if (!this.claude.client) {
        throw new ServiceUnavailableException('Claude is not configured (missing ANTHROPIC_API_KEY).');
      }
      try {
        const res = await this.claude.client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      } catch (error) {
        throw new ServiceUnavailableException(this.claude.humanizeError(error));
      }
    }

    if (provider === 'groq') {
      if (!this.groq.client) {
        throw new ServiceUnavailableException('Groq is not configured (missing GROQ_API_KEY).');
      }
      try {
        const res = await this.groq.client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
        });
        return (res.choices[0]?.message?.content ?? '').trim();
      } catch (error) {
        throw new ServiceUnavailableException(this.groq.humanizeError(error));
      }
    }

    // gemini
    if (!this.gemini.client) {
      throw new ServiceUnavailableException('AI is not configured (missing GEMINI_API_KEY).');
    }
    try {
      const res = await this.gemini.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      return res.text?.trim() ?? '';
    } catch (error) {
      throw new ServiceUnavailableException(this.gemini.humanizeError(error));
    }
  }

  // ---- confirmation token (stateless, signed) ----

  private signToken(payload: { tool: string; input: Record<string, unknown> }): string {
    const body = { ...payload, exp: Date.now() + CONFIRM_TTL_MS };
    const json = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = this.hmac(json);
    return `${json}.${sig}`;
  }

  private verifyToken(token: string): { tool: string; input: Record<string, unknown> } {
    const [json, sig] = token.split('.');
    if (!json || !sig) throw new BadRequestException('Malformed confirmation token.');
    const expected = this.hmac(json);
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      throw new BadRequestException('Invalid confirmation token.');
    }
    const body = JSON.parse(Buffer.from(json, 'base64url').toString()) as {
      tool: string;
      input: Record<string, unknown>;
      exp: number;
    };
    if (Date.now() > body.exp) {
      throw new BadRequestException('Confirmation expired — please ask again.');
    }
    return { tool: body.tool, input: body.input };
  }

  private hmac(data: string): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? 'dev-insecure-jwt-secret';
    return createHmac('sha256', `assistant:${secret}`).update(data).digest('base64url');
  }

  private async safeFindOne(id: string): Promise<Invoice | null> {
    try {
      return await this.invoices.findOne(id);
    } catch {
      return null;
    }
  }

  /**
   * Build the pendingConfirmation for a destructive tool (delete_invoice or the
   * bulk delete_invoices) — ONE confirmation for the whole batch. The signed
   * token carries the id(s) so the confirm step deletes them without re-running
   * the model.
   */
  /** Route a gated tool to the right confirmation builder (edit vs delete). */
  private buildGatedPending(
    name: string,
    args: Record<string, unknown>,
    actions: ToolAction[],
    history: ChatTurn[],
  ): Promise<AskResult> {
    return EDIT_TOOLS.has(name)
      ? this.buildUpdatePending(name, args, actions, history)
      : this.buildDeletePending(name, args, actions, history);
  }

  /**
   * Build the pendingConfirmation for update_invoice: validate the id resolves
   * to a real invoice with extracted data, keep only editable+changed fields,
   * and show a "before → after" prompt. Signs a token carrying {id, patch} so
   * the confirm step applies it without re-running the model.
   */
  private async buildUpdatePending(
    name: string,
    args: Record<string, unknown>,
    actions: ToolAction[],
    history: ChatTurn[],
  ): Promise<AskResult> {
    const id = String(args.id ?? '');
    const fail = (summary: string): AskResult => {
      actions.push({ tool: name, input: args, result: 'error', summary });
      return { content: summary, actions, history };
    };

    if (!isUuid(id)) {
      return fail('I need the real invoice id to edit it — look it up first; never use a made-up id.');
    }
    const inv = await this.safeFindOne(id);
    if (!inv) return fail(`No invoice ${id} found.`);
    if (!inv.extractedData) {
      return fail('That invoice has no extracted data to edit yet.');
    }

    // Keep only editable keys whose value actually differs from the current one.
    const patch: EditableInvoiceFields = {};
    const changes: string[] = [];
    for (const key of EDITABLE_INVOICE_FIELDS) {
      if (!(key in args)) continue;
      const next = args[key] as string | number | null;
      const prev = (inv.extractedData as unknown as Record<string, unknown>)[key] ?? null;
      if (next === prev) continue;
      (patch as Record<string, unknown>)[key] = next;
      changes.push(`${key}: ${prev ?? '—'} → ${next ?? '—'}`);
    }
    if (changes.length === 0) {
      return fail('Nothing to change — those values already match.');
    }

    const token = this.signToken({ tool: name, input: { id, patch } });
    const prompt = `Update invoice "${inv.originalFilename}"? ${changes.join('; ')}.`;
    return {
      content: '',
      actions,
      history,
      pendingConfirmation: { token, tool: name, input: { id, patch }, prompt },
    };
  }

  private async buildDeletePending(
    name: string,
    args: Record<string, unknown>,
    actions: ToolAction[],
    history: ChatTurn[],
  ): Promise<AskResult> {
    const rawIds =
      name === 'delete_invoices' && Array.isArray(args.ids)
        ? (args.ids as unknown[]).map(String)
        : [String(args.id)];

    // The model sometimes invents ids (e.g. "1","2") instead of using real
    // UUIDs. Resolve to actually-existing invoices BEFORE asking to confirm, so
    // a confirmed delete can't fail on a bogus id and we never sign a token for
    // ids that don't exist.
    const resolved = (
      await Promise.all(
        rawIds.filter(isUuid).map(async (id) => {
          const inv = await this.safeFindOne(id);
          return inv ? { id, inv } : null;
        }),
      )
    ).filter((r): r is { id: string; inv: Invoice } => r !== null);

    if (resolved.length === 0) {
      // Nothing real to delete — tell the model plainly so it doesn't retry with
      // more invented ids, and don't sign a confirmation token.
      const summary =
        'No matching invoices to delete — the ids did not resolve to real invoices. ' +
        'Look them up with list_invoices or search_invoices first; never use made-up ids.';
      actions.push({ tool: name, input: { ids: rawIds }, result: 'error', summary });
      return {
        content: summary,
        actions,
        history,
      };
    }

    const ids = resolved.map((r) => r.id);
    let prompt: string;
    if (ids.length === 1) {
      const inv = resolved[0].inv;
      prompt = `Delete invoice "${inv.originalFilename}"${
        inv.extractedData?.total ? ` (total ${inv.extractedData.total})` : ''
      }? This permanently removes the file.`;
    } else {
      const names = resolved.slice(0, 5).map((r) => r.inv.originalFilename);
      const more = ids.length > 5 ? ` and ${ids.length - 5} more` : '';
      prompt = `Delete ${ids.length} invoices (${names.join(', ')}${more})? This permanently removes the files.`;
    }

    const token = this.signToken({ tool: name, input: { ids } });
    return { content: '', actions, history, pendingConfirmation: { token, tool: name, input: { ids }, prompt } };
  }
}

const UUID_GLOBAL_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Grounding guard for the reply TEXT: collect every invoice id that actually
 * appeared in this turn's tool results, then scrub from the prose any UUID the
 * model wrote that is NOT one of them (a hallucinated reference). Raw ids are
 * never meaningful to the user anyway, so an ungrounded one is replaced with a
 * neutral phrase rather than shown. Narrow by design (only UUID-shaped tokens),
 * so it can't damage normal prose.
 */
function groundReplyText(text: string, actions: ToolAction[]): string {
  if (!text || !UUID_GLOBAL_RE.test(text)) return text;
  const grounded = new Set<string>();
  for (const a of actions) {
    const d = a.data ?? {};
    const lists = [d.invoices, d.dataset].filter(Array.isArray) as Array<{ id?: unknown }>[];
    for (const list of lists) {
      for (const row of list) if (typeof row?.id === 'string') grounded.add(row.id.toLowerCase());
    }
    const one = (d.invoice as { id?: unknown } | undefined)?.id;
    if (typeof one === 'string') grounded.add(one.toLowerCase());
    if (typeof (a.input as { id?: unknown }).id === 'string') {
      grounded.add(String((a.input as { id: string }).id).toLowerCase());
    }
  }
  return text.replace(UUID_GLOBAL_RE, (m) =>
    grounded.has(m.toLowerCase()) ? m : 'that invoice',
  );
}

function toGeminiContent(turn: ChatTurn): Content {
  return { role: turn.role, parts: [{ text: turn.content }] };
}

/** Map a stored ChatTurn to an OpenAI message (model→assistant). */
function toOpenAIMessage(
  turn: ChatTurn,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: turn.role === 'model' ? 'assistant' : 'user',
    content: turn.content,
  };
}

/** Map a stored ChatTurn to an Anthropic message (model→assistant). */
function toAnthropicMessage(turn: ChatTurn): Anthropic.MessageParam {
  return {
    role: turn.role === 'model' ? 'assistant' : 'user',
    content: turn.content,
  };
}

/** Parse tool-call argument JSON defensively (Groq returns a JSON string). */
function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const KNOWN_TOOLS = new Set(TOOL_DECLARATIONS.map((t) => t.name));

/**
 * Some open models on Groq (notably Llama 3.3) occasionally mangle a tool call,
 * cramming the JSON args into the function NAME, e.g.
 *   name: 'delete_invoice,{"id":"abc"}'  arguments: ''
 * Left as-is, this 400s on the next request ("tool not in request.tools").
 * Recover the real tool name and any inlined args.
 */
function normalizeToolCall(name: string, rawArgs: string | undefined): {
  name: string;
  args: Record<string, unknown>;
} {
  let cleanName = (name ?? '').trim();
  let args = safeParseArgs(rawArgs);

  if (!KNOWN_TOOLS.has(cleanName)) {
    // Split on the first separator between the name and an inlined arg blob.
    const sep = cleanName.search(/[,({[\s]/);
    if (sep > 0) {
      const head = cleanName.slice(0, sep).trim();
      const tail = cleanName.slice(sep).replace(/^[,\s]+/, '');
      if (KNOWN_TOOLS.has(head)) {
        cleanName = head;
        if (Object.keys(args).length === 0) {
          const inlined = safeParseArgs(tail);
          if (Object.keys(inlined).length > 0) args = inlined;
        }
      }
    }
  }
  return { name: cleanName, args };
}

// ---- deterministic anomaly detection (no Gemini, no quota) ----

export interface Anomaly {
  type: 'duplicate' | 'high_amount';
  invoiceIds: string[];
  message: string;
}

function detectAnomalies(invoices: Invoice[]): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Duplicates by (vendorName, invoiceNumber).
  const byKey = new Map<string, Invoice[]>();
  for (const i of invoices) {
    const v = i.extractedData?.vendorName;
    const n = i.extractedData?.invoiceNumber;
    if (!v || !n) continue;
    const key = `${v.toLowerCase()}|${n.toLowerCase()}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(i);
  }
  for (const [, group] of byKey) {
    if (group.length > 1) {
      anomalies.push({
        type: 'duplicate',
        invoiceIds: group.map((g) => g.id),
        message: `${group.length} invoices share vendor "${group[0].extractedData?.vendorName}" and number "${group[0].extractedData?.invoiceNumber}".`,
      });
    }
  }

  // High-amount outliers per currency (> mean + 3·stddev).
  const byCurrency = new Map<string, Invoice[]>();
  for (const i of invoices) {
    const c = i.extractedData?.currency ?? 'UNKNOWN';
    const t = i.extractedData?.total;
    if (typeof t !== 'number') continue;
    (byCurrency.get(c) ?? byCurrency.set(c, []).get(c)!).push(i);
  }
  for (const [currency, group] of byCurrency) {
    if (group.length < 4) continue;
    const totals = group.map((g) => g.extractedData!.total as number);
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length;
    const sd = Math.sqrt(variance);
    const threshold = mean + 3 * sd;
    const outliers = group.filter((g) => (g.extractedData!.total as number) > threshold);
    for (const o of outliers) {
      anomalies.push({
        type: 'high_amount',
        invoiceIds: [o.id],
        message: `Invoice "${o.originalFilename}" total ${o.extractedData!.total} ${currency} is unusually high (avg ${mean.toFixed(0)}).`,
      });
    }
  }

  return anomalies;
}
