import { Box, Collapse, Group, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconCheck,
  IconChevronRight,
  IconListCheck,
  IconX,
} from '@tabler/icons-react';
import type { ToolAction } from '../../types/assistant';

/** Human-friendly label + verb for each tool the assistant can run. */
const TOOL_META: Record<string, { label: string }> = {
  list_invoices: { label: 'Listed invoices' },
  get_invoice: { label: 'Opened an invoice' },
  search_invoices: { label: 'Searched invoices' },
  list_empty_invoices: { label: 'Found empty invoices' },
  query_invoices: { label: 'Queried invoices' },
  filter_invoices: { label: 'Filtered invoices' },
  get_dataset: { label: 'Loaded the dataset' },
  get_invoice_stats: { label: 'Gathered statistics' },
  render_chart: { label: 'Drew a chart' },
  retry_invoice: { label: 'Retried an invoice' },
  reprocess_invoice: { label: 'Re-checked an invoice' },
  update_invoice: { label: 'Edited an invoice' },
  retry_all_failed: { label: 'Retried all failed' },
  retry_failed_then_cleanup: { label: 'Retried failed & cleaned up' },
  delete_invoice: { label: 'Deleted an invoice' },
  delete_invoices: { label: 'Deleted invoices' },
  navigate_ui: { label: 'Navigated the app' },
  export_invoices: { label: 'Exported invoices' },
  suggest_actions: { label: 'Suggested next steps' },
};

const friendlyLabel = (tool: string) =>
  TOOL_META[tool]?.label ??
  tool.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * The assistant's "actions taken", as a collapsible summary so acting is
 * visible without cluttering the reply. Collapsed by default: a one-line
 * trigger with the action count; expanding reveals each step with a friendly
 * name, an ok/error icon, and the server's summary.
 */
export function ToolActionList({ actions }: { actions: ToolAction[] }) {
  const [opened, { toggle }] = useDisclosure(false);
  const failed = actions.filter((a) => a.result === 'error').length;

  return (
    <Box mt="xs" style={{ minWidth: 0 }}>
      <UnstyledButton onClick={toggle} style={{ width: '100%' }}>
        <Group gap={6} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
          <IconChevronRight
            size={13}
            style={{
              flexShrink: 0,
              transition: 'transform 150ms ease',
              transform: opened ? 'rotate(90deg)' : 'none',
              color: 'var(--mantine-color-dimmed)',
            }}
          />
          <ThemeIcon size="sm" radius="xl" variant="light" color="indigo" style={{ flexShrink: 0 }}>
            <IconListCheck size={12} />
          </ThemeIcon>
          <Text size="xs" c="dimmed" fw={600} style={{ minWidth: 0 }}>
            {actions.length === 1
              ? '1 action taken'
              : `${actions.length} actions taken`}
            {failed > 0 && ` · ${failed} failed`}
          </Text>
        </Group>
      </UnstyledButton>

      <Collapse in={opened}>
        <Stack gap={6} mt={8} pl={4} style={{ minWidth: 0 }}>
          {actions.map((action, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
              <ThemeIcon
                size="sm"
                radius="xl"
                variant="light"
                color={action.result === 'ok' ? 'teal' : 'red'}
                style={{ flexShrink: 0 }}
              >
                {action.result === 'ok' ? <IconCheck size={12} /> : <IconX size={12} />}
              </ThemeIcon>
              {/* minWidth:0 lets long names / summaries wrap instead of
                  overflowing the bubble in a narrow panel. */}
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text size="xs" fw={600} style={{ overflowWrap: 'anywhere' }}>
                  {friendlyLabel(action.tool)}
                </Text>
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {action.summary}
                </Text>
              </Box>
            </Group>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}
