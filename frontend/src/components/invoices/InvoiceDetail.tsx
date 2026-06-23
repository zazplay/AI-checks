import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Code,
  CopyButton,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  RingProgress,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconCode,
  IconCopy,
  IconDownload,
  IconEye,
  IconFileInvoice,
  IconFileText,
  IconListCheck,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useRetryInvoice } from '../../hooks/useRetryInvoice';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import {
  fieldLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  formatMoney,
  humanizeError,
} from '../../lib/format';
import type {
  ExtractedInvoice,
  Invoice,
  InvoiceStatus,
  ProcessingAttempt,
} from '../../types/invoice';
import { DocumentPreview } from './DocumentPreview';
import { InvoiceThumb } from './InvoiceThumb';

/** Status → Mantine palette. The "AI/sparkle" accent is grape. */
const STATUS_COLOR: Record<InvoiceStatus, string> = {
  uploaded: 'gray',
  processing: 'blue',
  completed: 'teal',
  failed: 'red',
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  uploaded: 'NO FILE',
  processing: 'PROCESSING',
  completed: 'COMPLETED',
  failed: 'FAILED',
};

/** Header pill: a colored dot + status label, themed via Mantine tokens. */
function StatusPill({ status }: { status: InvoiceStatus }) {
  const color = STATUS_COLOR[status];
  const pulsing = status === 'processing' || status === 'uploaded';
  return (
    <Badge
      variant="light"
      color={color}
      size="lg"
      radius="xl"
      tt="uppercase"
      leftSection={
        <Box
          w={6}
          h={6}
          style={{
            borderRadius: '50%',
            background: `var(--mantine-color-${color}-6)`,
            boxShadow:
              status === 'completed'
                ? `0 0 8px var(--mantine-color-${color}-5)`
                : undefined,
            animation: pulsing ? 'invDotPulse 1.2s ease-in-out infinite' : undefined,
          }}
        />
      }
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** One vertical timeline row: colored dot + label + monospaced timestamp. */
/** Timeline geometry. Dots align to the TOP of each row so the first dot's
 *  centre sits at TL_DOT/2 — exactly where the track line starts. */
const TL_DOT = 16;
const TL_GAP = 36; // vertical gap below each step (drives dot spacing)

function TimelineStep({
  label,
  time,
  color,
  active,
  dim,
  last,
}: {
  label: string;
  time: string;
  color: string;
  active?: boolean;
  dim?: boolean;
  last?: boolean;
}) {
  return (
    <Group gap={14} align="flex-start" wrap="nowrap" mb={last ? 0 : TL_GAP}>
      <Box
        w={TL_DOT}
        h={TL_DOT}
        style={{
          flexShrink: 0,
          zIndex: 1,
          borderRadius: '50%',
          border: '3px solid var(--mantine-color-body)',
          boxShadow: dim ? undefined : `0 0 0 1px var(--mantine-color-${color}-6)`,
          background: dim
            ? 'var(--mantine-color-default-border)'
            : `var(--mantine-color-${color}-6)`,
          animation: active ? 'invDotPulse 1.2s ease-in-out infinite' : undefined,
        }}
      />
      <div style={{ minWidth: 0, lineHeight: 1.3, marginTop: -1 }}>
        <Text size="sm" fw={600} c={dim ? 'dimmed' : undefined}>
          {label}
        </Text>
        <Text size="xs" c="dimmed" ff="monospace">
          {time}
        </Text>
      </div>
    </Group>
  );
}

/** The left-rail timeline: Uploaded → Processing → Completed/Failed, with a gradient fill line. */
function StatusTimeline({ invoice }: { invoice: Invoice }) {
  const { status } = invoice;
  const failed = status === 'failed';
  const completed = status === 'completed';
  const processing = status === 'processing';
  const uploaded = status === 'uploaded';
  const done = completed || failed;

  // Gradient fill height mirrors the mockup: pre-processing < processing < done.
  const fillHeight = uploaded
    ? '8%'
    : processing || failed
      ? '50%'
      : completed
        ? '100%'
        : '0%';

  // Dots are top-aligned, so the first dot's centre is at TL_DOT/2 and the
  // last dot's centre is TL_DOT/2 up from the bottom. The track spans exactly
  // between those two centres (top + bottom anchored), so it never overshoots
  // above the first dot.
  const lineEnd = TL_DOT / 2; // distance from container top/bottom to a dot centre
  const lineLeft = TL_DOT / 2 - 1; // centre the 2px line under the dots

  return (
    <Box pos="relative">
      {/* track */}
      <Box
        pos="absolute"
        left={lineLeft}
        top={lineEnd}
        bottom={lineEnd}
        w={2}
        style={{ background: 'var(--mantine-color-default-border)' }}
      />
      {/* gradient fill — grows from the top dot down */}
      <Box
        pos="absolute"
        left={lineLeft}
        top={lineEnd}
        w={2}
        style={{
          height: `calc((100% - ${TL_DOT}px) * ${parseInt(fillHeight) / 100})`,
          background:
            'linear-gradient(var(--mantine-color-blue-6), var(--mantine-color-teal-6))',
          transition: 'height .4s',
          borderRadius: 2,
        }}
      />

      <TimelineStep
        label="Uploaded"
        time={formatDateTime(invoice.createdAt)}
        color="blue"
      />
      <TimelineStep
        label="Processing"
        color={failed ? 'red' : 'blue'}
        active={processing}
        dim={uploaded}
        time={
          processing
            ? 'In progress…'
            : failed
              ? `Failed · attempt ${invoice.attempts}`
              : uploaded
                ? 'Waiting for worker'
                : invoice.attempts > 0
                  ? `${invoice.attempts} attempt(s)`
                  : '—'
        }
      />
      <TimelineStep
        label={failed ? 'Failed' : 'Completed'}
        color={failed ? 'red' : 'teal'}
        dim={!done}
        last
        time={done ? formatDateTime(invoice.updatedAt) : 'Pending'}
      />
    </Box>
  );
}

/** Sparkle pill showing the extraction engine. Orange for retry/pdf-text/groq, else grape. */
function EngineBadge({ source }: { source: string }) {
  const color = /retry|pdf-text|groq/i.test(source) ? 'orange' : 'grape';
  return (
    <Badge
      variant="light"
      color={color}
      radius="xl"
      leftSection={<IconSparkles size={12} />}
      ff="monospace"
      tt="none"
    >
      {source}
    </Badge>
  );
}

/** Compact uppercase field label + value (value monospaced when `mono`). */
function ExtractField({
  label,
  value,
  empty,
  mono,
}: {
  label: string;
  value: string;
  empty?: boolean;
  mono?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4} style={{ letterSpacing: '0.08em' }}>
        {label}
      </Text>
      <Text
        size="sm"
        fw={500}
        truncate
        title={value}
        c={empty ? 'dimmed' : undefined}
        fs={empty ? 'italic' : undefined}
        ff={mono ? 'monospace' : undefined}
      >
        {value}
      </Text>
    </div>
  );
}

/** A summary amount card; the Total card is highlighted in teal. */
function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Paper
      withBorder
      radius="md"
      px="sm"
      py="xs"
      style={{
        flex: highlight ? 1.2 : 1,
        borderColor: highlight ? 'var(--mantine-color-teal-filled)' : undefined,
        background: highlight
          ? 'var(--mantine-color-teal-light)'
          : 'var(--mantine-color-default)',
      }}
    >
      <Text
        size="xs"
        fw={600}
        tt="uppercase"
        c={highlight ? 'teal' : 'dimmed'}
        style={{ letterSpacing: '0.06em' }}
      >
        {label}
      </Text>
      <Text
        fw={highlight ? 700 : 600}
        size={highlight ? 'lg' : 'md'}
        ff="monospace"
        mt={3}
        c={highlight ? 'teal' : undefined}
      >
        {value}
      </Text>
    </Paper>
  );
}

