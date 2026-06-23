import { Box, Group, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import {
  IconChartHistogram,
  IconDownload,
  IconFilter,
  IconMessageChatbot,
  IconPencil,
  IconRefresh,
  type TablerIcon,
} from '@tabler/icons-react';

/** One capability shown in the welcome grid. */
interface Capability {
  icon: TablerIcon;
  color: string;
  title: string;
  desc: string;
}

const CAPABILITIES: Capability[] = [
  {
    icon: IconFilter,
    color: 'indigo',
    title: 'Find & filter',
    desc: 'By status, vendor, amount, currency, dates, overdue or problems',
  },
  {
    icon: IconChartHistogram,
    color: 'cyan',
    title: 'Analyse & chart',
    desc: 'Stats, top vendors, spend by currency, trends — drawn inline',
  },
  {
    icon: IconRefresh,
    color: 'teal',
    title: 'Retry & re-check',
    desc: 'Retry failed ones or re-run extraction on any invoice',
  },
  {
    icon: IconPencil,
    color: 'grape',
    title: 'Fix & edit',
    desc: 'Correct a wrong vendor, total or date — you confirm first',
  },
  {
    icon: IconDownload,
    color: 'orange',
    title: 'Export',
    desc: 'Download a filtered set as Excel, CSV or a zip of originals',
  },
  {
    icon: IconMessageChatbot,
    color: 'blue',
    title: 'Drive the app',
    desc: 'Open an invoice, switch tabs or filter the list for you',
  },
];

/** Clickable example prompts — sending one starts the conversation. */
const EXAMPLES = [
  'Show my overdue invoices',
  'What did I spend, by currency?',
  'Retry all failed invoices',
  'Export completed invoices to Excel',
  'Find invoices with no data',
];

interface AssistantWelcomeProps {
  /** Send a prompt immediately (clicking an example or a capability). */
  onPick: (prompt: string) => void;
}

/**
 * The empty-chat welcome screen: an animated intro, a grid of what the
 * assistant can do (icons, hover-zoom), and clickable example prompts that
 * send on click. Everything fades/scales in on mount for a lively feel.
 */
export function AssistantWelcome({ onPick }: AssistantWelcomeProps) {
  return (
    // Small type + icons so the whole welcome fits a docked panel without scroll.
    <Stack align="center" gap="xs" px="sm" py="sm" maw={560} mx="auto">
      <Stack align="center" gap={4} className="aw-fade" style={{ animationDelay: '0ms' }}>
        <ThemeIcon
          variant="gradient"
          gradient={{ from: 'indigo', to: 'cyan' }}
          size={48}
          radius="xl"
          className="aw-pop"
        >
          <IconMessageChatbot size={24} />
        </ThemeIcon>
        <Text fw={700} fz="md" ta="center" lh={1.2}>
          Your invoice assistant
        </Text>
        <Text c="dimmed" fz="xs" ta="center" lh={1.3}>
          Ask about your invoices, or tell me to act — find, analyse, fix, retry,
          export and more.
        </Text>
      </Stack>

      {/* Plain single-column stack — the docked chat panel is narrow, so each
          card spans the full width and the text never squishes into a sliver. */}
      <Stack gap={6} w="100%">
        {CAPABILITIES.map((c, i) => (
          <Group
            key={c.title}
            gap={8}
            wrap="nowrap"
            align="flex-start"
            className="aw-fade aw-card"
            style={{ animationDelay: `${50 + i * 45}ms` }}
          >
            <ThemeIcon variant="light" color={c.color} size="md" radius="md" style={{ flexShrink: 0 }}>
              <c.icon size={16} />
            </ThemeIcon>
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Text fz="xs" fw={600} lh={1.2}>
                {c.title}
              </Text>
              <Text fz="11px" c="dimmed" lh={1.3} mt={1}>
                {c.desc}
              </Text>
            </Box>
          </Group>
        ))}
      </Stack>

      <Stack gap={4} w="100%" className="aw-fade" style={{ animationDelay: '380ms' }}>
        <Text fz="10px" c="dimmed" fw={600} tt="uppercase" ta="center">
          Try asking
        </Text>
        <Group gap={5} justify="center">
          {EXAMPLES.map((ex) => (
            <UnstyledButton key={ex} className="aw-chip" onClick={() => onPick(ex)}>
              {ex}
            </UnstyledButton>
          ))}
        </Group>
      </Stack>
    </Stack>
  );
}
