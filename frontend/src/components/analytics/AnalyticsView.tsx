import { BarChart, DonutChart, LineChart } from '@mantine/charts';
import {
  Alert,
  Center,
  ColorSwatch,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconPlugConnectedX } from '@tabler/icons-react';
import { useStats } from '../../hooks/useStats';
import { apiErrorMessage } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { InsightsPanel } from './InsightsPanel';

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

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="md" p="md" style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700} truncate>
        {label}
      </Text>
      <Text fz={{ base: 'lg', sm: 'xl' }} fw={700} lh={1.2} truncate title={value}>
        {value}
      </Text>
    </Paper>
  );
}

export function AnalyticsView() {
  const { data, isLoading, error } = useStats();
  const narrow = useMediaQuery('(max-width: 36em)');

  if (error) {
    return (
      <Alert color="orange" icon={<IconPlugConnectedX size={18} />} title="Could not load stats">
        {apiErrorMessage(error)} — is the backend running?
      </Alert>
    );
  }
  if (isLoading || !data) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  const statusData = (Object.keys(STATUS_COLORS) as string[])
    .map((s) => ({ name: s, value: data.byStatus[s as keyof typeof data.byStatus] ?? 0, color: STATUS_COLORS[s] }))
    .filter((d) => d.value > 0);

  // Each bar carries its own currency in the label (e.g. "Acme (EUR)") so the
  // chart never implies £ and € are comparable on one axis. Multi-currency
  // totals are grouped server-side, so the same vendor can appear per currency.
  const multiCurrency = new Set(data.topVendors.map((v) => v.currency)).size > 1;
  const vendorData = data.topVendors.map((v) => ({
    vendor: multiCurrency ? `${v.vendor} (${v.currency})` : v.vendor,
    total: v.total,
  }));
  const overTimeData = data.overTime.map((d) => ({ day: d.day, count: d.count }));

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile label="Total invoices" value={String(data.total)} />
        <StatTile
          label={data.averageCurrency ? `Avg value (${data.averageCurrency})` : 'Avg value'}
          value={formatMoney(data.averageInvoiceValue, data.averageCurrency)}
        />
        <StatTile label="Overdue" value={String(data.overdue)} />
        <StatTile label="Currencies" value={String(data.byCurrency.length)} />
      </SimpleGrid>

      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Title order={6} mb="sm">
              By status
            </Title>
            {statusData.length ? (
              <Stack gap="sm" align="center">
                <Center style={{ minWidth: 0, overflow: 'hidden' }}>
                  <DonutChart
                    withTooltip
                    size={narrow ? 150 : 180}
                    thickness={28}
                    chartLabel={String(data.total)}
                    data={statusData}
                  />
                </Center>
                {/* Custom legend: Mantine v8 DonutChart has no built-in legend,
                    and withLabels only prints numbers — so map color → status. */}
                <Group gap="md" justify="center" wrap="wrap">
                  {statusData.map((d) => (
                    <Group key={d.name} gap={6} wrap="nowrap">
                      <ColorSwatch color={`var(--mantine-color-${d.color.replace('.', '-')})`} size={12} />
                      <Text size="xs">
                        {STATUS_LABEL[d.name] ?? d.name} ({d.value})
                      </Text>
                    </Group>
                  ))}
                </Group>
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                No data yet.
              </Text>
            )}
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 8 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Title order={6} mb="sm">
              Top vendors by spend
            </Title>
            {vendorData.length ? (
              <ScrollArea type="auto" scrollbarSize={6} offsetScrollbars="x">
                <BarChart
                  h={220}
                  style={{ minWidth: 320 }}
                  data={vendorData}
                  dataKey="vendor"
                  series={[{ name: 'total', color: 'indigo.6' }]}
                  tickLine="y"
                />
              </ScrollArea>
            ) : (
              <Text size="sm" c="dimmed">
                No completed invoices with vendor + total yet.
              </Text>
            )}
          </Paper>
        </Grid.Col>
      </Grid>

      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Title order={6} mb="sm">
              Spend by currency
            </Title>
            {data.byCurrency.length ? (
              <Stack gap="xs">
                {data.byCurrency.map((c) => (
                  <Group key={c.currency} justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="sm" truncate style={{ minWidth: 0 }}>
                      {c.currency}{' '}
                      <Text span size="xs" c="dimmed">
                        ({c.count})
                      </Text>
                    </Text>
                    <Text size="sm" fw={600} style={{ flexShrink: 0 }}>
                      {formatMoney(c.total, c.currency)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                No completed invoices yet.
              </Text>
            )}
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Title order={6} mb="sm">
              Invoices over time
            </Title>
            {overTimeData.length ? (
              <LineChart
                h={180}
                data={overTimeData}
                dataKey="day"
                series={[{ name: 'count', color: 'teal.6' }]}
                curveType="monotone"
                withDots
              />
            ) : (
              <Text size="sm" c="dimmed">
                No data yet.
              </Text>
            )}
          </Paper>
        </Grid.Col>
      </Grid>

      <InsightsPanel />
    </Stack>
  );
}
