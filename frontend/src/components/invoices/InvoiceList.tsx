import {
  ActionIcon,
  Button,
  Center,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconFileTypePdf,
  IconFilterOff,
  IconInbox,
  IconPhoto,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useRetryInvoice } from '../../hooks/useRetryInvoice';
import { formatBytes, formatDateTime, humanizeError, timeAgo } from '../../lib/format';
import type { Invoice } from '../../types/invoice';
import { StatusBadge } from './StatusBadge';

interface InvoiceListProps {
  invoices: Invoice[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  isFiltered: boolean;
  onBrowse: () => void;
  onClearFilters: () => void;
  onRequestDelete: (invoice: Invoice) => void;
}

export function InvoiceList({
  invoices,
  isLoading,
  selectedId,
  onSelect,
  isFiltered,
  onBrowse,
  onClearFilters,
  onRequestDelete,
}: InvoiceListProps) {
  const retry = useRetryInvoice();

  if (isLoading) {
    return (
      <Stack gap="xs" py="md">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={40} radius="sm" />
        ))}
      </Stack>
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

  const rows = invoices.map((invoice) => {
    const selected = invoice.id === selectedId;
    const retrying = retry.isPending && retry.variables === invoice.id;
    const isPdf = invoice.mimeType === 'application/pdf';
    return (
      <Table.Tr
        key={invoice.id}
        onClick={() => onSelect(invoice.id)}
        bg={selected ? 'var(--mantine-primary-color-light)' : undefined}
        style={{ cursor: 'pointer' }}
      >
        <Table.Td>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color={isPdf ? 'red' : 'blue'} size="md" radius="sm">
              {isPdf ? <IconFileTypePdf size={16} /> : <IconPhoto size={16} />}
            </ThemeIcon>
            <div style={{ minWidth: 0 }}>
              <Text size="sm" truncate maw={240} title={invoice.originalFilename}>
                {invoice.originalFilename}
              </Text>
              <Text size="xs" c="dimmed">
                {formatBytes(invoice.fileSize)}
              </Text>
            </div>
          </Group>
        </Table.Td>
        <Table.Td>
          <StatusBadge status={invoice.status} />
        </Table.Td>
        <Table.Td>
          <Tooltip label={formatDateTime(invoice.createdAt)} openDelay={400}>
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {timeAgo(invoice.createdAt)}
            </Text>
          </Tooltip>
        </Table.Td>
        <Table.Td w={88}>
          <Group gap={4} wrap="nowrap" justify="flex-end">
            {invoice.status === 'failed' && (
              <Tooltip label={humanizeError(invoice.errorMessage)} multiline maw={260}>
                <ActionIcon
                  variant="light"
                  color="red"
                  loading={retrying}
                  onClick={(e) => {
                    e.stopPropagation();
                    retry.mutate(invoice.id);
                  }}
                  aria-label={`Retry ${invoice.originalFilename}`}
                >
                  <IconRefresh size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Delete">
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDelete(invoice);
                }}
                aria-label={`Delete ${invoice.originalFilename}`}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
    );
  });

  return (
    <Table.ScrollContainer minWidth={520}>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>File</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Uploaded</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>{rows}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
