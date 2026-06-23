import { Injectable, Logger } from '@nestjs/common';
import { Type, type Schema } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import { GeminiService } from '../ai/gemini.service';
import { GroqService } from '../ai/groq.service';
import { ClaudeService } from '../ai/claude.service';
import { ExtractionEngineService } from '../ai/extraction-engine.service';
import { StorageService } from '../storage/storage.service';
import { Invoice } from '../invoices/entities/invoice.entity';
import { ExtractedInvoice, ProcessingAttempt } from '../invoices/invoice.types';

/**
 * JSON schema handed to Gemini's `responseSchema`. It mirrors ExtractedInvoice
 * one-to-one, so the model is constrained to return exactly that shape — no
 * "ask for JSON and hope" parsing.
 */
const INVOICE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    vendorName: { type: Type.STRING, nullable: true },
    invoiceNumber: { type: Type.STRING, nullable: true },
    invoiceDate: { type: Type.STRING, nullable: true },
    dueDate: { type: Type.STRING, nullable: true },
    currency: { type: Type.STRING, nullable: true },
    subtotal: { type: Type.NUMBER, nullable: true },
    tax: { type: Type.NUMBER, nullable: true },
    total: { type: Type.NUMBER, nullable: true },
    lineItems: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING },
          quantity: { type: Type.NUMBER, nullable: true },
          unitPrice: { type: Type.NUMBER, nullable: true },
          amount: { type: Type.NUMBER, nullable: true },
        },
        required: ['description'],
      },
    },
    // Upload-helper classification fields.
    isInvoice: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    docType: { type: Type.STRING, nullable: true },
    // The model's own verdict on whether this extraction is usable.
    outcome: {
      type: Type.STRING,
      enum: ['ok', 'not_an_invoice', 'empty', 'unreadable'],
    },
    outcomeReason: { type: Type.STRING, nullable: true },
    // Data-quality notes: which fields are missing + a short human note.
    missingFields: { type: Type.ARRAY, items: { type: Type.STRING } },
    note: { type: Type.STRING, nullable: true },
  },
  required: ['lineItems', 'isInvoice', 'confidence', 'outcome'],
};

const RULES = [
  '- Use null for any field that is not present; do not invent values.',
  '- NEVER guess. If a number, word, or date is blurry, cut off, faint, or you',
  '  are not sure you read it correctly, set that field to null instead of',
  '  guessing — a wrong value is worse than a missing one. Do not "reconstruct"',
  '  smudged digits or partially visible text.',
  '- confidence MUST reflect legibility: lower it sharply for blurry/low-quality/',
  '  skewed scans. If much of the document is hard to read, set confidence below',
  '  0.4 and outcome="unreadable" rather than returning made-up values.',
  '- Dates must be ISO format (yyyy-mm-dd).',
  '- Amounts are plain numbers without currency symbols or thousands separators.',
  '- currency is the ISO 4217 code (e.g. USD, EUR) when determinable.',
  '- lineItems is the table of charges; use [] if there is none.',
  '- List each distinct charge in lineItems exactly ONCE. On multi-page',
  '  documents, do NOT repeat a row that continues across pages, and ignore',
  '  repeated table headers, "continued" rows, and per-page subtotal or',
  '  carry-forward lines — they are not separate charges.',
  '- Also classify the document: set isInvoice true ONLY if this is genuinely',
  '  an invoice or bill; confidence is your 0..1 certainty in the extraction;',
  '  docType is one of invoice|receipt|statement|purchase_order|other.',
  '- Decide the outcome and YOU choose what happens to this upload:',
  '    "ok" = a real invoice with usable data (vendor, total, or line items).',
  '    "not_an_invoice" = the document is not an invoice (e.g. a receipt, letter,',
  '      random photo, or unrelated page).',
  '    "empty" = an invoice/blank document with NO usable data at all (no vendor,',
  '      no total, no line items).',
  '    "unreadable" = too poor to read (severe blur, blank scan, garbled text).',
  '  Use "ok" only when you actually extracted something useful; otherwise pick the',
  '  closest non-ok outcome. For any non-ok outcome, write outcomeReason as ONE short,',
  '  plain sentence the user will see (e.g. "This looks like a receipt, not an invoice."',
  '  or "The page is blank — no invoice data to extract."). For "ok", outcomeReason is null.',
  '- missingFields: list the canonical names of any important fields you could NOT find',
  '  on the document, from this set only: vendorName, invoiceNumber, invoiceDate, dueDate,',
  '  currency, subtotal, tax, total, lineItems. Use [] if nothing important is missing.',
  '- note: ONE short, plain sentence about data quality when something is missing or looks',
  '  off (e.g. "No due date or tax shown; totals look complete."). Use null when the',
  '  extraction is clean and complete.',
].join(' ');

