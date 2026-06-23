import {
  AreaChart,
  BarChart,
  DonutChart,
  LineChart,
  PieChart,
} from '@mantine/charts';
import { Box, Center, Group, Paper, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { ChartSpec } from '../../types/assistant';

/** Map a Mantine color token (e.g. "teal.6") to a usable CSS var, with fallback. */
function color(token: string | undefined, i: number): string {
  const fallback = ['indigo', 'teal', 'orange', 'grape', 'cyan', 'lime', 'pink', 'yellow'];
  const t = token ?? `${fallback[i % fallback.length]}.6`;
  const [name, shade = '6'] = t.split('.');
  return `var(--mantine-color-${name}-${shade})`;
}

/**
 * Renders a chart the assistant asked for. The assistant picks the type and the
 * metric; the data always comes from the server stats, so the numbers are real.
 * Supports bar, line, area (categorical x value) and pie, donut (shares).
 */
export function ChatChart({ chart }: { chart: ChartSpec }) {
  const { type, title, data, valueLabel } = chart;
  // The chat panel can be very narrow (docked aside); shrink pie/donut and
  // cartesian heights so they fit instead of overflowing the bubble.
  const narrow = useMediaQuery('(max-width: 36em)');
  // Pie/donut draw value labels OUTSIDE the circle, so the circle itself must be
  // smaller than the box to leave room for the labels on both sides — otherwise
  // long money labels (e.g. "19004.75") get clipped. We size the circle and add
  // horizontal padding for the label overhang instead of clipping it.
  const pieSize = narrow ? 120 : 150;
  const chartH = narrow ? 170 : 220;

  if (!data || data.length === 0) {
    return (
      <Paper withBorder radius="md" p="sm" mt="xs" bg="var(--mantine-color-body)">
        <Text size="xs" c="dimmed">
          No data to chart for “{title}”.
        </Text>
      </Paper>
    );
  }

  // pie/donut consume {name, value, color}; cartesian charts consume rows keyed by name.
  const sliceData = data.map((d, i) => ({
    name: d.name,
    value: d.value,
    color: color(d.color, i),
  }));
  const cartesianData = data.map((d) => ({ name: d.name, value: d.value }));
  const seriesColor = color(data[0]?.color, 0);

  // Compact legend printed UNDER the pie/donut, so values are always fully
  // visible. We deliberately do NOT use the chart's built-in outside labels:
  // recharts draws them beyond the SVG viewport and the narrow chat panel clips
  // long money labels (e.g. "19004.75" → "004.75"). The legend never clips.
  const total = sliceData.reduce((s, d) => s + (d.value || 0), 0);
  const legend = (
    <Stack gap={4} mt="xs" style={{ minWidth: 0 }}>
      {sliceData.map((d) => (
        <Group key={d.name} gap={8} wrap="nowrap" justify="space-between" style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <Box
              style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }}
            />
            <Text size="xs" truncate style={{ minWidth: 0 }}>
              {d.name}
            </Text>
          </Group>
          <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            {d.value.toLocaleString()}
            {total > 0 && (
              <Text span size="9px" c="dimmed" ml={4}>
                {Math.round((d.value / total) * 100)}%
              </Text>
            )}
          </Text>
        </Group>
      ))}
    </Stack>
  );

  let chartEl: React.ReactNode = null;
  switch (type) {
    case 'donut':
      chartEl = (
        <>
          <Center style={{ minWidth: 0 }}>
            <DonutChart data={sliceData} size={pieSize} thickness={26} withTooltip chartLabel={String(total.toLocaleString())} />
          </Center>
          {legend}
        </>
      );
      break;
    case 'pie':
      chartEl = (
        <>
          <Center style={{ minWidth: 0 }}>
            <PieChart data={sliceData} size={pieSize} withTooltip />
          </Center>
          {legend}
        </>
      );
      break;
    case 'bar':
      chartEl = (
        <BarChart
          h={chartH}
          data={cartesianData}
          dataKey="name"
          series={[{ name: 'value', label: valueLabel, color: seriesColor }]}
          tickLine="y"
          withLegend={false}
          barProps={{ radius: 4 }}
        />
      );
      break;
    case 'line':
      chartEl = (
        <LineChart
          h={chartH}
          data={cartesianData}
          dataKey="name"
          series={[{ name: 'value', label: valueLabel, color: seriesColor }]}
          curveType="monotone"
          withDots
          withLegend={false}
        />
      );
      break;
    case 'area':
      chartEl = (
        <AreaChart
          h={chartH}
          data={cartesianData}
          dataKey="name"
          series={[{ name: 'value', label: valueLabel, color: seriesColor }]}
          curveType="monotone"
          withLegend={false}
        />
      );
      break;
  }

  return (
    <Paper withBorder radius="md" p="sm" mt="xs" bg="var(--mantine-color-body)" style={{ minWidth: 0 }}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb="xs">
        {title}
      </Text>
      <Box style={{ minWidth: 0 }}>{chartEl}</Box>
    </Paper>
  );
}
