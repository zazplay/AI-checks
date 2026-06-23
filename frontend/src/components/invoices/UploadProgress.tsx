import {
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconFileInvoice } from '@tabler/icons-react';
import { humanizeError } from '../../lib/format';
import type { ResolvedUploadBatch, UploadStage } from '../../hooks/useResolvedUploadRows';

/**
 * Map a stage to a target progress fraction (0..1), a color, a label and an
 * icon. The bar animates smoothly toward each target (CSS transition), so it
 * glides through the stages like a loading bar:
 *   upload → 4..35%, queued → 50%, extracting → 85%, completed → 100%.
 * A failed stage stops short of full so a red bar doesn't read as "complete".
 */
function stageInfo(stage: UploadStage, uploadPct: number) {
  switch (stage) {
    case 'sending':
      return {
        value: 0.04 + Math.min(1, Math.max(0, uploadPct)) * 0.31, // 4%..35% by bytes
        color: 'indigo',
        label: 'Uploading…',
        animated: true,
      };
    case 'uploaded':
      return { value: 0.5, color: 'indigo', label: 'Queued', animated: true };
    case 'processing':
      return { value: 0.85, color: 'indigo', label: 'Extracting…', animated: true };
    case 'completed':
      return { value: 1, color: 'teal', label: 'Completed', animated: false };
    case 'failed':
      return { value: 0.85, color: 'red', label: 'Failed', animated: false };
    case 'upload-failed':
      return { value: 0.35, color: 'red', label: 'Upload failed', animated: false };
  }
}

/** Small status indicator for a mini-card: a spinner while working, a glyph once settled. */
function StatusIndicator({ stage, color }: { stage: UploadStage; color: string }) {
  if (stage === 'sending' || stage === 'uploaded' || stage === 'processing') {
    return <Loader size={12} color={color} />;
  }
  if (stage === 'completed') return <IconCircleCheck size={14} color={`var(--mantine-color-${color}-6)`} />;
  return <IconAlertTriangle size={14} color={`var(--mantine-color-${color}-6)`} />;
}

interface UploadProgressProps {
  /** Live-resolved batch (single source of truth, shared with the parent). */
  batch: ResolvedUploadBatch;
  /** Click a settled row to open that invoice's detail. */
  onOpenInvoice?: (id: string) => void;
  /** Dismiss the panel (only shown once everything has settled). */
  onDone: () => void;
}

/**
 * In-place upload/processing overview that REPLACES the dropzone while a batch
 * is in flight (the dropzone "becomes" this indicator). One loader-driven view,
 * no overlays: an overall bar at the top, a per-file list with smooth stage
 * bars, errors inline, and a Done button once everything settles.
 */
export function UploadProgress({ batch, onOpenInvoice, onDone }: UploadProgressProps) {
  const { rows, total, done, failed, allDone } = batch;

  // Aggregate progress across the whole batch (average of per-row targets), so
  // the header bar reflects overall completion, not just the last file.
  const overall =
    total > 0 ? rows.reduce((sum, r) => sum + stageInfo(r.stage, r.uploadPct).value, 0) / total : 0;

  const succeeded = done - failed;
  const accent = allDone ? (failed ? 'red' : 'teal') : 'indigo';
  const headline = allDone
    ? failed
      ? `Finished — ${failed} of ${total} failed`
      : `All ${total} done`
    : `${done} of ${total} done…`;

  // Done button: green when all succeeded, yellow when some failed (partial),
  // red only when everything failed. Label shows the processed/failed split.
  const allFailed = failed === total;
  const doneColor = failed === 0 ? 'teal' : allFailed ? 'red' : 'yellow';
  const doneLabel = failed === 0 ? `Done · ${succeeded}/${total}` : `Done · ${succeeded} ok, ${failed} failed`;

  return (
    <Box
      role="group"
      aria-label="Upload progress"
      aria-busy={!allDone}
      mih={120}
      p="md"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
      }}
    >
      <Stack gap="md">
        {/* Overall batch progress — glides to 100% as every file settles. Only
            the headline is a live region, so screen readers get one concise
            announcement per change, not a flood from every per-row tick. */}
        <Box>
          <Group justify="space-between" mb={8} wrap="nowrap" align="center">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} truncate role="status" aria-live="polite">
                {headline}
              </Text>
              <Badge variant="light" color={accent} size="sm" style={{ flexShrink: 0 }}>
                {Math.round(overall * 100)}%
              </Badge>
            </Group>
            {allDone && (
              <Button
                size="sm"
                variant="filled"
                color={doneColor}
                onClick={onDone}
                leftSection={
                  failed === 0 ? <IconCircleCheck size={18} /> : <IconAlertTriangle size={18} />
                }
                // Lift it slightly above the headline row and make the
                // interactive affordance obvious: a filled button that pops on
                // hover (shadow + nudge up) and a pointer cursor.
                mt={-4}
                px="lg"
                styles={{
                  root: {
                    flexShrink: 0,
                    cursor: 'pointer',
                    fontWeight: 600,
                    boxShadow: 'var(--mantine-shadow-xs)',
                    transition: 'transform 100ms ease, box-shadow 100ms ease',
                  },
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = 'var(--mantine-shadow-sm)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'var(--mantine-shadow-xs)';
                }}
              >
                {doneLabel}
              </Button>
            )}
          </Group>
          <Progress
            value={Math.round(overall * 100)}
            color={accent}
            size={16}
            radius="xl"
            striped={!allDone}
            animated={!allDone}
            transitionDuration={600}
          />
        </Box>

        {/* Files as a grid of small cards — 6 per row on roomy screens, fewer as
            it narrows. Each card: a document icon, the (truncated) name, and a
            small loader/status glyph with its label. */}
        <ScrollArea.Autosize mah={300} type="auto" scrollbars="y" style={{ minWidth: 0 }}>
          <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 6 }} spacing="xs" aria-live="off">
            {rows.map((r) => {
              const info = stageInfo(r.stage, r.uploadPct);
              const isError = r.stage === 'failed' || r.stage === 'upload-failed';
              const clickable = !!r.id && r.stage !== 'sending';
              const tooltip =
                isError && r.errorMessage ? `${r.name} — ${humanizeError(r.errorMessage)}` : r.name;
              return (
                <Tooltip key={r.key} label={tooltip} withArrow multiline maw={260} openDelay={300}>
                  <Stack
                    gap={6}
                    align="center"
                    p="xs"
                    onClick={() => clickable && r.id && onOpenInvoice?.(r.id)}
                    style={{
                      border: `1px solid ${
                        isError ? 'var(--mantine-color-red-4)' : 'var(--mantine-color-default-border)'
                      }`,
                      borderRadius: 'var(--mantine-radius-md)',
                      cursor: clickable ? 'pointer' : 'default',
                      minWidth: 0,
                    }}
                  >
                    <ThemeIcon
                      variant="light"
                      color={isError ? 'red' : 'gray'}
                      size="lg"
                      radius="md"
                    >
                      <IconFileInvoice size={20} />
                    </ThemeIcon>
                    <Text size="xs" fw={500} truncate w="100%" ta="center" title={r.name}>
                      {r.name}
                    </Text>
                    <Group gap={4} wrap="nowrap" justify="center" style={{ minWidth: 0 }}>
                      <StatusIndicator stage={r.stage} color={info.color} />
                      <Text size="10px" c={info.color === 'red' ? 'red' : 'dimmed'} truncate>
                        {info.label}
                      </Text>
                    </Group>
                  </Stack>
                </Tooltip>
              );
            })}
          </SimpleGrid>
        </ScrollArea.Autosize>
      </Stack>
    </Box>
  );
}
