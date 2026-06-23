import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { INVOICE_STATUSES, InvoiceStatus } from '../invoice.types';
import { InvoiceResponseDto } from './invoice-response.dto';

/** Sort keys the paginated list accepts — mirrors the table's column sorts. */
export const INVOICE_SORT_KEYS = [
  'originalFilename',
  'vendorName',
  'total',
  'status',
  'createdAt',
] as const;
export type InvoiceSortKey = (typeof INVOICE_SORT_KEYS)[number];

/**
 * Query for GET /invoices. When `page` is omitted the controller keeps the
 * legacy behavior (bare InvoiceResponseDto[] of the whole list); when `page` is
 * present it returns an InvoicePageDto. Numbers are transformed from the
 * querystring by the global ValidationPipe ({ transform: true }).
 */
export class ListInvoicesQueryDto {
  @ApiPropertyOptional({ minimum: 1, description: '1-based page; omit for the full (legacy) list.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: INVOICE_STATUSES })
  @IsOptional()
  @IsIn(INVOICE_STATUSES)
  status?: InvoiceStatus;

  @ApiPropertyOptional({ description: 'Free-text across filename / vendor / invoice number.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: INVOICE_SORT_KEYS, default: 'createdAt' })
  @IsOptional()
  @IsIn(INVOICE_SORT_KEYS)
  sort?: InvoiceSortKey;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';
}

/** One page of invoices plus the total count for the active filter. */
export class InvoicePageDto {
  @ApiProperty({ type: InvoiceResponseDto, isArray: true })
  items: InvoiceResponseDto[];

  @ApiProperty({ example: 137, description: 'Total rows matching the filter (not just this page).' })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  limit: number;
}
