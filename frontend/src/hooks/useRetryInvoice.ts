import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, apiErrorMessage } from '../lib/api';
import { humanizeError } from '../lib/format';
import type { Invoice } from '../types/invoice';
import { invoiceKeys } from './useInvoices';

/** Optimistically flips the row to `processing`; the socket delivers the real outcome. */
export function useRetryInvoice() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.retryInvoice(id),

    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: invoiceKeys.all });
      const prev = qc.getQueryData<Invoice[]>(invoiceKeys.all);
      qc.setQueryData<Invoice[]>(invoiceKeys.all, (list) =>
        (list ?? []).map((i) =>
          i.id === id ? { ...i, status: 'processing', errorMessage: null } : i,
        ),
      );
      return { prev };
    },

    onError: (error, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(invoiceKeys.all, ctx.prev);
      notifications.show({
        color: 'red',
        title: 'Retry failed',
        message: humanizeError(apiErrorMessage(error)),
      });
    },
  });
}
