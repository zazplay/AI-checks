import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { EventsGateway } from '../events/events.gateway';
import { StorageService } from '../storage/storage.service';
import {
  INVOICE_QUEUE,
  InvoiceJobData,
  QUEUE_BACKPRESSURE_LIMIT,
} from '../processing/processing.constants';
import { InvoiceStatsDto } from './dto/invoice-stats.dto';
import { InvoiceSortKey } from './dto/invoice-page.dto';
import { Invoice } from './entities/invoice.entity';
import {
  EditableInvoiceFields,
  EDITABLE_INVOICE_FIELDS,
  ExportFilter,
  ExtractedInvoice,
  INVOICE_STATUSES,
  InvoiceFilter,
  InvoiceStatus,
  ProcessingAttempt,
} from './invoice.types';

/**
 * A safety cap applied to every finder query that could otherwise return the
 * whole table. Filtering + sorting now happen in SQL, but we still never
 * materialize an unbounded result set into Node memory (which OOMs at ~100k
 * rows) or feed an unbounded list to the assistant's LLM context. A caller may
 * request a smaller limit; it can never exceed this.
 */
const MAX_FINDER_ROWS = 1000;

// jsonb `->>` yields text, so a numeric/date cast must be guarded by a regex to
// avoid casting malformed values from imperfect extractions (same convention as
// getStats). These match a column expression that resolves to the jsonb text.
const NUMERIC_RE = `^-?[0-9]+(\\.[0-9]+)?$`;
const ISO_DATE_RE = `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoices: Repository<Invoice>,
    @InjectQueue(INVOICE_QUEUE)
    private readonly queue: Queue<InvoiceJobData>,
    private readonly events: EventsGateway,
    private readonly storage: StorageService,
  ) {}

  /** Persist a freshly uploaded file and enqueue it for async processing. */
  async createFromUpload(file: Express.Multer.File): Promise<Invoice> {
    // Backpressure: reject early (before writing the file) when the processing
    // queue is already saturated, so a burst can't pile up an undrainable
    // backlog. The client backs off and retries instead of silently waiting.
    await this.assertQueueHasRoom();

    // The file is buffered in memory by multer; StorageService writes it to disk
    // or S3 and returns the reference we persist as storedPath.
    const storedPath = await this.storage.save(
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    const invoice = await this.invoices.save(
      this.invoices.create({
        originalFilename: file.originalname,
        storedPath,
        mimeType: file.mimetype,
        fileSize: file.size,
        status: 'uploaded',
        attempts: 0,
      }),
    );
    this.events.emitCreated(invoice);
    await this.enqueue(invoice.id);
    return invoice;
  }

  /** List invoices, newest first, optionally filtered by status. */
  async findAll(status?: InvoiceStatus): Promise<Invoice[]> {
    return this.invoices.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * One page of invoices for the main table, filtered + sorted + counted in SQL
   * so the client never loads the whole table. `total` is the count for the
   * active filter (status + search), independent of the page window.
   */
  async findPaginated(opts: {
    page: number;
    limit: number;
    status?: InvoiceStatus;
    search?: string;
    sort: InvoiceSortKey;
    dir: 'asc' | 'desc';
  }): Promise<{ items: Invoice[]; total: number; page: number; limit: number }> {
    const ed = `i."extractedData"`;
    const qb = this.invoices.createQueryBuilder('i');

    if (opts.status) qb.andWhere('i.status = :status', { status: opts.status });
    if (opts.search && opts.search.trim()) {
      const q = `%${opts.search.trim()}%`;
      qb.andWhere(
        `(i.originalFilename ILIKE :q OR ${ed}->>'vendorName' ILIKE :q OR ${ed}->>'invoiceNumber' ILIKE :q)`,
        { q },
      );
    }

    // Count the filtered set before windowing/ordering (ORDER BY is irrelevant
    // to a COUNT and skip/take would wrongly shrink it).
    const total = await qb.getCount();

    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    switch (opts.sort) {
      case 'originalFilename':
        qb.orderBy('LOWER(i.originalFilename)', dir);
        break;
      case 'vendorName':
        qb.orderBy(`LOWER(${ed}->>'vendorName')`, dir, 'NULLS LAST');
        break;
      case 'total': {
        // Group by currency first (alphabetical) so £ and € are never compared
        // as raw numbers, then by the guarded numeric total within each currency
        // — preserves the table's existing cross-currency sort semantics.
        const safeTotal = `CASE WHEN ${ed}->>'total' ~ :sortNum THEN (${ed}->>'total')::numeric END`;
        qb.setParameter('sortNum', NUMERIC_RE)
          .orderBy(`COALESCE(${ed}->>'currency', '')`, 'ASC')
          .addOrderBy(safeTotal, dir, 'NULLS LAST');
        break;
      }
      case 'status':
        qb.orderBy('i.status', dir);
        break;
      case 'createdAt':
      default:
        qb.orderBy('i.createdAt', dir);
        break;
    }
    // Deterministic tiebreaker so equal sort values don't shuffle across pages.
    qb.addOrderBy('i.id', 'ASC');

    const items = await qb
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit)
      .getMany();

    return { items, total, page: opts.page, limit: opts.limit };
  }

  async findOne(id: string): Promise<Invoice> {
    const invoice = await this.invoices.findOne({ where: { id } });
    if (!invoice) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    return invoice;
  }

  /** Free-text search across filename, vendor name and invoice number. */
  async search(query: string): Promise<Invoice[]> {
    const q = `%${query}%`;
    return this.invoices
      .createQueryBuilder('i')
      .where('i.originalFilename ILIKE :q', { q })
      .orWhere(`i."extractedData"->>'vendorName' ILIKE :q`, { q })
      .orWhere(`i."extractedData"->>'invoiceNumber' ILIKE :q`, { q })
      .orderBy('i.createdAt', 'DESC')
      .limit(50)
      .getMany();
  }

  /**
   * Invoices that produced no useful extracted data — either no extractedData
   * at all, or it has neither a vendor name nor a total. These are the "empty"
   * invoices (blank pages, non-invoice docs that still completed).
   */
  async findEmpty(limit = MAX_FINDER_ROWS): Promise<Invoice[]> {
    // Empty = no extractedData at all, OR (no vendor name AND no total). Pushed
    // to SQL so we never load the whole table to count blanks.
    const noVendor = `(i."extractedData"->>'vendorName' IS NULL OR i."extractedData"->>'vendorName' = '')`;
    const noTotal = `i."extractedData"->>'total' IS NULL`;
    return this.invoices
      .createQueryBuilder('i')
      .where('i."extractedData" IS NULL')
      .orWhere(`(${noVendor} AND ${noTotal})`)
      .orderBy('i.createdAt', 'DESC')
      .limit(this.cap(limit))
      .getMany();
  }

  /** Clamp any caller-supplied limit to the hard safety cap (and a sane floor). */
  private cap(limit?: number): number {
    if (limit == null || !Number.isFinite(limit) || limit <= 0) return MAX_FINDER_ROWS;
    return Math.min(Math.floor(limit), MAX_FINDER_ROWS);
  }

  /**
   * Query invoices by amount: optional min/max total bounds, optional vendor
   * substring, sorted by total (asc/desc) or date, with an optional limit.
   * Done in TS over the jsonb data so null/non-numeric totals are handled
   * safely (invoices without a numeric total are excluded from amount queries).
   */
  async queryByAmount(opts: {
    sort?: 'amount_asc' | 'amount_desc' | 'date_desc';
    minTotal?: number;
    maxTotal?: number;
    vendor?: string;
    limit?: number;
  }): Promise<Invoice[]> {
    // A numeric total is required whenever the query sorts or bounds by amount;
    // the regex guard keeps the ::numeric cast from throwing on bad text.
    const wantsAmount =
      opts.sort === 'amount_asc' ||
      opts.sort === 'amount_desc' ||
      opts.minTotal != null ||
      opts.maxTotal != null;

    const qb = this.invoices.createQueryBuilder('i');
    const totalExpr = `(i."extractedData"->>'total')::numeric`;

    if (wantsAmount) {
      qb.andWhere(`i."extractedData"->>'total' ~ :num`, { num: NUMERIC_RE });
      if (opts.minTotal != null) qb.andWhere(`${totalExpr} >= :min`, { min: opts.minTotal });
      if (opts.maxTotal != null) qb.andWhere(`${totalExpr} <= :max`, { max: opts.maxTotal });
    }
    if (opts.vendor) {
      qb.andWhere(`i."extractedData"->>'vendorName' ILIKE :v`, { v: `%${opts.vendor}%` });
    }

    if (opts.sort === 'amount_asc') qb.orderBy(totalExpr, 'ASC');
    else if (opts.sort === 'amount_desc') qb.orderBy(totalExpr, 'DESC');
    else qb.orderBy('i.createdAt', 'DESC');

    return qb.limit(this.cap(opts.limit)).getMany();
  }

  /**
   * Resolve a set of invoices for export, applying the same filters the UI and
   * the assistant use: status, vendor substring, min/max total, and a free-text
   * search across filename / vendor / invoice number. Newest first.
   */
  async queryForExport(filter: ExportFilter): Promise<Invoice[]> {
    const qb = this.invoices.createQueryBuilder('i');
    if (filter.status) qb.andWhere('i.status = :status', { status: filter.status });

    if (filter.search && filter.search.trim()) {
      const q = `%${filter.search.trim()}%`;
      qb.andWhere(
        `(i.originalFilename ILIKE :q OR i."extractedData"->>'vendorName' ILIKE :q OR i."extractedData"->>'invoiceNumber' ILIKE :q)`,
        { q },
      );
    }
    if (filter.vendor && filter.vendor.trim()) {
      qb.andWhere(`i."extractedData"->>'vendorName' ILIKE :v`, { v: `%${filter.vendor.trim()}%` });
    }
    if (filter.minTotal != null || filter.maxTotal != null) {
      const totalExpr = `(i."extractedData"->>'total')::numeric`;
      qb.andWhere(`i."extractedData"->>'total' ~ :num`, { num: NUMERIC_RE });
      if (filter.minTotal != null) qb.andWhere(`${totalExpr} >= :min`, { min: filter.minTotal });
      if (filter.maxTotal != null) qb.andWhere(`${totalExpr} <= :max`, { max: filter.maxTotal });
    }

    // Cap the export too: streaming 100k originals into a single zip/xlsx is the
    // same OOM class. Log if we truncate so a huge export isn't silently partial.
    const rows = await qb.orderBy('i.createdAt', 'DESC').limit(MAX_FINDER_ROWS + 1).getMany();
    if (rows.length > MAX_FINDER_ROWS) {
      this.logger.warn(
        `Export matched more than ${MAX_FINDER_ROWS} invoices; truncating to ${MAX_FINDER_ROWS}. Narrow the filter for a complete export.`,
      );
      return rows.slice(0, MAX_FINDER_ROWS);
    }
    return rows;
  }

  /**
   * Targeted invoice filter for the assistant: status, vendor, amount range,
   * currency, issue/due dates, overdue, problem/empty flags, and a line-item
   * text match — all ANDed. Runs in TS over the jsonb so null/non-numeric
   * values never throw. Returns the matched rows (full entities) so the caller
   * can analyse just the needed subset instead of the whole dataset.
   */
  async filterInvoices(filter: InvoiceFilter): Promise<Invoice[]> {
    const ed = `i."extractedData"`;
    const qb = this.invoices.createQueryBuilder('i');

    if (filter.status) qb.andWhere('i.status = :status', { status: filter.status });

    if (filter.minTotal != null || filter.maxTotal != null) {
      // A numeric total is required (matches the old `typeof total !== 'number'`
      // exclusion); the regex guard keeps the cast safe on malformed text.
      qb.andWhere(`${ed}->>'total' ~ :num`, { num: NUMERIC_RE });
      const totalExpr = `(${ed}->>'total')::numeric`;
      if (filter.minTotal != null) qb.andWhere(`${totalExpr} >= :min`, { min: filter.minTotal });
      if (filter.maxTotal != null) qb.andWhere(`${totalExpr} <= :max`, { max: filter.maxTotal });
    }

    if (filter.vendor) {
      qb.andWhere(`${ed}->>'vendorName' ILIKE :vendor`, { vendor: `%${filter.vendor}%` });
    }
    if (filter.currency) {
      qb.andWhere(`LOWER(${ed}->>'currency') = LOWER(:currency)`, { currency: filter.currency });
    }

    // Date comparisons stay string-based to mirror the original (ISO dates sort
    // lexicographically); a NULL invoiceDate/dueDate excludes the row as before.
    if (filter.issuedAfter) {
      qb.andWhere(`${ed}->>'invoiceDate' IS NOT NULL AND ${ed}->>'invoiceDate' >= :ia`, {
        ia: filter.issuedAfter,
      });
    }
    if (filter.issuedBefore) {
      qb.andWhere(`${ed}->>'invoiceDate' IS NOT NULL AND ${ed}->>'invoiceDate' <= :ib`, {
        ib: filter.issuedBefore,
      });
    }
    if (filter.dueBefore) {
      qb.andWhere(`${ed}->>'dueDate' IS NOT NULL AND ${ed}->>'dueDate' <= :db`, {
        db: filter.dueBefore,
      });
    }
    if (filter.overdue) {
      // completed + a dueDate strictly before today (string compare, like before).
      const today = new Date().toISOString().slice(0, 10);
      qb.andWhere(`i.status = 'completed'`)
        .andWhere(`${ed}->>'dueDate' IS NOT NULL`)
        .andWhere(`${ed}->>'dueDate' < :today`, { today });
    }

    if (filter.empty) {
      qb.andWhere(`(${ed}->>'vendorName' IS NULL OR ${ed}->>'vendorName' = '')`).andWhere(
        `${ed}->>'total' IS NULL`,
      );
    }
    if (filter.hasProblem) {
      // failed | no data | not-an-invoice | low confidence | non-ok outcome | missing fields.
      qb.andWhere(
        `(
          i.status = 'failed'
          OR ${ed} IS NULL
          OR (${ed}->>'isInvoice') = 'false'
          OR (${ed}->>'confidence' ~ :num2 AND (${ed}->>'confidence')::numeric < 0.6)
          OR (${ed}->>'outcome' IS NOT NULL AND ${ed}->>'outcome' <> 'ok')
          OR jsonb_array_length(COALESCE(${ed}->'missingFields', '[]'::jsonb)) > 0
        )`,
        { num2: NUMERIC_RE },
      );
    }
    if (filter.lineItem) {
      // Match any line item's description (case-insensitive) without unnesting in
      // Node: EXISTS over the jsonb array elements.
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(${ed}->'lineItems', '[]'::jsonb)) AS li
          WHERE li->>'description' ILIKE :li
        )`,
        { li: `%${filter.lineItem}%` },
      );
    }
    if (filter.search) {
      const q = `%${filter.search}%`;
      qb.andWhere(
        `(i.originalFilename ILIKE :s OR ${ed}->>'vendorName' ILIKE :s OR ${ed}->>'invoiceNumber' ILIKE :s)`,
        { s: q },
      );
    }

    // Sort by amount when asked. The CASE only casts totals that pass the
    // numeric regex (malformed text → NULL), so ORDER BY can never throw;
    // NULLS LAST keeps non-numeric rows from leading. Else newest-first.
    if (filter.sort === 'amount_asc' || filter.sort === 'amount_desc') {
      const safeTotal = `CASE WHEN ${ed}->>'total' ~ :sortNum THEN (${ed}->>'total')::numeric END`;
      qb.setParameter('sortNum', NUMERIC_RE).orderBy(
        safeTotal,
        filter.sort === 'amount_asc' ? 'ASC' : 'DESC',
        'NULLS LAST',
      );
    } else {
      qb.orderBy('i.createdAt', 'DESC');
    }

    return qb.limit(this.cap(filter.limit)).getMany();
  }

  /** Aggregate statistics over all invoices (used by the dashboard + assistant). */
  async getStats(): Promise<InvoiceStatsDto> {
    const repo = this.invoices;
    // jsonb `->>` yields text, so every numeric/date cast is guarded by a regex
    // to avoid casting malformed values from imperfect extractions.
    const numeric = `i."extractedData"->>'total' ~ '^[0-9]+(\\.[0-9]+)?$'`;
    const isoDate = `i."extractedData"->>'dueDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;

    const byStatusRaw = await repo
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('i.status')
      .getRawMany<{ status: InvoiceStatus; count: string }>();

    const byStatus = INVOICE_STATUSES.reduce(
      (acc, s) => {
        acc[s] = 0;
        return acc;
      },
      {} as Record<InvoiceStatus, number>,
    );
    let total = 0;
    for (const row of byStatusRaw) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    const byCurrencyRaw = await repo
      .createQueryBuilder('i')
      .select(`COALESCE(i."extractedData"->>'currency', 'UNKNOWN')`, 'currency')
      .addSelect(`SUM((i."extractedData"->>'total')::numeric)`, 'total')
      .addSelect('COUNT(*)', 'count')
      .where('i.status = :s', { s: 'completed' })
      .andWhere(numeric)
      .groupBy('currency')
      .orderBy('total', 'DESC')
      .getRawMany<{ currency: string; total: string; count: string }>();

    // Per-currency totals/counts, plus the average for that currency — we never
    // blend currencies (a £100 and a €100 invoice are NOT 200 of anything).
    const byCurrency = byCurrencyRaw.map((r) => ({
      currency: r.currency,
      total: Number(r.total),
      count: Number(r.count),
      average: Number(r.count) > 0 ? Number(r.total) / Number(r.count) : 0,
    }));

    // Top vendors grouped by (vendor, currency) so a vendor billing in two
    // currencies appears as two rows rather than summing GBP+EUR into one bar.
    const topVendorsRaw = await repo
      .createQueryBuilder('i')
      .select(`i."extractedData"->>'vendorName'`, 'vendor')
      .addSelect(`COALESCE(i."extractedData"->>'currency', 'UNKNOWN')`, 'currency')
      .addSelect(`SUM((i."extractedData"->>'total')::numeric)`, 'total')
      .addSelect('COUNT(*)', 'count')
      .where('i.status = :s', { s: 'completed' })
      .andWhere(`i."extractedData"->>'vendorName' IS NOT NULL`)
      .andWhere(numeric)
      .groupBy('vendor')
      .addGroupBy('currency')
      .orderBy('total', 'DESC')
      .limit(5)
      .getRawMany<{ vendor: string; currency: string; total: string; count: string }>();

    const topVendors = topVendorsRaw.map((r) => ({
      vendor: r.vendor,
      currency: r.currency,
      total: Number(r.total),
      count: Number(r.count),
    }));

    const overdue = await repo
      .createQueryBuilder('i')
      .where('i.status = :s', { s: 'completed' })
      .andWhere(isoDate)
      .andWhere(`(i."extractedData"->>'dueDate')::date < CURRENT_DATE`)
      .getCount();

    // Average is reported for the dominant currency only (the one with the most
    // spend, i.e. byCurrency[0] since it's ordered by total DESC). Blending an
    // average across currencies would be meaningless. The currency label is
    // returned alongside so the UI never hardcodes a symbol.
    const dominant = byCurrency[0];
    const averageInvoiceValue = dominant?.average ?? 0;
    const averageCurrency = dominant?.currency ?? null;

    const overTimeRaw = await repo
      .createQueryBuilder('i')
      .select(`to_char(i."createdAt", 'YYYY-MM-DD')`, 'day')
      .addSelect('COUNT(*)', 'count')
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; count: string }>();

    const overTime = overTimeRaw.map((r) => ({
      day: r.day,
      count: Number(r.count),
    }));

    return {
      total,
      byStatus,
      byCurrency,
      topVendors,
      overdue,
      averageInvoiceValue: Math.round(averageInvoiceValue * 100) / 100,
      averageCurrency,
      overTime,
    };
  }

  /**
   * Per-invoice totals as a series (for a price trend line), oldest→newest so a
   * line chart reads left-to-right in time. Only completed invoices with a
   * numeric total. One query, computed in TS.
   */
  async getInvoiceTotalsSeries(): Promise<
    Array<{ label: string; total: number; currency: string | null }>
  > {
    const all = await this.findAll();
    return all
      .filter((i) => typeof i.extractedData?.total === 'number')
      .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
      .map((i) => ({
        label:
          i.extractedData?.invoiceNumber ||
          i.extractedData?.vendorName ||
          i.originalFilename,
        total: i.extractedData!.total as number,
        currency: i.extractedData?.currency ?? null,
      }));
  }

  /**
   * Aggregate line items into top products by total amount spent, across all
   * invoices. One pass over the dataset in TS (line items live in jsonb).
   */
  async getTopProducts(
    limit = 10,
  ): Promise<
    Array<{ description: string; currency: string; totalAmount: number; quantity: number; count: number }>
  > {
    const all = await this.findAll();
    // Key on (description, currency) so amounts in different currencies are
    // never summed together into one product total.
    const byDesc = new Map<
      string,
      { description: string; currency: string; totalAmount: number; quantity: number; count: number }
    >();
    for (const inv of all) {
      const currency = inv.extractedData?.currency ?? 'UNKNOWN';
      for (const li of inv.extractedData?.lineItems ?? []) {
        const desc = (li.description ?? '').trim();
        if (!desc) continue;
        const key = `${desc.toLowerCase()}|${currency}`;
        const row =
          byDesc.get(key) ?? { description: desc, currency, totalAmount: 0, quantity: 0, count: 0 };
        row.totalAmount += typeof li.amount === 'number' ? li.amount : 0;
        row.quantity += typeof li.quantity === 'number' ? li.quantity : 0;
        row.count += 1;
        byDesc.set(key, row);
      }
    }
    return [...byDesc.values()]
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, limit)
      .map((r) => ({ ...r, totalAmount: Math.round(r.totalAmount * 100) / 100 }));
  }

  /** Delete the invoice row, then best-effort remove its stored file. */
  async remove(id: string): Promise<void> {
    const invoice = await this.findOne(id);
    await this.invoices.remove(invoice);
    // Storage handles disk vs S3 and swallows "not found" internally.
    await this.storage.remove(invoice.storedPath);
  }

  /** Re-queue a failed invoice. Guards against retrying non-failed ones. */
  async retry(id: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status !== 'failed') {
      throw new BadRequestException(
        `Only failed invoices can be retried (current status: ${invoice.status}).`,
      );
    }
    invoice.status = 'uploaded';
    invoice.errorMessage = null;
    invoice.processingLog = null; // fresh run — clear the previous attempt log
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
    await this.enqueue(saved.id);
    return saved;
  }

  /**
   * Re-run extraction on an invoice from ANY status (unlike retry, which is
   * failed-only). Used to "re-check"/"read again" a completed invoice whose
   * data looks wrong. Keeps the existing extractedData until the new run
   * overwrites it on success.
   */
  async reprocess(id: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status === 'processing' || invoice.status === 'uploaded') {
      throw new BadRequestException(
        `Invoice is already ${invoice.status}; wait for it to finish before re-checking.`,
      );
    }
    invoice.status = 'uploaded';
    invoice.errorMessage = null;
    invoice.processingLog = null;
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
    await this.enqueue(saved.id);
    return saved;
  }

  /**
   * Correct extracted fields on an invoice (manual/assistant edit). Only the
   * whitelisted EDITABLE_INVOICE_FIELDS are written; unknown keys are rejected.
   * The invoice must already have extractedData (you can't edit what wasn't
   * extracted). Emits an update so the UI reflects the change live.
   */
  async updateExtractedFields(
    id: string,
    patch: EditableInvoiceFields,
  ): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (!invoice.extractedData) {
      throw new BadRequestException(
        'This invoice has no extracted data to edit yet.',
      );
    }
    const keys = Object.keys(patch) as (keyof EditableInvoiceFields)[];
    const bad = keys.filter((k) => !EDITABLE_INVOICE_FIELDS.includes(k));
    if (bad.length > 0) {
      throw new BadRequestException(`Cannot edit field(s): ${bad.join(', ')}.`);
    }
    if (keys.length === 0) {
      throw new BadRequestException('No fields to update.');
    }
    // Apply only provided keys; a key set to null clears that field.
    invoice.extractedData = { ...invoice.extractedData, ...patch };
    // A correction means we no longer consider those fields "missing".
    if (Array.isArray(invoice.extractedData.missingFields)) {
      invoice.extractedData.missingFields = invoice.extractedData.missingFields.filter(
        (f) => !keys.includes(f as keyof EditableInvoiceFields),
      );
    }
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
    return saved;
  }

  /**
   * Re-queue every failed invoice, then (in the background) wait for processing
   * to settle and delete any that failed AGAIN. This expresses the user intent
   * "retry the failed ones, and if they still fail, delete them" across the
   * async processing boundary — the assistant can't observe the second failure
   * within one synchronous turn, so a watcher handles it server-side.
   *
   * Returns immediately with the list it re-queued; cleanup runs detached and
   * surfaces results over the existing Socket.IO invoice events (deletions emit
   * `invoice.deleted`, so the UI updates live).
   */
  async retryFailedThenCleanup(): Promise<{ retried: Invoice[] }> {
    const failed = await this.findAll('failed');
    const retried: Invoice[] = [];
    for (const inv of failed) {
      try {
        retried.push(await this.retry(inv.id));
      } catch {
        // Slipped out of 'failed' between the list and the retry — skip.
      }
    }
    if (retried.length > 0) {
      // Detached: do not block the assistant response on processing.
      void this.watchAndDeleteStillFailing(retried.map((i) => i.id));
    }
    return { retried };
  }

  /**
   * Poll the given invoices until each settles (out of uploaded/processing) or
   * a deadline passes, then delete those still in `failed`. Best-effort and
   * self-contained; errors are logged, never thrown (it runs detached).
   */
  private async watchAndDeleteStillFailing(ids: string[]): Promise<void> {
    const DEADLINE_MS = 90_000; // generous: 3 queue attempts + exponential backoff
    const POLL_MS = 3_000;
    const start = Date.now();
    const pending = new Set(ids);

    try {
      while (pending.size > 0 && Date.now() - start < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        for (const id of [...pending]) {
          let inv: Invoice;
          try {
            inv = await this.findOne(id);
          } catch {
            pending.delete(id); // already gone
            continue;
          }
          if (inv.status === 'completed') {
            pending.delete(id); // recovered — keep it
          } else if (inv.status === 'failed') {
            pending.delete(id);
            try {
              await this.remove(id);
              this.events.emitDeleted(id);
              this.logger.log(`Cleanup: deleted still-failing invoice ${id}.`);
            } catch (error) {
              this.logger.warn(`Cleanup: could not delete ${id}: ${String(error)}`);
            }
          }
          // else still uploaded/processing — keep polling
        }
      }
      if (pending.size > 0) {
        this.logger.warn(
          `Cleanup watcher timed out with ${pending.size} invoice(s) still processing.`,
        );
      }
    } catch (error) {
      this.logger.warn(`Cleanup watcher error: ${String(error)}`);
    }
  }

  // ---- methods used by the processing worker ----

  /** Mark processing started; increments the attempt counter. */
  async markProcessing(id: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    invoice.status = 'processing';
    invoice.attempts += 1;
    invoice.errorMessage = null;
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
    return saved;
  }

  async markCompleted(id: string, data: ExtractedInvoice): Promise<Invoice> {
    const invoice = await this.findOne(id);
    invoice.status = 'completed';
    invoice.extractedData = data;
    invoice.errorMessage = null;
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
    return saved;
  }

  async markFailed(id: string, message: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    invoice.status = 'failed';
    invoice.errorMessage = message;
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
    return saved;
  }

  /** Append one processing-log step and broadcast it live (during processing). */
  async appendProcessingLog(id: string, attempt: ProcessingAttempt): Promise<void> {
    const invoice = await this.findOne(id);
    invoice.processingLog = [...(invoice.processingLog ?? []), attempt];
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
  }

  /**
   * Backfill any log entries the failed handler holds that weren't already
   * persisted live (dedup by timestamp+engine), so nothing is lost if a step
   * threw before its live append landed.
   */
  async appendMissingProcessingLog(id: string, log: ProcessingAttempt[]): Promise<void> {
    const invoice = await this.findOne(id);
    const existing = invoice.processingLog ?? [];
    const seen = new Set(existing.map((a) => `${a.at}|${a.engine}`));
    const missing = log.filter((a) => !seen.has(`${a.at}|${a.engine}`));
    if (missing.length === 0) return;
    invoice.processingLog = [...existing, ...missing];
    const saved = await this.invoices.save(invoice);
    this.events.emitUpdated(saved);
  }

  /**
   * Throw 429 when the processing queue is already at its backpressure limit
   * (waiting + delayed + active jobs). Fail-open: if the count itself errors
   * (e.g. a transient Redis blip) we let the upload through rather than block
   * legitimate traffic on a monitoring failure.
   */
  private async assertQueueHasRoom(): Promise<void> {
    let pending: number;
    try {
      const [waiting, delayed, active] = await Promise.all([
        this.queue.getWaitingCount(),
        this.queue.getDelayedCount(),
        this.queue.getActiveCount(),
      ]);
      pending = waiting + delayed + active;
    } catch (error) {
      this.logger.warn(`Queue depth check failed; allowing upload. ${String(error)}`);
      return;
    }
    if (pending >= QUEUE_BACKPRESSURE_LIMIT) {
      throw new HttpException(
        `Processing queue is full (${pending} pending). Please wait for invoices to finish and retry.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async enqueue(invoiceId: string): Promise<void> {
    await this.queue.add(
      'process',
      { invoiceId },
      {
        // Exponential backoff (5s, 10s, 20s) gives transient AI rate limits
        // time to clear before the invoice is marked failed.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}
