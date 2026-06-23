import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  CloseButton,
  Group,
  Pagination,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { INVOICE_STATUSES } from '../../types/invoice';
import {
  IconChartBar,
  IconLayoutGrid,
  IconPlugConnectedX,
  IconSearch,
  IconTable,
} from '@tabler/icons-react';
import { useInvoicesPage } from '../../hooks/useInvoices';
import { SCROLL_ANCHOR_OFFSET, useScrollToTopOnChange } from '../../hooks/useScrollToTopOnChange';
import { useStats } from '../../hooks/useStats';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import { apiErrorMessage } from '../../lib/api';
import type { InvoiceStatus } from '../../types/invoice';
import { AnalyticsView } from '../analytics/AnalyticsView';
import { AllInvoicesTable } from './AllInvoicesTable';
import { ExportMenu } from './ExportMenu';
import { InvoiceCards } from './InvoiceCards';
import { StatsCards } from './StatsCards';
import { UploadDropzone } from './UploadDropzone';

const UPLOAD_PAGE_SIZES = ['12', '24', '48'];
const EMPTY_COUNTS: Record<InvoiceStatus, number> = {
  uploaded: 0,
  processing: 0,
  completed: 0,
  failed: 0,
};

export function InvoicePanel() {
  const ui = useInvoiceUI();

  // Status counts come from the SQL-aggregated /stats endpoint, not from
  // loading the whole list — so the cards/badges/segmented control stay O(1)
  // as the table grows.
  const { data: stats } = useStats();
  const counts = stats?.byStatus ?? EMPTY_COUNTS;
  const totalCount = stats?.total ?? 0;

  // The Upload-tab card list is server-paginated + server-filtered, the same as
  // the All-invoices table — it no longer renders the entire list client-side.
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(12);
  const [debouncedSearch] = useDebouncedValue(ui.search, 300);
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, ui.statusFilter, limit]);

  const {
    data: pageData,
    isLoading,
    isFetching,
    isPlaceholderData,
    error,
  } = useInvoicesPage({
    page,
    limit,
    status: ui.statusFilter ?? undefined,
    search: debouncedSearch.trim() || undefined,
    sort: 'createdAt',
    dir: 'desc',
  });

  const cards = pageData?.items ?? [];
  const matchedTotal = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(matchedTotal / limit));
  const isFiltered = ui.statusFilter !== null || debouncedSearch.trim().length > 0;

  // Scroll the card grid back to the top when the page changes.
  const topAnchor = useScrollToTopOnChange(page);

  // Clamp back onto the last real page if the result set shrinks under us
  // (deletes / live socket updates) so we never request an empty out-of-range page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const clearFilters = () => {
    ui.setStatusFilter(null);
    ui.setSearch('');
  };

  return (
    <Stack gap="md">
      <StatsCards
        counts={counts}
        active={ui.statusFilter}
        onToggle={(status) => {
          ui.setStatusFilter(ui.statusFilter === status ? null : status);
          ui.setTab('upload');
        }}
      />

      <Tabs
        value={ui.tab}
        onChange={(v) => v && ui.setTab(v as 'upload' | 'all' | 'analytics')}
        keepMounted={false}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="upload" leftSection={<IconLayoutGrid size={16} />}>
            Upload
          </Tabs.Tab>
          <Tabs.Tab
            value="all"
            leftSection={<IconTable size={16} />}
            rightSection={
              <Badge size="sm" variant="light" circle>
                {totalCount}
              </Badge>
            }
          >
            All invoices
          </Tabs.Tab>
          <Tabs.Tab value="analytics" leftSection={<IconChartBar size={16} />}>
            Analytics
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="upload">
          <Stack gap="md">
            <UploadDropzone
              openRef={ui.uploadOpenerRef}
              onUploaded={ui.openInvoice}
              queuedCount={counts.uploaded + counts.processing}
            />
            <Paper withBorder p="md" radius="md">
              {/* Scroll target: page changes bring the invoice list top into view. */}
              <div ref={topAnchor} style={{ scrollMarginTop: SCROLL_ANCHOR_OFFSET }} />
              <Stack gap="sm">
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Group gap="xs">
                    <Title order={5}>Invoices</Title>
                    <Badge variant="light" radius="sm">
                      {isFiltered ? `${matchedTotal} / ${totalCount}` : totalCount}
                    </Badge>
                  </Group>
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                    <TextInput
                      placeholder="Search by file name…"
                      size="xs"
                      flex={1}
                      miw={0}
                      maw={{ base: '100%', sm: 220 }}
                      leftSection={<IconSearch size={14} />}
                      rightSection={
                        ui.search ? (
                          <CloseButton
                            size="sm"
                            onClick={() => ui.setSearch('')}
                            aria-label="Clear search"
                          />
                        ) : undefined
                      }
                      value={ui.search}
                      onChange={(e) => ui.setSearch(e.currentTarget.value)}
                    />
                    <ExportMenu
                      filter={{
                        status: ui.statusFilter ?? undefined,
                        search: ui.search.trim() || undefined,
                      }}
                    />
                  </Group>
                </Group>

                {/* Status filter: full-width segmented control on roomy screens,
                    horizontally scrollable on narrow ones so the 5 labels stay
                    readable instead of being squashed. */}
                <ScrollArea type="auto" scrollbarSize={6} offsetScrollbars="x">
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    value={ui.statusFilter ?? 'all'}
                    onChange={(v) =>
                      ui.setStatusFilter(v === 'all' ? null : (v as InvoiceStatus))
                    }
                    data={[
                      { value: 'all', label: `All (${totalCount})` },
                      ...INVOICE_STATUSES.map((s) => ({
                        value: s,
                        label: `${s[0].toUpperCase()}${s.slice(1)} (${counts[s] ?? 0})`,
                      })),
                    ]}
                  />
                </ScrollArea>

                {error ? (
                  <Alert
                    color="orange"
                    icon={<IconPlugConnectedX size={18} />}
                    title="Could not load invoices"
                  >
                    {apiErrorMessage(error)} — is the backend running?
                  </Alert>
                ) : (
                  <>
                    {/* Dim (don't blank) the grid while a page/filter transition
                        is fetching — keepPreviousData holds the old cards. */}
                    <div
                      style={{
                        opacity: isFetching && isPlaceholderData ? 0.55 : 1,
                        transition: 'opacity 120ms ease',
                        pointerEvents: isFetching && isPlaceholderData ? 'none' : undefined,
                      }}
                    >
                      <InvoiceCards
                        invoices={cards}
                        isLoading={isLoading}
                        isFiltered={isFiltered}
                        onOpen={ui.openInvoice}
                        onBrowse={ui.openUpload}
                        onClearFilters={clearFilters}
                      />
                    </div>
                    {matchedTotal > 0 && (
                      <Group justify="space-between" wrap="wrap" gap="sm" mt="xs">
                        <Select
                          size="xs"
                          w={120}
                          data={UPLOAD_PAGE_SIZES.map((s) => ({ value: s, label: `${s} / page` }))}
                          value={String(limit)}
                          onChange={(v) => v && setLimit(Number(v))}
                          allowDeselect={false}
                          aria-label="Cards per page"
                        />
                        {totalPages > 1 && (
                          <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
                        )}
                      </Group>
                    )}
                  </>
                )}
              </Stack>
            </Paper>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="all">
          {error ? (
            <Alert
              color="orange"
              icon={<IconPlugConnectedX size={18} />}
              title="Could not load invoices"
            >
              {apiErrorMessage(error)} — is the backend running?
            </Alert>
          ) : (
            <AllInvoicesTable
              onOpen={ui.openInvoice}
              onRequestDelete={ui.requestDelete}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="analytics">
          <AnalyticsView />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
