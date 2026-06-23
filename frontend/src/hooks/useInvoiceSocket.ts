import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { socket } from '../lib/socket';
import type { Invoice } from '../types/invoice';
import { invoiceKeys, upsertInvoice } from './useInvoices';

/**
 * Single socket subscription for the whole app. Server pushes are merged
 * straight into the React Query cache via the de-duping upsert — no refetch
 * per event, no duplicate rows. On (re)connect the list is invalidated once to
 * recover events missed while offline.
 */
export function useInvoiceSocket() {
  const qc = useQueryClient();

  useEffect(() => {
    // The paginated lists (table + upload cards) and the status-count stats hold
    // their own caches; the per-event upserts below only touch the full list.
    // Refetch those after a short quiet window so a burst of events (a batch
    // upload firing dozens of `updated`s) collapses into ONE refetch, not a
    // request storm. keepPreviousData keeps the old rows on screen meanwhile.
    let derivedTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidateDerivedSoon = () => {
      clearTimeout(derivedTimer);
      derivedTimer = setTimeout(() => {
        qc.invalidateQueries({ queryKey: invoiceKeys.pages });
        qc.invalidateQueries({ queryKey: ['stats'] });
      }, 300);
    };

    const upsert = (incoming: Invoice) => {
      upsertInvoice(qc, incoming);
      invalidateDerivedSoon();
    };

    const onDeleted = ({ id }: { id: string }) => {
      qc.setQueryData<Invoice[]>(invoiceKeys.all, (list) =>
        (list ?? []).filter((i) => i.id !== id),
      );
      invalidateDerivedSoon();
    };

    const onConnect = () => {
      // Prefix-matches both the full list and every page query.
      qc.invalidateQueries({ queryKey: invoiceKeys.all });
      qc.invalidateQueries({ queryKey: ['stats'] });
    };

    socket.on('invoice.created', upsert);
    socket.on('invoice.updated', upsert);
    socket.on('invoice.deleted', onDeleted);
    socket.on('connect', onConnect);

    return () => {
      clearTimeout(derivedTimer);
      socket.off('invoice.created', upsert);
      socket.off('invoice.updated', upsert);
      socket.off('invoice.deleted', onDeleted);
      socket.off('connect', onConnect);
    };
  }, [qc]);
}
