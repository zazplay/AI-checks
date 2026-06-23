import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Invoice, InvoicePageParams } from '../types/invoice';

export const invoiceKeys = {
  /** The full-list cache: id-lookups, socket upserts, optimistic mutations. */
  all: ['invoices'] as const,
  /** Prefix for every paginated page query (used for bulk invalidation). */
  pages: ['invoices', 'page'] as const,
  /** One specific page+filter+sort combination. */
  page: (p: InvoicePageParams) => ['invoices', 'page', p] as const,
};

export function useInvoices() {
  return useQuery({ queryKey: invoiceKeys.all, queryFn: () => api.listInvoices() });
}

/**
 * One page of the invoice list for the main table. Separate from the full-list
 * cache so the table loads only its own page; `keepPreviousData` keeps the old
 * rows visible during a page/sort/search transition instead of flashing empty.
 */
export function useInvoicesPage(params: InvoicePageParams) {
  return useQuery({
    queryKey: invoiceKeys.page(params),
    queryFn: () => api.listInvoicesPage(params),
    placeholderData: keepPreviousData,
  });
}

/**
 * Single source of truth for mutating the invoice list cache. Upserts by id and
 * always de-dupes, so no code path (socket push, optimistic upload, retry) can
 * ever leave two rows with the same id. Newest stays on top.
 */
export function upsertInvoice(qc: QueryClient, incoming: Invoice): void {
  qc.setQueryData<Invoice[]>(invoiceKeys.all, (prev) => {
    const rest = (prev ?? []).filter((i) => i.id !== incoming.id);
    return [incoming, ...rest];
  });
}
