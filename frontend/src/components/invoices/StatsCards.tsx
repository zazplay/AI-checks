import { Group, Paper, SimpleGrid, Text, ThemeIcon } from '@mantine/core';
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconFileUpload,
  IconLoader2,
  type Icon,
} from '@tabler/icons-react';
import type { InvoiceStatus } from '../../types/invoice';

const ITEMS: {
  status: InvoiceStatus;
  label: string;
  color: string;
  icon: Icon;
}[] = [
  { status: 'uploaded', label: 'Uploaded', color: 'gray', icon: IconFileUpload },
  { status: 'processing', label: 'Processing', color: 'blue', icon: IconLoader2 },
  { status: 'completed', label: 'Completed', color: 'teal', icon: IconCircleCheck },
  { status: 'failed', label: 'Failed', color: 'red', icon: IconCircleX },
];

interface StatsCardsProps {
  /** Per-status counts (SQL-aggregated via /invoices/stats). */
  counts: Record<InvoiceStatus, number>;
  active: InvoiceStatus | null;
  onToggle: (status: InvoiceStatus) => void;
}

/** Clickable status counters — clicking a card filters the list by that status. */
export function StatsCards({ counts, active, onToggle }: StatsCardsProps) {
  return (
    <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
      {ITEMS.map(({ status, label, color, icon: ItemIcon }) => {
        const count = counts[status] ?? 0;
        const isActive = active === status;
        // The "processing" loader glyph implies active work — show a neutral
        // clock instead when nothing is processing, so 0 doesn't look busy.
        const Glyph = status === 'processing' && count === 0 ? IconClock : ItemIcon;
        return (
          <Paper
            key={status}
            withBorder
            p="md"
            radius="md"
            onClick={() => onToggle(status)}
            style={{
              cursor: 'pointer',
              transition: 'border-color 120ms ease, transform 120ms ease',
              borderColor: isActive ? `var(--mantine-color-${color}-5)` : undefined,
              transform: isActive ? 'translateY(-2px)' : undefined,
            }}
            aria-pressed={isActive}
            role="button"
          >
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <div style={{ minWidth: 0 }}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700} truncate>
                  {label}
                </Text>
                <Text fz={{ base: 22, sm: 28 }} fw={700} lh={1.2}>
                  {count}
                </Text>
              </div>
              <ThemeIcon
                color={color}
                variant="light"
                size="xl"
                radius="md"
                style={{ flexShrink: 0 }}
              >
                <Glyph size={24} />
              </ThemeIcon>
            </Group>
          </Paper>
        );
      })}
    </SimpleGrid>
  );
}
