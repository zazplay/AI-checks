import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { ExtractionService } from './extraction.service';
import { InvoiceProcessor } from './invoice.processor';

/**
 * Owns the BullMQ worker. Imports InvoicesModule (one-way) so the processor
 * can drive status transitions through InvoicesService — no circular dep,
 * because InvoicesModule only registers the queue, it doesn't consume it.
 */
@Module({
  imports: [InvoicesModule],
  providers: [InvoiceProcessor, ExtractionService],
})
export class ProcessingModule {}
