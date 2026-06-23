import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNumber, IsOptional, IsString, ValidateIf } from 'class-validator';
import { EditableInvoiceFields } from '../invoice.types';

/**
 * Correctable extracted fields. Only these scalar business fields may be edited
 * (line items and classification fields are off-limits). Each is optional and
 * nullable — a provided `null` clears the field. `ValidateIf(v !== null)` lets
 * the type validators coexist with an explicit null.
 */
export class UpdateInvoiceDto implements EditableInvoiceFields {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  vendorName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  invoiceNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO date (YYYY-MM-DD)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  invoiceDate?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO date (YYYY-MM-DD)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  dueDate?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO 4217 code, e.g. EUR' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  currency?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  subtotal?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  tax?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  total?: number | null;
}
