import { DonutChart } from '@mantine/charts';
import { Box, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { formatMoney } from '../../lib/format';
import type { InvoiceStats } from '../../types/stats';

const STATUS_COLORS: Record<string, string> = {
  uploaded: 'gray.5',
  processing: 'blue.5',
  completed: 'teal.6',
  failed: 'red.6',
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Uploaded',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="9px" c="dimmed" tt="uppercase" fw={600} lh={1.2}>
        {label}
      </Text>
      <Text size="sm" fw={700} c={color} truncate>
        {value}
      </Text>
    </Box>
  );
}

/**
 * Visual invoice stats inside a chat bubble. The donut + figures live in a
 * `wrap` Group, so on a narrow panel they STACK (donut on its own line, figures
 * below) and on a wide panel they sit side by side — the donut keeps a
 * comfortable 120px and is never crushed. Money values truncate instead of
 * blowing out the row.
 */
export function ChatStats({ stats }: { stats: InvoiceStats }) {
  const donut = (Object.keys(STATUS_COLORS) as string[])
    .map((s) => ({
      name: STATUS_LABEL[s] ?? s,
      value: stats.byStatus[s as keyof typeof stats.byStatus] ?? 0,
      color: STATUS_COLORS[s],
    }))
    .filter((d) => d.value > 0);

  const avgCurrency = stats.byCurrency[0]?.currency ?? null;

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      mt="xs"
      bg="var(--mantine-color-body)"
      style={{ minWidth: 0 }}
    >
      <Group align="center" gap="md" wrap="wrap" justify="center">
        {donut.length > 0 && (
          <DonutChart
            data={donut}
            size={120}
            thickness={18}
            withTooltip
            chartLabel={String(stats.total)}
            style={{ flexShrink: 0 }}
          />
        )}
        <Stack gap={8} style={{ flex: '1 1 160px', minWidth: 0 }}>
          <SimpleGrid cols={2} spacing="xs" verticalSpacing={6}>
            <Figure label="Completed" value={String(stats.byStatus.completed)} color="teal" />
            <Figure label="Failed" value={String(stats.byStatus.failed)} color="red" />
            <Figure label="Overdue" value={String(stats.overdue)} />
            <Figure
              label="Avg value"
              value={formatMoney(stats.averageInvoiceValue, avgCurrency)}
            />
          </SimpleGrid>
        </Stack>
      </Group>

      {stats.byCurrency.length > 0 && (
        <>
          <Text size="9px" c="dimmed" tt="uppercase" fw={600} mt="sm" mb={4}>
            Total by currency
          </Text>
          <Group gap={6} wrap="wrap">
            {stats.byCurrency.map((c) => (
              <Paper
                key={c.currency}
                withBorder
                radius="sm"
                px={8}
                py={4}
                bg="var(--mantine-color-default-hover)"
              >
                <Text size="xs" fw={700} lh={1}>
                  {formatMoney(c.total, c.currency)}
                </Text>
                <Text size="9px" c="dimmed" lh={1.2}>
                  {c.currency} · {c.count} invoice{c.count === 1 ? '' : 's'}
                </Text>
              </Paper>
            ))}
          </Group>
        </>
      )}
    </Paper>
  );
}
