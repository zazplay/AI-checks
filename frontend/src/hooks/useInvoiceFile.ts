import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Fetches the original file as a Blob (the endpoint requires the JWT header,
 *  so a plain <iframe src> would not work). Files are immutable per id. */
export function useInvoiceFile(id: string) {
  return useQuery({
    queryKey: ['invoice-file', id],
    queryFn: () => api.getInvoiceFile(id),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
}
