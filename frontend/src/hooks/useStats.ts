import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export const statsKeys = { all: ['stats'] as const };

export function useStats() {
  return useQuery({
    queryKey: statsKeys.all,
    queryFn: api.getStats,
    // Live socket events invalidate ['stats'] constantly; without this the
    // counts (cards, badges, and the dropzone "queue busy" gate derived from
    // them) blink to 0 on every refetch. Keep the last counts on screen until
    // the new ones arrive.
    placeholderData: keepPreviousData,
  });
}
