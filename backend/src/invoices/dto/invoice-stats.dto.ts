import { ApiProperty } from '@nestjs/swagger';
import { InvoiceStatus } from '../invoice.types';

export class CurrencySpendDto {
  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: 12450.5 })
  total: number;

  @ApiProperty({ example: 8 })
  count: number;

  @ApiProperty({ example: 1556.31, description: 'Average invoice total in this currency' })
  average: number;
}

export class VendorSpendDto {
  @ApiProperty({ example: 'Acme Corp' })
  vendor: string;

  @ApiProperty({ example: 'USD', description: 'Currency of this vendor total (never blended)' })
  currency: string;

  @ApiProperty({ example: 9300 })
  total: number;

  @ApiProperty({ example: 3 })
  count: number;
}

export class DayCountDto {
  @ApiProperty({ example: '2026-06-13' })
  day: string;

  @ApiProperty({ example: 4 })
  count: number;
}

/** Aggregate statistics over all invoices. */
export class InvoiceStatsDto {
  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({
    description: 'Count of invoices per status',
    example: { uploaded: 1, processing: 0, completed: 38, failed: 3 },
  })
  byStatus: Record<InvoiceStatus, number>;

  @ApiProperty({ type: [CurrencySpendDto] })
  byCurrency: CurrencySpendDto[];

  @ApiProperty({ type: [VendorSpendDto] })
  topVendors: VendorSpendDto[];

  @ApiProperty({ example: 5, description: 'Completed invoices past their due date' })
  overdue: number;

  @ApiProperty({
    example: 327.4,
    description: 'Average total for the dominant currency (never blends currencies)',
  })
  averageInvoiceValue: number;

  @ApiProperty({
    example: 'EUR',
    nullable: true,
    description: 'Currency that averageInvoiceValue is expressed in',
  })
  averageCurrency: string | null;

  @ApiProperty({ type: [DayCountDto] })
  overTime: DayCountDto[];
}
