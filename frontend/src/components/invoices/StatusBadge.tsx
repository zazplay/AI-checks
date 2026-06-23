import { Badge, Loader } from '@mantine/core';
import type { InvoiceStatus } from '../../types/invoice';

const MAP: Record<InvoiceStatus, { label: string; color: string }> = {
  uploaded: { label: 'Uploaded', color: 'gray' },
  processing: { label: 'Processing', color: 'blue' },
  completed: { label: 'Completed', color: 'teal' },
  failed: { label: 'Failed', color: 'red' },
};

/**
 * `variant`:
 *  - "light" (default): subtle tint, for use over a flat surface (lists, tables).
 *  - "solid": filled color + shadow, legible over any image/PDF preview (cards).
 */
export function StatusBadge({
  status,
  variant = 'light',
}: {
  status: InvoiceStatus;
  variant?: 'light' | 'solid';
}) {
  const m = MAP[status];
  const solid = variant === 'solid';
  return (
    <Badge
      color={m.color}
      variant={solid ? 'filled' : 'light'}
      style={solid ? { boxShadow: '0 1px 4px rgba(0,0,0,0.35)' } : undefined}
      leftSection={
        status === 'processing' ? (
          <Loader size={10} color={solid ? 'white' : 'blue'} type="dots" />
        ) : undefined
      }
    >
      {m.label}
    </Badge>
  );
}
