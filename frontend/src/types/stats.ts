import type { InvoiceStatus } from './invoice';

export interface CurrencySpend {
  currency: string;
  total: number;
  count: number;
  average: number;
}

export interface VendorSpend {
  vendor: string;
  currency: string;
  total: number;
  count: number;
}

export interface DayCount {
  day: string;
  count: number;
}

/** Mirrors backend/src/invoices/dto/invoice-stats.dto.ts */
export interface InvoiceStats {
  total: number;
  byStatus: Record<InvoiceStatus, number>;
  byCurrency: CurrencySpend[];
  topVendors: VendorSpend[];
  overdue: number;
  averageInvoiceValue: number;
  averageCurrency: string | null;
  overTime: DayCount[];
}
