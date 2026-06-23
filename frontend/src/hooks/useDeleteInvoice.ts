import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, apiErrorMessage } from '../lib/api';
import type { Invoice } from '../types/invoice';
import { invoiceKeys } from './useInvoices';

/** Optimistically removes the row; restores it (with an error toast) on failure. */
export function useDeleteInvoice() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteInvoice(id),

    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: invoiceKeys.all });
      const prev = qc.getQueryData<Invoice[]>(invoiceKeys.all);
      qc.setQueryData<Invoice[]>(invoiceKeys.all, (list) =>
        (list ?? []).filter((i) => i.id !== id),
      );
      return { prev };
    },

    onSuccess: () => {
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Invoice removed.' });
    },

    onError: (error, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(invoiceKeys.all, ctx.prev);
      notifications.show({
        color: 'red',
        title: 'Delete failed',
        message: apiErrorMessage(error),
      });
    },
  });
}
