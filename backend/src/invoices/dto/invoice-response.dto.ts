import { ApiProperty } from '@nestjs/swagger';
import { Invoice } from '../entities/invoice.entity';
import { ExtractedInvoice, InvoiceStatus, ProcessingAttempt } from '../invoice.types';

/** What the API returns for an invoice (internal fields stripped). */
export class InvoiceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'acme-invoice-2024.pdf' })
  originalFilename: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType: string;

  @ApiProperty({ example: 12345 })
  fileSize: number;

  @ApiProperty({
    enum: ['uploaded', 'processing', 'completed', 'failed'],
    example: 'uploaded',
  })
  status: InvoiceStatus;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  extractedData: ExtractedInvoice | null;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({ example: 0 })
  attempts: number;

  @ApiProperty({ nullable: true, type: 'array', items: { type: 'object' } })
  processingLog: ProcessingAttempt[] | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static fromEntity(invoice: Invoice): InvoiceResponseDto {
    return {
      id: invoice.id,
      originalFilename: invoice.originalFilename,
      mimeType: invoice.mimeType,
      fileSize: invoice.fileSize,
      status: invoice.status,
      extractedData: invoice.extractedData,
      errorMessage: invoice.errorMessage,
      attempts: invoice.attempts,
      processingLog: invoice.processingLog ?? null,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  }
}