/** The completed-state extraction view: fields, summary cards and a line-item
 *  table. Fills its parent's height; only the line-item list scrolls, so the
 *  fields/totals above and the Explain button below stay visible. */
function ExtractedPanel({ data }: { data: ExtractedInvoice }) {
  return (
    <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm" verticalSpacing="sm" style={{ flexShrink: 0 }}>
        <ExtractField label="Vendor" value={data.vendorName ?? '—'} empty={data.vendorName == null} />
        <ExtractField
          label="Invoice #"
          value={data.invoiceNumber ?? '—'}
          empty={data.invoiceNumber == null}
          mono
        />
        <ExtractField
          label="Invoice date"
          value={formatDate(data.invoiceDate)}
          empty={data.invoiceDate == null}
        />
        <ExtractField label="Due date" value={formatDate(data.dueDate)} empty={data.dueDate == null} />
      </SimpleGrid>

      <Group gap="sm" grow={false} wrap="nowrap" align="stretch" style={{ flexShrink: 0 }}>
        <SummaryCard label="Subtotal" value={formatMoney(data.subtotal, data.currency)} />
        <SummaryCard label="Tax" value={formatMoney(data.tax, data.currency)} />
        <SummaryCard
          label={`Total${data.currency ? ` ${data.currency}` : ''}`}
          value={formatMoney(data.total, data.currency)}
          highlight
        />
      </Group>

      {/* Line items — the only part that scrolls when there are many rows. */}
      <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
        <Text
          size="xs"
          fw={600}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: '0.08em', flexShrink: 0 }}
        >
          Line items ({data.lineItems.length})
        </Text>
        {data.lineItems.length > 0 ? (
          <ScrollArea type="auto" style={{ flex: 1, minHeight: 80 }}>
            <Table
              withTableBorder
              verticalSpacing={6}
              horizontalSpacing="md"
              highlightOnHover
              stickyHeader
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Description</Table.Th>
                  <Table.Th ta="right">Qty</Table.Th>
                  <Table.Th ta="right">Unit price</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.lineItems.map((item, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{item.description}</Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {item.quantity ?? '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatMoney(item.unitPrice, data.currency)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>
                      {formatMoney(item.amount, data.currency)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            No line items were extracted.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/** Live-ish processing steps with check / spinner / idle markers. */
const PROCESSING_STEPS = [
  'Reading document',
  'Detecting fields',
  'Extracting line items',
  'Validating totals',
];

function ProcessingSteps() {
  // We don't have real sub-step progress; show the first as in-progress and the
  // rest as upcoming, which reads as a live extraction without faking completion.
  const active = 0;
  return (
    <Stack gap="sm">
      {PROCESSING_STEPS.map((label, i) => {
        const isActive = i === active;
        return (
          <Group key={label} gap="sm" wrap="nowrap">
            {isActive ? (
              <Loader size={20} color="grape" />
            ) : (
              <Box
                w={20}
                h={20}
                style={{
                  flexShrink: 0,
                  borderRadius: '50%',
                  border: '2px solid var(--mantine-color-default-border)',
                }}
              />
            )}
            <Text size="sm" fw={isActive ? 600 : 500} c={isActive ? undefined : 'dimmed'}>
              {label}
            </Text>
            {isActive && (
              <Text size="xs" c="grape" ff="monospace" ml="auto">
                ···
              </Text>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}

/** Per-attempt processing log: which engine was tried, the outcome, and why a
 *  fallback/retry happened. Gives full visibility into the extraction run. */
const LOG_OUTCOME: Record<
  ProcessingAttempt['outcome'],
  { color: string; icon: typeof IconCheck; label: string }
> = {
  ok: { color: 'teal', icon: IconCheck, label: 'ok' },
  problem: { color: 'yellow', icon: IconAlertTriangle, label: 'fell back' },
  error: { color: 'red', icon: IconX, label: 'error' },
  skipped: { color: 'gray', icon: IconArrowRight, label: 'skipped' },
};

function ProcessingLogView({ log }: { log: ProcessingAttempt[] }) {
  return (
    <Stack gap={8}>
      {log.map((a, i) => {
        const meta = LOG_OUTCOME[a.outcome];
        const Icon = meta.icon;
        return (
          <Group key={i} gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon variant="light" color={meta.color} size="sm" radius="xl" mt={1} style={{ flexShrink: 0 }}>
              <Icon size={12} />
            </ThemeIcon>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Group gap={6} wrap="nowrap" justify="space-between">
                <Text size="sm" fw={500} ff="monospace" truncate title={a.engine}>
                  {a.engine}
                </Text>
                <Badge size="xs" variant="light" color={meta.color} tt="none" style={{ flexShrink: 0 }}>
                  {meta.label}
                </Badge>
              </Group>
              {a.reason && (
                <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>
                  {a.reason}
                </Text>
              )}
            </div>
            <Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
              #{a.jobAttempt}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}

interface InvoiceDetailProps {
  invoice: Invoice | undefined;
  onRequestDelete: (invoice: Invoice) => void;
  onClose: () => void;
}

export function InvoiceDetail({ invoice, onRequestDelete, onClose }: InvoiceDetailProps) {
  const retry = useRetryInvoice();
  const ui = useInvoiceUI();
  const explaining = ui.explainState.loading && ui.explainState.invoice?.id === invoice?.id;
  const [previewOpened, { open: openPreview, close: closePreview }] = useDisclosure(false);
  const [rawOpened, { open: openRaw, close: closeRaw }] = useDisclosure(false);
  const isMobile = useMediaQuery('(max-width: 48em)');

  if (!invoice) {
    return (
      <Center mih={200} p="xl">
        <Stack align="center" gap="sm">
          <ThemeIcon variant="light" color="gray" size={56} radius="xl">
            <IconFileInvoice size={28} />
          </ThemeIcon>
          <Text c="dimmed">Select an invoice to see its details</Text>
        </Stack>
      </Center>
    );
  }

  const { status, extractedData } = invoice;
  const hasFile = status !== 'uploaded';
  const isProcessing = status === 'processing' || status === 'uploaded';
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const retrying = retry.isPending && retry.variables === invoice.id;

  return (
    <>
      {/* keyframes used by the status dots / timeline pulse */}
      <style>{`@keyframes invDotPulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>

      <Stack gap={0} style={{ height: isMobile ? undefined : '100%' }}>
        {/* ============ HEADER ============ */}
        <Group justify="space-between" wrap="nowrap" px="md" py="sm" style={{ flexShrink: 0 }}>
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text fw={600} size="md" style={{ flexShrink: 0 }}>
              Invoice details
            </Text>
            <StatusPill status={status} />
          </Group>
          <ActionIcon variant="default" radius="md" size="lg" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </ActionIcon>
        </Group>

        <Divider style={{ flexShrink: 0 }} />

        {/* ============ BODY: split grid (fills remaining height) ============ */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '340px 1fr',
            flex: isMobile ? undefined : 1,
            minHeight: 0,
          }}
        >
          {/* ---------- LEFT RAIL ---------- */}
          <Stack
            gap={0}
            p="md"
            style={{
              borderRight: isMobile ? undefined : '1px solid var(--mantine-color-default-border)',
              borderBottom: isMobile ? '1px solid var(--mantine-color-default-border)' : undefined,
              background: 'var(--mantine-color-default)',
              minHeight: 0,
              overflowY: isMobile ? undefined : 'auto',
            }}
          >
            {/* preview thumbnail */}
            <Paper withBorder radius="md" style={{ overflow: 'hidden', flexShrink: 0 }}>
              <InvoiceThumb invoice={invoice} height={200} />
            </Paper>

            {/* file meta */}
            <Group gap="sm" wrap="nowrap" mt="md">
              <ThemeIcon variant="light" color="red" size={32} radius="md">
                <IconFileText size={16} />
              </ThemeIcon>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm" fw={600} truncate title={invoice.originalFilename}>
                  {invoice.originalFilename}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  {formatBytes(invoice.fileSize)} · {invoice.mimeType}
                </Text>
              </div>
            </Group>

            {/* actions */}
            <Group gap="xs" mt="md" wrap="wrap">
              {hasFile && (
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconEye size={14} />}
                  onClick={openPreview}
                >
                  Preview
                </Button>
              )}
              {hasFile && (
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconDownload size={14} />}
                  onClick={() => void ui.download(invoice)}
                >
                  Download
                </Button>
              )}
              <CopyButton value={invoice.id}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied!' : `Copy ID ${invoice.id.slice(0, 8)}…`}>
                    <Button
                      variant="default"
                      size="xs"
                      color={copied ? 'teal' : undefined}
                      leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      onClick={copy}
                    >
                      ID
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
              <Button
                variant="subtle"
                size="xs"
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={() => onRequestDelete(invoice)}
              >
                Delete
              </Button>
            </Group>

            <Divider mt="md" mb="xs" />
            <StatusTimeline invoice={invoice} />

            {/* spacer absorbs any extra height below the timeline on desktop */}
            <Box style={{ flex: 1 }} mih={isMobile ? 0 : 8} />
          </Stack>

          {/* ---------- RIGHT PANEL ---------- */}
          {/* On desktop the panel itself never scrolls — only the line-item
              table inside ExtractedPanel does, so totals/Explain stay in view. */}
          <Box
            p="md"
            style={{
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              minHeight: 0,
              overflow: isMobile ? undefined : 'hidden',
            }}
          >
            {/* low-confidence / not-an-invoice warning (any state with data) */}
            {extractedData &&
              (extractedData.isInvoice === false || extractedData.confidence < 0.6) && (
                <Alert
                  color="yellow"
                  variant="light"
                  radius="md"
                  icon={<IconAlertTriangle size={18} />}
                  title="Low-confidence extraction"
                  mb="md"
                >
                  This file may not be an invoice
                  {extractedData.docType ? ` (looks like: ${extractedData.docType})` : ''}.
                  Confidence {Math.round(extractedData.confidence * 100)}%. Review the extracted
                  fields carefully.
                </Alert>
              )}

            {/* ---- PROCESSING / UPLOADED ---- */}
            {isProcessing && (
              <Stack gap="md">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    <ThemeIcon
                      variant="gradient"
                      gradient={{ from: 'grape', to: 'violet', deg: 135 }}
                      size={30}
                      radius="md"
                    >
                      <IconSparkles size={16} />
                    </ThemeIcon>
                    <div>
                      <Text size="sm" fw={600}>
                        {status === 'uploaded' ? 'Waiting for worker' : 'Extracting data'}
                      </Text>
                      <Text size="xs" c="dimmed" ff="monospace">
                        {extractedData?.extractionSource ?? 'AI extraction'}
                      </Text>
                    </div>
                  </Group>
                  <RingProgress
                    size={34}
                    thickness={3}
                    roundCaps
                    sections={[{ value: 100, color: 'grape' }]}
                  />
                </Group>

                <Progress
                  value={status === 'uploaded' ? 8 : 50}
                  color="grape"
                  size="sm"
                  radius="xl"
                  animated
                  striped
                />

                {/* Real per-attempt log streams in live via socket; until the
                    first attempt lands, show the generic steps. */}
                {invoice.processingLog && invoice.processingLog.length > 0 ? (
                  <ProcessingLogView log={invoice.processingLog} />
                ) : (
                  <ProcessingSteps />
                )}

                <Divider my={4} />
                <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md" style={{ opacity: 0.6 }}>
                  <Skeleton height={40} radius="md" />
                  <Skeleton height={40} radius="md" />
                </SimpleGrid>
                <Skeleton height={56} radius="md" style={{ opacity: 0.6 }} />
              </Stack>
            )}

            {/* ---- COMPLETED ---- */}
            {isCompleted && (
              <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
                <Group justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
                  <Text size="sm" fw={600}>
                    Extracted data
                  </Text>
                  {extractedData?.extractionSource && (
                    <EngineBadge source={extractedData.extractionSource} />
                  )}
                </Group>

                {extractedData ? (
                  <>
                    {/* AI data-quality note + missing fields */}
                    {(extractedData.note || (extractedData.missingFields?.length ?? 0) > 0) && (
                      <Alert
                        color="yellow"
                        variant="light"
                        radius="md"
                        icon={<IconAlertTriangle size={16} />}
                        title="AI notes"
                        style={{ flexShrink: 0 }}
                      >
                        <Stack gap={6}>
                          {extractedData.note && <Text size="sm">{extractedData.note}</Text>}
                          {(extractedData.missingFields?.length ?? 0) > 0 && (
                            <Group gap={4} wrap="wrap">
                              <Text size="xs" c="dimmed" fw={600}>
                                Missing:
                              </Text>
                              {extractedData.missingFields!.map((f) => (
                                <Badge
                                  key={f}
                                  size="xs"
                                  color="yellow"
                                  variant="outline"
                                  tt="none"
                                >
                                  {fieldLabel(f)}
                                </Badge>
                              ))}
                            </Group>
                          )}
                        </Stack>
                      </Alert>
                    )}

                    <ExtractedPanel data={extractedData} />

                    <Group style={{ flexShrink: 0 }}>
                      <Button
                        variant="gradient"
                        gradient={{ from: 'grape', to: 'violet', deg: 135 }}
                        leftSection={<IconSparkles size={16} />}
                        loading={explaining}
                        onClick={() => ui.explain(invoice)}
                      >
                        Explain with AI
                      </Button>
                      <Button
                        variant="default"
                        leftSection={<IconCode size={16} />}
                        onClick={openRaw}
                      >
                        Raw JSON
                      </Button>
                    </Group>
                  </>
                ) : (
                  <Text c="dimmed" size="sm">
                    Processing completed, but no data was extracted.
                  </Text>
                )}
              </Stack>
            )}

            {/* ---- FAILED ---- */}
            {isFailed && (
              <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
                <Stack align="center" gap="md" pt="lg" style={{ flexShrink: 0 }}>
                  <ThemeIcon variant="light" color="red" size={52} radius="md">
                    <IconAlertTriangle size={24} />
                  </ThemeIcon>
                  <Stack gap={4} align="center" maw={360}>
                    <Text fw={600} size="md">
                      Extraction failed
                    </Text>
                    <Text size="sm" c="dimmed" ta="center" lh={1.55}>
                      {humanizeError(invoice.errorMessage)}
                    </Text>
                  </Stack>
                  {invoice.attempts > 0 && <Code>{`${invoice.attempts} attempt(s)`}</Code>}
                  <Group gap="sm" mt={4}>
                    <Button
                      color="red"
                      leftSection={<IconRefresh size={16} />}
                      loading={retrying}
                      onClick={() => retry.mutate(invoice.id)}
                    >
                      Retry processing
                    </Button>
                    {hasFile && (
                      <Button
                        variant="default"
                        leftSection={<IconDownload size={16} />}
                        onClick={() => void ui.download(invoice)}
                      >
                        Download
                      </Button>
                    )}
                  </Group>
                </Stack>

                {/* Full attempt log — exactly what was tried and why it fell back. */}
                {invoice.processingLog && invoice.processingLog.length > 0 && (
                  <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
                    <Group gap={6} style={{ flexShrink: 0 }}>
                      <IconListCheck size={14} />
                      <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.08em' }}>
                        Processing log
                      </Text>
                    </Group>
                    <ScrollArea type="auto" style={{ flex: 1, minHeight: 60 }}>
                      <ProcessingLogView log={invoice.processingLog} />
                    </ScrollArea>
                  </Stack>
                )}
              </Stack>
            )}
          </Box>
        </Box>
      </Stack>

      {/* Nested preview modal — reuses the existing DocumentPreview. Sits ABOVE
          the invoice-detail modal (zIndex 400), otherwise this modal and its
          overlay render underneath it and are invisible. */}
      <Modal
        opened={previewOpened}
        onClose={closePreview}
        title={invoice.originalFilename}
        size="xl"
        centered
        fullScreen={!!isMobile}
        zIndex={500}
      >
        <DocumentPreview invoice={invoice} />
      </Modal>

      {/* Raw extracted JSON in its own window — keeps the detail panel scroll-free.
          Also above the detail modal (400) for the same reason as the preview. */}
      <Modal
        opened={rawOpened}
        onClose={closeRaw}
        title={
          <Group gap="xs">
            <IconCode size={16} />
            <Text fw={600}>Raw extracted JSON</Text>
          </Group>
        }
        size="lg"
        centered
        fullScreen={!!isMobile}
        zIndex={500}
      >
        <Stack gap="sm">
          <Group justify="flex-end">
            <CopyButton value={JSON.stringify(invoice.extractedData, null, 2)}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant="light"
                  color={copied ? 'teal' : 'gray'}
                  leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy JSON'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Code block style={{ maxHeight: '65vh', overflow: 'auto' }}>
            {JSON.stringify(invoice.extractedData, null, 2)}
          </Code>
        </Stack>
      </Modal>
    </>
  );
}
