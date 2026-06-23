import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ExtractedInvoice, InvoiceStatus, ProcessingAttempt } from '../invoice.types';

@Entity('invoices')
export class Invoice {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: 'acme-invoice-2024.pdf' })
  @Column()
  originalFilename: string;

  /** Path on disk under UPLOAD_DIR. Not exposed in API responses. */
  @Column()
  storedPath: string;

  @ApiProperty({ example: 'application/pdf' })
  @Column()
  mimeType: string;

  @ApiProperty({ example: 12345 })
  @Column({ type: 'int' })
  fileSize: number;

  @ApiProperty({
    enum: ['uploaded', 'processing', 'completed', 'failed'],
    example: 'uploaded',
  })
  @Index()
  @Column({ type: 'varchar', default: 'uploaded' })
  status: InvoiceStatus;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  @Column({ type: 'jsonb', nullable: true })
  extractedData: ExtractedInvoice | null;

  /** Raw OCR text, kept for audit/debugging. */
  @Column({ type: 'text', nullable: true })
  rawText: string | null;

  /** Per-attempt processing log (cascade steps + retries) for full traceability. */
  @ApiProperty({ nullable: true, type: 'array', items: { type: 'object' } })
  @Column({ type: 'jsonb', nullable: true })
  processingLog: ProcessingAttempt[] | null;

  @ApiProperty({ nullable: true })
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @ApiProperty({ example: 0 })
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @ApiProperty()
  @Index()
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn()
  updatedAt: Date;
}
