import { useEffect, useState } from 'react';
import {
  Center,
  Group,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconChevronDown,
  IconChevronUp,
  IconFileTypePdf,
  IconInbox,
  IconPhoto,
  IconSearch,
  IconSelector,
} from '@tabler/icons-react';
import { formatBytes, formatDateTime, formatMoney } from '../../lib/format';
import type { Invoice, InvoiceSortKey, InvoiceStatus } from '../../types/invoice';
import { INVOICE_STATUSES } from '../../types/invoice';
import { useInvoicesPage } from '../../hooks/useInvoices';
import { SCROLL_ANCHOR_OFFSET, useScrollToTopOnChange } from '../../hooks/useScrollToTopOnChange';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import { InvoiceActions } from './InvoiceActions';
import { StatusBadge } from './StatusBadge';

type SortKey = InvoiceSortKey;
type SortDir = 'asc' | 'desc';

const PAGE_SIZES = ['25', '50', '100'];

interface AllInvoicesTableProps {
  onOpen: (id: string) => void;
  onRequestDelete: (invoice: Invoice) => void;
}

function Th({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const Icon = !active ? IconSelector : dir === 'asc' ? IconChevronUp : IconChevronDown;
  return (
    <Table.Th ta={align}>
      <UnstyledButton
        onClick={() => onSort(sortKey)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Text size="sm" fw={600}>
          {label}
        </Text>
        <Icon size={14} opacity={active ? 1 : 0.4} />
      </UnstyledButton>
    </Table.Th>
  );
}

export function AllInvoicesTable({ onOpen }: AllInvoicesTableProps) {
  const ui = useInvoiceUI();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  // Debounce typing so each keystroke doesn't fire a request; the server does
  // the actual filtering.
  const [debouncedSearch] = useDebouncedValue(search, 300);

  // Any change to the filter/sort/page-size resets to page 1 (otherwise you
  // could be stranded on a page that no longer exists for the new result set).
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, sortKey, sortDir, limit]);

  const { data, isLoading, isFetching, isPlaceholderData } = useInvoicesPage({
    page,
    limit,
    status: statusFilter ?? undefined,
    search: debouncedSearch.trim() || undefined,
    sort: sortKey,
    dir: sortDir,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Jump back to the top of the table when the page changes.
  const topAnchor = useScrollToTopOnChange(page);

  // If the result set shrinks (deletes / live updates) so the current page no
  // longer exists, clamp back onto the last real page instead of requesting an
  // out-of-range page that renders empty.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'createdAt' || key === 'total' ? 'desc' : 'asc');
    }
  };

  return (
    <Paper withBorder radius="md" p="md">
      {/* Scroll target: page changes bring this (the table top) into view. */}
      <div ref={topAnchor} style={{ scrollMarginTop: SCROLL_ANCHOR_OFFSET }} />
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="xs" wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
            <TextInput
              placeholder="Search file, vendor, number…"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              flex={1}
              miw={0}
              maw={{ base: '100%', sm: 280 }}
            />
            <Select
              placeholder="All statuses"
              clearable
              data={INVOICE_STATUSES.map((s) => ({
                value: s,
                label: s[0].toUpperCase() + s.slice(1),
              }))}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as InvoiceStatus | null)}
              w={{ base: '100%', xs: 170 }}
            />
          </Group>
          <Text size="sm" c="dimmed">
            {total === 0
              ? '0'
              : `${(page - 1) * limit + 1}–${(page - 1) * limit + rows.length} of ${total}`}
          </Text>
        </Group>

        {isLoading ? (
          <Stack gap="xs">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={44} radius="sm" />
            ))}
          </Stack>
        ) : rows.length === 0 ? (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <ThemeIcon variant="light" color="gray" size={56} radius="xl">
                <IconInbox size={28} />
              </ThemeIcon>
              <Text c="dimmed">No invoices match your filters</Text>
            </Stack>
          </Center>
        ) : (
          // Dim (don't blank) the table while a page/sort/search transition is
          // fetching — keepPreviousData holds the old rows so nothing flashes.
          <div
            style={{
              opacity: isFetching && isPlaceholderData ? 0.55 : 1,
              transition: 'opacity 120ms ease',
              pointerEvents: isFetching && isPlaceholderData ? 'none' : undefined,
            }}
          >
          <Table.ScrollContainer minWidth={820}>
            <Table highlightOnHover verticalSpacing="sm" striped>
              <Table.Thead>
                <Table.Tr>
                  <Th label="File" sortKey="originalFilename" active={sortKey === 'originalFilename'} dir={sortDir} onSort={toggleSort} />
                  <Th label="Vendor" sortKey="vendorName" active={sortKey === 'vendorName'} dir={sortDir} onSort={toggleSort} />
                  <Table.Th>Invoice #</Table.Th>
                  <Th label="Total" sortKey="total" active={sortKey === 'total'} dir={sortDir} onSort={toggleSort} align="right" />
                  <Th label="Status" sortKey="status" active={sortKey === 'status'} dir={sortDir} onSort={toggleSort} />
                  <Th label="Uploaded" sortKey="createdAt" active={sortKey === 'createdAt'} dir={sortDir} onSort={toggleSort} />
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((invoice) => {
                  const isPdf = invoice.mimeType === 'application/pdf';
                  const ext = invoice.extractedData;
                  return (
                    <Table.Tr
                      key={invoice.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onOpen(invoice.id)}
                    >
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <ThemeIcon variant="light" color={isPdf ? 'red' : 'blue'} size="md" radius="sm">
                            {isPdf ? <IconFileTypePdf size={16} /> : <IconPhoto size={16} />}
                          </ThemeIcon>
                          <div style={{ minWidth: 0 }}>
                            <Text size="sm" truncate maw={220} title={invoice.originalFilename}>
                              {invoice.originalFilename}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {formatBytes(invoice.fileSize)}
                            </Text>
                          </div>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{ext?.vendorName ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {ext?.invoiceNumber ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">{formatMoney(ext?.total ?? null, ext?.currency ?? null)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={invoice.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                          {formatDateTime(invoice.createdAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {/* Shared action surface (same as the card view) so the
                            table also offers open/download/explain, not just
                            view/retry/delete. */}
                        <Group justify="flex-end" onClick={(e) => e.stopPropagation()}>
                          <InvoiceActions
                            invoice={invoice}
                            variant="icon"
                            show={['open', 'retry', 'download', 'explain', 'delete']}
                            onExplain={() => ui.explain(invoice)}
                            explaining={
                              ui.explainState.loading &&
                              ui.explainState.invoice?.id === invoice.id
                            }
                          />
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          </div>
        )}

        {/* Pager: hidden when everything fits one page. Page-size select on the
            left, page controls on the right. */}
        {total > 0 && (
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Select
              size="xs"
              w={110}
              data={PAGE_SIZES.map((s) => ({ value: s, label: `${s} / page` }))}
              value={String(limit)}
              onChange={(v) => v && setLimit(Number(v))}
              allowDeselect={false}
              aria-label="Rows per page"
            />
            {totalPages > 1 && (
              <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
