import { ActionIcon, Button, CopyButton, Group, Tooltip } from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import type { Invoice } from '../../types/invoice';

interface InvoiceActionsProps {
  invoice: Invoice;
  /** icon = compact icon row (cards/chat); button = labeled buttons (detail view). */
  variant?: 'icon' | 'button';
  /** Which actions to show; omit for the sensible default set. */
  show?: Array<'open' | 'retry' | 'download' | 'explain' | 'copy' | 'delete'>;
  /** Explain is handled by the caller (it owns the result alert), so it's opt-in. */
  onExplain?: (id: string) => void;
  explaining?: boolean;
  size?: 'xs' | 'sm' | 'md';
}

/**
 * The single, reusable action surface for an invoice. Used on cards, in the
 * detail modal, and inside chat result cards so every place offers the same
 * set of things you can do with an invoice. All actions route through the
 * shared InvoiceUI context, so the assistant and the user act identically.
 */
export function InvoiceActions({
  invoice,
  variant = 'icon',
  show,
  onExplain,
  explaining,
  size = 'sm',
}: InvoiceActionsProps) {
  const ui = useInvoiceUI();
  const retrying = ui.retryingId === invoice.id;
  const canRetry = invoice.status === 'failed';
  const canExplain = invoice.status === 'completed' && !!invoice.extractedData && !!onExplain;
  const canDownload = invoice.status !== 'uploaded' && invoice.status !== 'processing';

  // Default visible actions adapt to the invoice's state.
  const visible =
    show ??
    ([
      'open',
      canRetry && 'retry',
      canDownload && 'download',
      canExplain && 'explain',
      'delete',
    ].filter(Boolean) as InvoiceActionsProps['show']);

  const has = (a: NonNullable<InvoiceActionsProps['show']>[number]) =>
    visible?.includes(a);

  if (variant === 'button') {
    return (
      <Group gap={4} wrap="wrap">
        {has('open') && (
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<IconExternalLink size={12} />}
            onClick={() => ui.openInvoice(invoice.id)}
          >
            Open
          </Button>
        )}
        {has('retry') && canRetry && (
          <Button
            variant="subtle"
            size="compact-xs"
            color="orange"
            leftSection={<IconRefresh size={12} />}
            loading={retrying}
            onClick={() => ui.retry(invoice.id)}
          >
            Retry
          </Button>
        )}
        {has('download') && canDownload && (
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<IconDownload size={12} />}
            onClick={() => void ui.download(invoice)}
          >
            Download
          </Button>
        )}
        {has('explain') && canExplain && (
          <Button
            variant="subtle"
            size="compact-xs"
            color="grape"
            leftSection={<IconSparkles size={12} />}
            loading={explaining}
            onClick={() => onExplain?.(invoice.id)}
          >
            Explain
          </Button>
        )}
        {has('copy') && (
          <CopyButton value={invoice.id}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied!' : `Copy ID ${invoice.id.slice(0, 8)}…`}>
                <Button
                  variant="subtle"
                  size="compact-xs"
                  color={copied ? 'teal' : 'gray'}
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  onClick={copy}
                >
                  ID
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        )}
        {has('delete') && (
          <Button
            variant="subtle"
            size="compact-xs"
            color="red"
            leftSection={<IconTrash size={12} />}
            onClick={() => ui.requestDelete(invoice)}
          >
            Delete
          </Button>
        )}
      </Group>
    );
  }

  // icon variant
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <Group gap={2} wrap="wrap" justify="flex-end">
      {has('open') && (
        <Tooltip label="Open details">
          <ActionIcon
            variant="subtle"
            color="gray"
            size={size}
            onClick={stop(() => ui.openInvoice(invoice.id))}
            aria-label="Open details"
          >
            <IconExternalLink size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {has('retry') && canRetry && (
        <Tooltip label="Retry processing">
          <ActionIcon
            variant="light"
            color="orange"
            size={size}
            loading={retrying}
            onClick={stop(() => ui.retry(invoice.id))}
            aria-label="Retry"
          >
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {has('download') && canDownload && (
        <Tooltip label="Download original">
          <ActionIcon
            variant="subtle"
            color="gray"
            size={size}
            onClick={stop(() => void ui.download(invoice))}
            aria-label="Download"
          >
            <IconDownload size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {has('explain') && canExplain && (
        <Tooltip label="Explain with AI">
          <ActionIcon
            variant="light"
            color="grape"
            size={size}
            loading={explaining}
            onClick={stop(() => onExplain?.(invoice.id))}
            aria-label="Explain with AI"
          >
            <IconSparkles size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      {has('delete') && (
        <Tooltip label="Delete">
          <ActionIcon
            variant="subtle"
            color="red"
            size={size}
            onClick={stop(() => ui.requestDelete(invoice))}
            aria-label="Delete"
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}
