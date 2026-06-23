import { useMemo, useState } from 'react';
import {
  Card,
  Group,
  Pagination,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconFileTypePdf, IconPhoto } from '@tabler/icons-react';
import { useInvoices } from '../../hooks/useInvoices';
import { formatMoney } from '../../lib/format';
import type { CompactInvoice } from '../../types/assistant';
import type { Invoice } from '../../types/invoice';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import { InvoiceActions } from '../invoices/InvoiceActions';
import { StatusBadge } from '../invoices/StatusBadge';

/** How many invoice cards a chat bubble shows per page. */
const PAGE_SIZE = 2;

/**
 * Interactive invoice cards rendered inside a chat bubble.
 *
 * Layout: a CONTAINER-RESPONSIVE grid (`type="container"`), so the columns
 * adapt to the chat panel's own width — one column in a narrow docked panel,
 * several when the panel is dragged wide or expanded full-screen. Cards fill
 * their grid cell (no fixed pixel width), so they never squish or get clipped;
 * the row reflows instead of scrolling. The assistant sends only compact
 * invoices (ids + a few fields); each is resolved to the full cached record so
 * live status and the action toolbar work.
 *
 * The assistant can return long lists, so the cards are PAGINATED: only
 * PAGE_SIZE are shown at once and the rest are reachable via the pager. Cards
 * show a document-type icon (a label/shortcut) instead of a heavy file preview.
 */
export function ChatInvoiceList({ invoices }: { invoices: CompactInvoice[] }) {
  const { data: all = [] } = useInvoices();
  const ui = useInvoiceUI();
  const [page, setPage] = useState(1);

  const byId = new Map(all.map((i) => [i.id, i]));
  const resolved: Invoice[] = invoices.map((c) => byId.get(c.id) ?? synthFromCompact(c));

  const totalPages = Math.ceil(resolved.length / PAGE_SIZE);
  // Clamp the page if the resolved list shrinks (e.g. an invoice was deleted).
  const current = Math.min(page, Math.max(totalPages, 1));
  const visible = useMemo(
    () => resolved.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    [resolved, current],
  );

  if (resolved.length === 0) return null;

  return (
    <Stack gap="xs" mt="xs" style={{ minWidth: 0 }}>
      <SimpleGrid
        type="container"
        cols={{ base: 1, '260px': 2, '440px': 3, '680px': 4 }}
        spacing="xs"
        style={{ minWidth: 0 }}
      >
        {visible.map((invoice) => (
          <Card
            key={invoice.id}
            withBorder
            radius="md"
            padding={8}
            style={{ overflow: 'hidden', cursor: 'pointer', minWidth: 0 }}
            onClick={() => ui.openInvoice(invoice.id)}
          >
            <Stack gap={6} style={{ minWidth: 0 }}>
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <DocIcon mimeType={invoice.mimeType} />
                <Text
                  size="xs"
                  fw={600}
                  truncate
                  title={invoice.originalFilename}
                  style={{ minWidth: 0, flex: 1 }}
                >
                  {invoice.originalFilename}
                </Text>
                <StatusBadge status={invoice.status} variant="solid" />
              </Group>
              <Group justify="space-between" gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
                  {invoice.extractedData?.vendorName ?? '—'}
                </Text>
                <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {formatMoney(
                    invoice.extractedData?.total ?? null,
                    invoice.extractedData?.currency ?? null,
                  )}
                </Text>
              </Group>
              <Group justify="flex-end" onClick={(e) => e.stopPropagation()}>
                <InvoiceActions
                  invoice={invoice}
                  variant="icon"
                  size="sm"
                  onExplain={() => ui.explain(invoice)}
                  explaining={ui.explainState.loading && ui.explainState.invoice?.id === invoice.id}
                />
              </Group>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      {totalPages > 1 && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, resolved.length)} of{' '}
            {resolved.length}
          </Text>
          <Pagination
            size="xs"
            total={totalPages}
            value={current}
            onChange={setPage}
            withControls
          />
        </Group>
      )}
    </Stack>
  );
}

/** Document-type label icon shown in place of a file preview. */
function DocIcon({ mimeType }: { mimeType: string }) {
  const isPdf = mimeType === 'application/pdf';
  return (
    <ThemeIcon
      variant="light"
      color={isPdf ? 'red' : 'blue'}
      size={28}
      radius="md"
      style={{ flexShrink: 0 }}
    >
      {isPdf ? <IconFileTypePdf size={18} /> : <IconPhoto size={18} />}
    </ThemeIcon>
  );
}

/** Build a minimal Invoice when the full record isn't in cache (rare). */
function synthFromCompact(c: CompactInvoice): Invoice {
  return {
    id: c.id,
    originalFilename: c.file,
    mimeType: 'application/octet-stream',
    fileSize: 0,
    status: c.status,
    extractedData:
      c.vendor || c.total
        ? {
            vendorName: c.vendor,
            invoiceNumber: c.invoiceNumber,
            invoiceDate: null,
            dueDate: null,
            currency: c.currency,
            subtotal: null,
            tax: null,
            total: c.total,
            lineItems: [],
            isInvoice: true,
            confidence: 1,
            docType: null,
          }
        : null,
    errorMessage: null,
    attempts: 0,
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
  };
}
