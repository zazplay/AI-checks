import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { InvoicesService } from '../invoices/invoices.service';
import { ProcessingAttempt } from '../invoices/invoice.types';
import { ExtractionService } from './extraction.service';
import {
  INVOICE_QUEUE,
  INVOICE_WORKER_OPTIONS,
  InvoiceJobData,
} from './processing.constants';

/**
 * Drives an invoice through uploaded → processing → completed/failed.
 * BullMQ retries the job (attempts: 3, exponential backoff); only when all
 * retries are exhausted do we mark the invoice `failed`.
 *
 * Concurrency + a rate limiter (see INVOICE_WORKER_OPTIONS) act as the backend
 * processing queue that protects the AI provider's free-tier quota: bursts of
 * uploads are metered out a few per minute instead of all at once.
 */
@Processor(INVOICE_QUEUE, INVOICE_WORKER_OPTIONS)
export class InvoiceProcessor extends WorkerHost {
  private readonly logger = new Logger(InvoiceProcessor.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly extraction: ExtractionService,
  ) {
    super();
  }

  async process(job: Job<InvoiceJobData>): Promise<void> {
    const { invoiceId } = job.data;
    await this.invoices.markProcessing(invoiceId);

    const invoice = await this.invoices.findOne(invoiceId);
    // Live-append each cascade attempt to the processing log (broadcast via socket)
    // so the UI can show, in real time, which engine is being tried and why a
    // fallback/retry happened.
    try {
      const { data } = await this.extraction.extract(invoice, (attempt) =>
        this.invoices.appendProcessingLog(invoiceId, attempt),
      );
      await this.invoices.markCompleted(invoiceId, data);
      this.logger.log(`Extracted invoice ${invoiceId}`);
    } catch (error) {
      // A TERMINAL verdict (not an invoice / empty / unreadable) won't change on
      // a re-run, so stop BullMQ from burning further retries: rethrow as an
      // UnrecoverableError, which fails the job immediately. Transient errors
      // (quota/timeout/network) fall through and are retried as usual.
      if ((error as { terminal?: boolean }).terminal) {
        const wrapped = new UnrecoverableError((error as Error).message);
        (wrapped as Error & { processingLog?: unknown }).processingLog = (
          error as Error & { processingLog?: unknown }
        ).processingLog;
        throw wrapped;
      }
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<InvoiceJobData>, error: Error): Promise<void> {
    // Each cascade step was already appended live via appendProcessingLog, so
    // the running log persists across BullMQ retries (showing #1, #2, #3). If
    // extract() threw BEFORE any step was recorded (e.g. no engine configured),
    // backfill from the error's attached log so the failure is still explained.
    const log = (error as Error & { processingLog?: ProcessingAttempt[] }).processingLog;
    if (Array.isArray(log) && log.length > 0) {
      try {
        await this.invoices.appendMissingProcessingLog(job.data.invoiceId, log);
      } catch (e) {
        this.logger.warn(`Could not persist processing log: ${String(e)}`);
      }
    }

    // An UnrecoverableError won't be retried by BullMQ, so fail it now even if
    // attempts remain. Otherwise wait until every retry is exhausted.
    const terminal = error.name === 'UnrecoverableError';
    if (!terminal && job.attemptsMade < (job.opts.attempts ?? 1)) {
      this.logger.warn(
        `Invoice ${job.data.invoiceId} attempt ${job.attemptsMade} failed, will retry: ${error.message}`,
      );
      return;
    }
    this.logger.error(
      `Invoice ${job.data.invoiceId} failed ${terminal ? '(terminal verdict)' : 'permanently'}: ${error.message}`,
    );
    try {
      await this.invoices.markFailed(job.data.invoiceId, error.message);
    } catch (e) {
      this.logger.error(`Could not mark invoice failed: ${String(e)}`);
    }
  }
}
