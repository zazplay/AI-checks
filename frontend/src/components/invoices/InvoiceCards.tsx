import {
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconFilterOff,
  IconInbox,
  IconUpload,
} from '@tabler/icons-react';
import { fieldLabel, formatMoney, timeAgo } from '../../lib/format';
import type { Invoice, InvoiceStatus } from '../../types/invoice';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import { InvoiceActions } from './InvoiceActions';
import { InvoiceThumb } from './InvoiceThumb';
import { StatusBadge } from './StatusBadge';

/** Card border tint by status, so the pipeline state reads at a glance. */
const BORDER: Record<InvoiceStatus, string | undefined> = {
  uploaded: 'var(--mantine-color-gray-5)',
  processing: 'var(--mantine-color-blue-5)',
  completed: undefined,
  failed: 'var(--mantine-color-red-5)',
};

interface InvoiceCardsProps {
  invoices: Invoice[];
  isLoading: boolean;
  isFiltered: boolean;
  onOpen: (id: string) => void;
  onBrowse: () => void;
  onClearFilters: () => void;
}

export function InvoiceCards({
  invoices,
  isLoading,
  isFiltered,
  onOpen,
  onBrowse,
  onClearFilters,
}: InvoiceCardsProps) {
  // Explaining opens the shared violet AI-explanation modal.
  const ui = useInvoiceUI();

  if (isLoading) {
    return (
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="md">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={250} radius="md" />
        ))}
      </SimpleGrid>
    );
  }

  if (invoices.length === 0) {
    return (
      <Center py="xl">
        <Stack align="center" gap="sm">
          <ThemeIcon variant="light" color="gray" size={56} radius="xl">
            {isFiltered ? <IconFilterOff size={28} /> : <IconInbox size={28} />}
          </ThemeIcon>
          <Text c="dimmed" ta="center">
            {isFiltered
              ? 'Nothing matches your search or filter'
              : 'No invoices yet — upload your first one'}
          </Text>
          {isFiltered ? (
            <Button variant="subtle" size="xs" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : (
            <Button
              variant="light"
              size="xs"
              leftSection={<IconUpload size={14} />}
              onClick={onBrowse}
            >
              Upload invoice
            </Button>
          )}
        </Stack>
      </Center>
    );
  }

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="md">
      {invoices.map((invoice) => {
        const ext = invoice.extractedData;
        return (
          <Card
            key={invoice.id}
            withBorder
            radius="md"
            padding={0}
            onClick={() => onOpen(invoice.id)}
            style={{
              cursor: 'pointer',
              overflow: 'hidden',
              borderColor: BORDER[invoice.status],
            }}
          >
            <Card.Section pos="relative">
              <InvoiceThumb invoice={invoice} height={160} />
              <Box pos="absolute" top={8} right={8}>
                <StatusBadge status={invoice.status} variant="solid" />
              </Box>
            </Card.Section>

            <Stack gap={6} p="sm">
              <Group gap={6} wrap="nowrap">
                <Text size="sm" fw={600} truncate title={invoice.originalFilename} style={{ flex: 1 }}>
                  {invoice.originalFilename}
                </Text>
                {ext &&
                  (ext.isInvoice === false || ext.confidence < 0.6) && (
                    <Tooltip
                      label={`Low confidence (${Math.round(ext.confidence * 100)}%)${
                        ext.docType ? ` — looks like ${ext.docType}` : ''
                      }`}
                    >
                      <ThemeIcon color="yellow" variant="light" size="sm" radius="xl">
                        <IconAlertTriangle size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  )}
              </Group>
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Text size="xs" c="dimmed" truncate>
                  {ext?.vendorName ?? '—'}
                </Text>
                <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
                  {formatMoney(ext?.total ?? null, ext?.currency ?? null)}
                </Text>
              </Group>
              {/* AI flagged missing fields — visible right on the card. */}
              {ext && ext.missingFields && ext.missingFields.length > 0 && (
                <Tooltip label={ext.note ?? 'Some fields could not be extracted'} multiline maw={240}>
                  <Badge
                    size="xs"
                    color="yellow"
                    variant="light"
                    leftSection={<IconAlertTriangle size={10} />}
                    style={{ alignSelf: 'flex-start', textTransform: 'none', cursor: 'help' }}
                  >
                    Missing: {ext.missingFields.map(fieldLabel).join(', ')}
                  </Badge>
                </Tooltip>
              )}
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Text size="xs" c="dimmed">
                  {timeAgo(invoice.createdAt)}
                </Text>
                <Box onClick={(e) => e.stopPropagation()}>
                  <InvoiceActions
                    invoice={invoice}
                    variant="icon"
                    size="sm"
                    show={['retry', 'download', 'explain', 'delete']}
                    onExplain={() => ui.explain(invoice)}
                    explaining={
                      ui.explainState.loading && ui.explainState.invoice?.id === invoice.id
                    }
                  />
                </Box>
              </Group>
            </Stack>
          </Card>
        );
      })}
    </SimpleGrid>
  );
}
