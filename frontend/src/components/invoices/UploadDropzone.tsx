import { useEffect, useRef, type MutableRefObject } from 'react';
import { Badge, Group, Loader, Stack, Text } from '@mantine/core';
import { Dropzone, MIME_TYPES, type FileRejection } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { IconCloudUpload, IconUpload, IconX } from '@tabler/icons-react';
import { useBatchUpload } from '../../hooks/useBatchUpload';
import { useResolvedUploadRows } from '../../hooks/useResolvedUploadRows';
import { UploadProgress } from './UploadProgress';

const MAX_SIZE_MB = 10;
const ACCEPTED = [MIME_TYPES.pdf, MIME_TYPES.png, MIME_TYPES.jpeg];
/** Delay before the in-zone progress panel auto-clears once a clean batch finishes. */
const AUTO_DISMISS_MS = 3500;

interface UploadDropzoneProps {
  /** Lets other components (e.g. empty-state button) open the file dialog. */
  openRef?: MutableRefObject<(() => void) | null>;
  /** Called with the new invoice id right after a successful upload. */
  onUploaded?: (id: string) => void;
  /**
   * How many invoices are still in the backend queue (status `uploaded` or
   * `processing`). The dropzone stays disabled while > 0 so a new batch can't be
   * dropped on top of work that's still being extracted.
   */
  queuedCount?: number;
}

export function UploadDropzone({ openRef, onUploaded, queuedCount = 0 }: UploadDropzoneProps) {
  // useBatchUpload uploads each file on its OWN awaited promise, so every row
  // reliably gets its invoice id + per-file progress — unlike a shared mutation
  // whose per-call onSuccess only fires for the last mutate() (which left most
  // rows stuck on "Uploading…" even after the server finished).
  const { rows, active, start, reset } = useBatchUpload();

  // Single source of truth for the batch's live state (resolved from the
  // invoices cache, same as the panel) — so "done"/"failed" here and in the
  // panel always agree, instead of one reading global SQL stats that lag.
  const batch = useResolvedUploadRows(rows);
  const single = rows.length === 1;

  const handleDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const isSingle = files.length === 1;
    const { firstId } = await start(files);
    // Single drop → jump straight to the invoice detail and clear the panel.
    // Multi drop → leave the panel up as the overview (user clicks a row / Done).
    if (isSingle && firstId) {
      reset();
      onUploaded?.(firstId);
    }
  };

  const handleReject = (rejections: FileRejection[]) => {
    rejections.forEach(({ file, errors }) => {
      notifications.show({
        color: 'red',
        title: `Rejected — ${file.name}`,
        message: errors[0]?.message ?? 'File not accepted',
      });
    });
  };

  // The zone shows the progress panel whenever a batch exists — for a single
  // file too, so the upload phase (and any failure) is visible instead of a
  // frozen-looking idle zone. A single SUCCESS clears itself via handleDrop and
  // jumps to detail, so the panel only lingers for multi-file or a failure.
  const showPanel = rows.length > 0 && !(single && active);
  // While a single file is still uploading, show a lightweight inline state
  // rather than the full panel (which would flash for one row).
  const singleUploading = single && active;

  // The dropzone is inert while a batch exists, while uploading, OR while the
  // backend queue still has work (`queuedCount` = uploaded + processing). The
  // queue part is the key guard: uploads finish long before extraction does, so
  // a new drop mustn't pile onto a draining queue.
  const queueBusy = queuedCount > 0;
  const busy = active || showPanel || singleUploading || queueBusy;

  // Auto-clear a CLEAN finished panel (no failures). With a failure we leave it
  // up so the user sees what went wrong and dismisses it. Keyed on the panel's
  // OWN live-resolved state (batch.allDone/failed), not the lagging global stats.
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(dismissTimer.current);
    if (showPanel && batch.allDone && batch.failed === 0) {
      dismissTimer.current = setTimeout(reset, AUTO_DISMISS_MS);
    }
    return () => clearTimeout(dismissTimer.current);
  }, [showPanel, batch.allDone, batch.failed, reset]);

  return (
    <Stack gap="xs">
      {showPanel ? (
        // The dropzone "becomes" the progress indicator while a batch runs —
        // one view, no overlapping loaders/overlays.
        <UploadProgress
          batch={batch}
          onOpenInvoice={(id) => {
            // Only tear down once everything is settled; mid-batch we just
            // navigate (reset() would early-return on the active guard anyway,
            // leaving a confusing blank zone).
            if (batch.allDone) reset();
            onUploaded?.(id);
          }}
          onDone={reset}
        />
      ) : singleUploading || queueBusy ? (
        // Single file still sending, OR no live batch of ours but the backend
        // queue is still draining. Keep the zone inert with a compact status.
        <Group
          role="status"
          aria-live="polite"
          aria-busy
          justify="center"
          gap="sm"
          mih={120}
          style={{
            border: '1px dashed var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-md)',
          }}
        >
          <Loader size="md" />
          <Text size="lg" fw={500}>
            {singleUploading
              ? 'Uploading…'
              : `Processing ${queuedCount} document${queuedCount === 1 ? '' : 's'}…`}
          </Text>
        </Group>
      ) : (
        // Idle: the normal drop target. `disabled` while busy keeps the element
        // MOUNTED (openRef/focus/aria-label survive) but inert.
        <Dropzone
          openRef={openRef}
          onDrop={handleDrop}
          onReject={handleReject}
          accept={ACCEPTED}
          maxSize={MAX_SIZE_MB * 1024 ** 2}
          multiple
          radius="md"
          disabled={busy}
          aria-label="Upload invoice"
        >
          <Group justify="center" gap="xl" mih={120} style={{ pointerEvents: 'none' }}>
            <Dropzone.Accept>
              <IconUpload size={44} stroke={1.5} color="var(--mantine-color-indigo-6)" />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX size={44} stroke={1.5} color="var(--mantine-color-red-6)" />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconCloudUpload size={44} stroke={1.5} color="var(--mantine-color-dimmed)" />
            </Dropzone.Idle>
            <Stack gap={6}>
              <Text size="lg" inline>
                Drag an invoice here or click to browse
              </Text>
              <Group gap={6}>
                <Badge size="sm" variant="light" color="red">
                  PDF
                </Badge>
                <Badge size="sm" variant="light" color="blue">
                  PNG
                </Badge>
                <Badge size="sm" variant="light" color="blue">
                  JPEG
                </Badge>
                <Text size="xs" c="dimmed">
                  up to {MAX_SIZE_MB} MB
                </Text>
              </Group>
            </Stack>
          </Group>
        </Dropzone>
      )}
    </Stack>
  );
}