const VISION_PROMPT =
  'You are an invoice data extractor. Read the attached invoice (PDF or image) ' +
  'and extract its fields. Rules: ' + RULES;

const TEXT_PROMPT =
  'You are an invoice data extractor. Below is the raw text extracted from an ' +
  'invoice document. Extract its fields and return ONLY a JSON object matching ' +
  'this TypeScript type (no markdown, no prose):\n' +
  '{ vendorName, invoiceNumber, invoiceDate, dueDate, currency, subtotal, tax, ' +
  'total, lineItems: [{description, quantity, unitPrice, amount}], isInvoice, ' +
  'confidence, docType, outcome, outcomeReason, missingFields, note }\nRules: ' +
  RULES + '\n\nDOCUMENT TEXT:\n';

/**
 * Below this confidence the extraction is treated as unreliable (likely a poor
 * scan the model partly guessed at) and the invoice is failed rather than
 * stored with possibly-hallucinated values.
 */
const MIN_CONFIDENCE = 0.4;

@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

  constructor(
    private readonly gemini: GeminiService,
    private readonly groq: GroqService,
    private readonly claude: ClaudeService,
    private readonly engine: ExtractionEngineService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Extract structured data with a FALLBACK CASCADE so a single engine hiccup or
   * a hard document doesn't doom the invoice. The PRIMARY engine is whatever the
   * extraction selector chose (Claude Haiku by default), tried FIRST; the others
   * back it up:
   *   1. Primary engine (Claude Haiku vision, or the selected Gemini model).
   *   2. The other vision engine(s) — Claude if Gemini was primary, Gemini
   *      models if Claude was primary.
   *   3. If it's a PDF and still poor, GPT over the PDF's text layer.
   * The best-scoring successful attempt wins; each records its engine in
   * `extractionSource`.
   */
  /**
   * @param onAttempt called after each cascade step so the caller can persist
   *   and live-broadcast the running processing log.
   */
  async extract(
    invoice: Invoice,
    onAttempt?: (attempt: ProcessingAttempt) => void | Promise<void>,
  ): Promise<{ data: ExtractedInvoice; log: ProcessingAttempt[] }> {
    if (!this.claude.client && !this.gemini.client) {
      throw new Error('No extraction engine configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).');
    }

    const bytes = await this.storage.getBytes(invoice.storedPath);
    const attempts: ExtractedInvoice[] = [];
    const log: ProcessingAttempt[] = [];
    let lastError: unknown;

    const record = async (
      engine: string,
      outcome: ProcessingAttempt['outcome'],
      reason: string | null,
    ) => {
      const entry: ProcessingAttempt = {
        at: new Date().toISOString(),
        jobAttempt: invoice.attempts,
        engine,
        outcome,
        reason,
      };
      log.push(entry);
      if (onAttempt) await onAttempt(entry);
    };

    // Run one vision attempt; returns the result early if it's clean, else null.
    const tryVision = async (
      label: string,
      run: () => Promise<ExtractedInvoice>,
      source: string,
    ): Promise<ExtractedInvoice | null> => {
      try {
        const r = await run();
        r.extractionSource = source;
        attempts.push(r);
        if (!this.detectProblem(r)) {
          await record(source, 'ok', null);
          return r; // clean → caller returns best
        }
        const reason = this.problemReason(r);
        this.logger.warn(
          `Extraction problem on ${label} for ${invoice.originalFilename}: ${reason} — trying fallback.`,
        );
        await record(source, 'problem', reason);
      } catch (error) {
        lastError = error;
        this.logger.warn(`${label} extraction failed: ${String(error)} — trying fallback.`);
        await record(source, 'error', this.humanizeGeminiError(error));
      }
      return null;
    };

    // Build the ordered list of vision attempts, leading with the selected
    // primary engine.
    const claudeAttempt = () =>
      tryVision('claude', () => this.extractWithClaude(invoice, bytes), `claude:${this.claude.model}`);
    const geminiPrimaryModel = this.engine.isClaude ? this.gemini.model : this.engine.model;
    const geminiAttempt = () =>
      tryVision(
        geminiPrimaryModel,
        () => this.extractWithGemini(invoice, bytes, geminiPrimaryModel),
        geminiPrimaryModel,
      );
    const geminiAltAttempt = () => {
      const alt = this.pickAltGeminiModel(geminiPrimaryModel);
      if (!alt) return Promise.resolve(null);
      return tryVision(
        `${alt} (retry)`,
        () => this.extractWithGemini(invoice, bytes, alt),
        `${alt} (retry)`,
      );
    };

    const order: Array<() => Promise<ExtractedInvoice | null>> = [];
    if (this.engine.isClaude) {
      if (this.claude.client) order.push(claudeAttempt);
      if (this.gemini.client) order.push(geminiAttempt, geminiAltAttempt);
    } else {
      if (this.gemini.client) order.push(geminiAttempt, geminiAltAttempt);
      if (this.claude.client) order.push(claudeAttempt);
    }

    for (const attempt of order) {
      const clean = await attempt();
      if (clean) return { data: this.best(attempts), log };
    }

    // --- Final fallback: GPT over the PDF's text layer (text-only, PDF only) ---
    const gptSource = `groq:${this.groq.defaultModel} (pdf-text)`;
    if (invoice.mimeType === 'application/pdf' && this.groq.client) {
      try {
        const text = await this.extractPdfText(bytes);
        if (text && text.trim().length > 20) {
          const r = await this.extractWithGpt(text);
          r.extractionSource = gptSource;
          attempts.push(r);
          await record(gptSource, this.detectProblem(r) ? 'problem' : 'ok', this.problemReason(r));
        } else {
          this.logger.warn(`PDF has no usable text layer for ${invoice.originalFilename}; GPT fallback skipped.`);
          await record(gptSource, 'skipped', 'no usable PDF text layer');
        }
      } catch (error) {
        lastError = error;
        this.logger.warn(`GPT pdf-text extraction failed: ${String(error)}.`);
        await record(gptSource, 'error', this.humanizeGeminiError(error));
      }
    }

    if (attempts.length === 0) {
      throw this.withLog(new Error(this.humanizeGeminiError(lastError)), log);
    }

    const winner = this.best(attempts);

    // The model reached a definitive verdict that this isn't usable (not an
    // invoice / empty / unreadable). Re-running won't change that, so mark it
    // TERMINAL — the worker fails it immediately instead of burning two more
    // retries on the same conclusion.
    if (winner.outcome && winner.outcome !== 'ok') {
      throw this.withLog(new Error(this.outcomeMessage(winner)), log, true);
    }

    // Too unreliable to trust: a very low confidence means the scan is poor and
    // the model likely guessed. Better to fail honestly ("couldn't read it
    // reliably") than to store hallucinated values. Terminal — a re-run of the
    // same poor scan would just guess again.
    if (typeof winner.confidence === 'number' && winner.confidence < MIN_CONFIDENCE) {
      throw this.withLog(
        new Error(
          'The scan is too poor to read reliably — extracted values may be inaccurate, ' +
            'so it was not saved. Try a clearer scan.',
        ),
        log,
        true,
      );
    }

    // Broken math is a reliable, deterministic sign the model misread digits
    // (e.g. on a low-resolution scan it invented a subtotal). Storing those
    // numbers would be misleading, so fail with a clear reason. Terminal — the
    // same scan will misread the same way on a retry.
    const math = this.brokenMath(winner);
    if (math) {
      throw this.withLog(
        new Error(
          `The extracted amounts don't add up — ${math}. The scan is likely too ` +
            'low-quality to read accurately; it was not saved. Try a clearer copy.',
        ),
        log,
        true,
      );
    }

    // Return the best attempt — it captured real data even if some fields are
    // missing; the low-confidence/warning UI flags any remaining gaps.
    return { data: winner, log };
  }

  /**
   * Attach the processing log (and an optional `terminal` flag) to an error.
   * `terminal` means a definitive AI verdict — don't retry; a non-terminal
   * error (quota/timeout/transient) is left for BullMQ to retry.
   */
  private withLog(err: Error, log: ProcessingAttempt[], terminal = false): Error {
    const e = err as Error & { processingLog?: ProcessingAttempt[]; terminal?: boolean };
    e.processingLog = log;
    e.terminal = terminal;
    return e;
  }

  /** A user-facing message for a non-ok extraction outcome (uses the model's reason). */
  private outcomeMessage(r: ExtractedInvoice): string {
    if (r.outcomeReason && r.outcomeReason.trim()) return r.outcomeReason.trim();
    switch (r.outcome) {
      case 'not_an_invoice':
        return 'This document does not appear to be an invoice.';
      case 'empty':
        return 'No invoice data could be extracted from this document.';
      case 'unreadable':
        return 'The document could not be read (too blurry, blank, or garbled).';
      default:
        return 'No usable invoice data could be extracted.';
    }
  }

  // ---- engines ----

  private async extractWithGemini(
    invoice: Invoice,
    bytes: Buffer,
    model: string,
  ): Promise<ExtractedInvoice> {
    const response = await this.gemini.client!.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: invoice.mimeType, data: bytes.toString('base64') } },
            { text: VISION_PROMPT },
          ],
        },
      ],
      config: { responseMimeType: 'application/json', responseSchema: INVOICE_SCHEMA },
    });
    const text = response.text;
    if (!text) throw new Error('Gemini returned an empty response.');
    return this.normalize(this.parseJson(text));
  }

  private async extractWithGpt(documentText: string): Promise<ExtractedInvoice> {
    const res = await this.groq.client!.chat.completions.create({
      model: this.groq.defaultModel,
      messages: [{ role: 'user', content: TEXT_PROMPT + documentText.slice(0, 12000) }],
      response_format: { type: 'json_object' },
    });
    const text = res.choices[0]?.message?.content;
    if (!text) throw new Error('GPT returned an empty response.');
    return this.normalize(this.parseJson(text));
  }

  /**
   * Claude Haiku vision extraction — reads PDFs (document block) and images
   * (image block) directly, then returns the structured JSON. A genuinely
   * different model family from Gemini, so it can rescue documents Gemini chokes
   * on, and (unlike the GPT text path) it works for image invoices too.
   */
  private async extractWithClaude(invoice: Invoice, bytes: Buffer): Promise<ExtractedInvoice> {
    const b64 = bytes.toString('base64');
    const isPdf = invoice.mimeType === 'application/pdf';
    const mediaBlock = isPdf
      ? {
          type: 'document' as const,
          source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: b64 },
        }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: invoice.mimeType as 'image/png' | 'image/jpeg',
            data: b64,
          },
        };

    const res = await this.claude.client!.messages.create({
      model: this.claude.model,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            mediaBlock,
            {
              type: 'text',
              text:
                TEXT_PROMPT.replace('Below is the raw text extracted from an invoice document.', 'The attached file is an invoice.').replace('\n\nDOCUMENT TEXT:\n', ''),
            },
          ],
        },
      ],
    });

    const text = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    if (!text) throw new Error('Claude returned an empty response.');
    return this.normalize(this.parseJson(text));
  }

  /** Pull the text layer out of a PDF (returns '' if it's scanned/imaged). */
  private async extractPdfText(bytes: Buffer): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      return result.text ?? '';
    } finally {
      await parser.destroy?.();
    }
  }

  // ---- quality / selection ----

  /** A result is "a problem" if it failed to capture an invoice meaningfully. */
  private detectProblem(r: ExtractedInvoice): boolean {
    return this.problemReason(r) !== null;
  }

  private problemReason(r: ExtractedInvoice): string | null {
    // The model's own verdict is the strongest signal — a non-ok outcome means
    // try the next engine (and, if none recover, the invoice is failed).
    if (r.outcome && r.outcome !== 'ok') return r.outcome;
    if (r.isInvoice === false) return 'not classified as an invoice';
    if (typeof r.confidence === 'number' && r.confidence < 0.6) return `low confidence ${r.confidence}`;
    const empty = (r.vendorName == null || r.vendorName === '') && r.total == null;
    if (empty) return 'no vendor and no total';
    const math = this.brokenMath(r);
    if (math) return math;
    return null;
  }

  /**
   * Returns a reason string if subtotal + tax doesn't match the total (a strong
   * sign the model misread digits on a poor scan), else null. Only checks when
   * all three numbers are present.
   */
  private brokenMath(r: ExtractedInvoice): string | null {
    if (
      typeof r.total === 'number' &&
      typeof r.subtotal === 'number' &&
      typeof r.tax === 'number'
    ) {
      const expected = r.subtotal + r.tax;
      if (Math.abs(expected - r.total) > Math.max(0.02, expected * 0.01)) {
        return `the numbers don't add up (subtotal ${r.subtotal} + tax ${r.tax} ≠ total ${r.total})`;
      }
    }
    return null;
  }

  /** Pick the best attempt: prefer no-problem, then higher confidence + more fields. */
  private best(attempts: ExtractedInvoice[]): ExtractedInvoice {
    return [...attempts].sort((a, b) => this.score(b) - this.score(a))[0];
  }

  private score(r: ExtractedInvoice): number {
    let s = 0;
    if (!this.detectProblem(r)) s += 100;
    s += (typeof r.confidence === 'number' ? r.confidence : 0) * 10;
    if (r.vendorName) s += 3;
    if (r.total != null) s += 3;
    if (r.invoiceNumber) s += 1;
    s += Math.min(r.lineItems?.length ?? 0, 10) * 0.5;
    return s;
  }

  private pickAltGeminiModel(current: string): string | null {
    const order = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];
    return order.find((m) => m !== current) ?? null;
  }

  // ---- parsing helpers ----

  private parseJson(text: string): ExtractedInvoice {
    // Strip a ```json fence if a model added one.
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try {
      return JSON.parse(cleaned) as ExtractedInvoice;
    } catch {
      throw new Error(`Model returned non-JSON output: ${text.slice(0, 200)}`);
    }
  }

  private normalize(parsed: ExtractedInvoice): ExtractedInvoice {
    if (!Array.isArray(parsed.lineItems)) parsed.lineItems = [];
    if (typeof parsed.isInvoice !== 'boolean') parsed.isInvoice = true;
    if (typeof parsed.confidence !== 'number') parsed.confidence = 1;
    parsed.docType ??= null;
    // Default the verdict when a model omits it: infer "empty" if nothing
    // useful was extracted, else trust it as "ok".
    if (!parsed.outcome) {
      const hasData =
        (parsed.vendorName != null && parsed.vendorName !== '') ||
        parsed.total != null ||
        parsed.lineItems.length > 0;
      parsed.outcome = hasData ? 'ok' : 'empty';
    }
    parsed.outcomeReason ??= null;
    // Backstop the AI's missingFields with a deterministic null-field scan, so
    // the "Missing: …" badge is reliable even if a model omits the array.
    if (!Array.isArray(parsed.missingFields)) parsed.missingFields = [];
    if (parsed.missingFields.length === 0) {
      const blank = (v: unknown) => v == null || v === '';
      const checks: Array<[string, boolean]> = [
        ['vendorName', blank(parsed.vendorName)],
        ['invoiceNumber', blank(parsed.invoiceNumber)],
        ['invoiceDate', blank(parsed.invoiceDate)],
        ['dueDate', blank(parsed.dueDate)],
        ['total', parsed.total == null],
        ['lineItems', parsed.lineItems.length === 0],
      ];
      parsed.missingFields = checks.filter(([, missing]) => missing).map(([name]) => name);
    }
    parsed.note ??= null;
    return parsed;
  }

  /** Turn raw Gemini SDK errors into a short, user-facing message. */
  private humanizeGeminiError(error: unknown): string {
    const raw =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const code = /\b(429|400|403|500|503)\b/.exec(raw)?.[1];
    const lower = raw.toLowerCase();

    if (code === '429' || lower.includes('quota') || lower.includes('rate limit')) {
      return 'AI quota exceeded — too many requests. Please retry in a minute.';
    }
    if (lower.includes('no pages') || lower.includes('could not process')) {
      return 'The file could not be read (corrupted or unsupported PDF).';
    }
    if (lower.includes('password') || lower.includes('encrypt')) {
      return 'The PDF is password-protected and cannot be read.';
    }
    if (code === '403') return 'AI request was rejected (check the API key).';
    if (code && ['500', '503'].includes(code)) {
      return 'The AI service is temporarily unavailable. Please retry.';
    }
    return `Extraction failed: ${raw.slice(0, 160)}`;
  }
}
