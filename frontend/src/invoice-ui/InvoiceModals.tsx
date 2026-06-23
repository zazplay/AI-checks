import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconTrash } from '@tabler/icons-react';
import type { Invoice } from '../types/invoice';
import { useInvoices } from '../hooks/useInvoices';
import { useDeleteInvoice } from '../hooks/useDeleteInvoice';
import { useInvoiceUI } from './InvoiceUIContext';
import { ExplainModal } from './ExplainModal';
import { InvoiceDetail } from '../components/invoices/InvoiceDetail';

/**
 * The app-level invoice modals (detail + delete confirmation), driven by the
 * shared InvoiceUI context. Mounted once near the app root so both the main
 * panel and the assistant can open them.
 */
export function InvoiceModals({
  deleteTarget,
  onCloseDelete,
}: {
  deleteTarget: Invoice | null;
  onCloseDelete: () => void;
}) {
  const ui = useInvoiceUI();
  const { data: invoices = [] } = useInvoices();
  const deleteInvoice = useDeleteInvoice();
  const isMobile = useMediaQuery('(max-width: 48em)');

  const detail = invoices.find((i) => i.id === ui.detailId);

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteInvoice.mutate(deleteTarget.id);
    if (ui.detailId === deleteTarget.id) ui.openInvoice(null);
    onCloseDelete();
  };

  return (
    <>
      <Modal
        opened={detail !== undefined}
        onClose={() => ui.openInvoice(null)}
        withCloseButton={false}
        padding={0}
        // Sit above the batch-upload progress modal (default z-index ~200), so
        // opening an invoice while uploads run isn't hidden behind the overlay.
        zIndex={400}
        // The split layout (340px rail + content) needs the mockup's ~1000px
        // width; Mantine's "xl" is only ~780px, which forced the columns to
        // squeeze and the modal to grow tall instead of wide.
        size="min(1000px, 95vw)"
        centered
        fullScreen={isMobile}
        // Cap the modal height so the whole thing fits the viewport without an
        // outer scrollbar; InvoiceDetail lays its content out to fill this.
        styles={
          isMobile
            ? undefined
            : {
                content: { height: 'min(90vh, 760px)' },
                body: { height: '100%', overflow: 'hidden' },
              }
        }
      >
        {detail && (
          <InvoiceDetail
            invoice={detail}
            onRequestDelete={ui.requestDelete}
            onClose={() => ui.openInvoice(null)}
          />
        )}
      </Modal>

      <Modal
        opened={deleteTarget !== null}
        onClose={onCloseDelete}
        title="Delete invoice"
        size="sm"
        centered
        zIndex={400}
      >
        <Stack gap="md">
          <Text size="sm">
            Delete <b>{deleteTarget?.originalFilename}</b>? The uploaded file will be
            removed permanently.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onCloseDelete}>
              Cancel
            </Button>
            <Button color="red" leftSection={<IconTrash size={14} />} onClick={confirmDelete}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>

      <ExplainModal />
    </>
  );
}
