import { useEffect, useRef } from 'react';
import {
  Avatar,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  TypographyStylesProvider,
} from '@mantine/core';
import { IconCheck, IconRobot, IconTrash, IconX } from '@tabler/icons-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AssistantStep,
  ChartSpec,
  ChatMessage,
  CompactInvoice,
  NavigateIntent,
  Suggestion,
} from '../../types/assistant';
import type { InvoiceStats } from '../../types/stats';
import { useInvoiceUI } from '../../invoice-ui/InvoiceUIContext';
import { ChatChart } from './ChatChart';
import { ChatInvoiceList } from './ChatInvoiceList';
import { ChatStats } from './ChatStats';
import { ToolActionList } from './ToolActionList';

interface MessageBubbleProps {
  message: ChatMessage;
  onConfirm?: (token: string, approved: boolean) => void;
  /** Send a suggested prompt when the user clicks a suggestion button. */
  onPick?: (prompt: string) => void;
  /** Wide/expanded panel — rich content (cards/charts) gets a roomier bubble. */
  wide?: boolean;
}

/**
 * Strip fabricated chart image markdown some models emit (e.g. ![](/chart/0),
 * ![](data:image/png;base64,{{...}}) ). The real chart is drawn by ChatChart, so
 * these only render as broken-image icons. Removes the image and tidies blank lines.
 */
function sanitizeContent(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** De-dupe invoices surfaced across this message's tool actions, preserving order. */
function collectInvoices(message: ChatMessage): CompactInvoice[] {
  const seen = new Set<string>();
  const out: CompactInvoice[] = [];
  for (const a of message.actions ?? []) {
    const list = [...(a.data?.invoices ?? []), ...(a.data?.invoice ? [a.data.invoice] : [])];
    for (const inv of list) {
      if (inv && !seen.has(inv.id)) {
        seen.add(inv.id);
        out.push(inv);
      }
    }
  }
  return out;
}

export function MessageBubble({ message, onConfirm, onPick, wide }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const ui = useInvoiceUI();

  // Clickable next-step suggestions the assistant offered (suggest_actions),
  // de-duped by label across this message's actions.
  const suggestions: Suggestion[] = [];
  const seenSug = new Set<string>();
  for (const a of message.actions ?? []) {
    for (const s of a.data?.suggestions ?? []) {
      if (s?.label && s?.prompt && !seenSug.has(s.label)) {
        seenSug.add(s.label);
        suggestions.push(s);
      }
    }
  }

  const stats: InvoiceStats | undefined = message.actions?.find(
    (a) => a.tool === 'get_invoice_stats' && a.data?.stats,
  )?.data?.stats;

  // Any charts the assistant rendered (render_chart tool), in order.
  const charts: ChartSpec[] = (message.actions ?? [])
    .map((a) => a.data?.chart)
    .filter((c): c is ChartSpec => !!c);

  const invoices = collectInvoices(message);
  // A message carrying cards/charts gets a wider bubble so they breathe; plain
  // text stays narrower for readability.
  const hasRich = !!stats || charts.length > 0 || invoices.length > 0;

  // Execute side-effecting intents the assistant returned — once per message:
  // navigate_ui (drive the UI) and export_invoices (start a file download).
  const sideEffected = useRef(false);
  useEffect(() => {
    if (isUser || sideEffected.current || message.pending) return;
    const actions = message.actions ?? [];
    const intents = actions
      .map((a) => a.data?.navigate)
      .filter((n): n is NavigateIntent => !!n);
    const downloads = actions
      .map((a) => a.data?.download)
      .filter((d): d is NonNullable<typeof d> => !!d && d.count > 0);
    if (intents.length || downloads.length) {
      sideEffected.current = true;
      intents.forEach((i) => ui.applyNavigation(i));
      downloads.forEach((d) => void ui.downloadExportUrl(d.url, d.filename));
    }
  }, [isUser, message.actions, message.pending, ui]);

  // Bubble max width: user text and plain answers stay readable; rich payloads
  // (and wide mode) get more room so cards/charts don't squish.
  const maxW = isUser ? '85%' : hasRich ? '100%' : wide ? '75%' : '92%';

  return (
    <Group
      justify={isUser ? 'flex-end' : 'flex-start'}
      gap="xs"
      wrap="nowrap"
      align="flex-start"
      style={{ minWidth: 0 }}
    >
      {!isUser && (
        <Avatar color="indigo" radius="xl" size="sm" style={{ flexShrink: 0 }}>
          <IconRobot size={16} />
        </Avatar>
      )}
      <Paper
        p="sm"
        radius="md"
        maw={maxW}
        bg={isUser ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-hover)'}
        c={isUser ? 'white' : undefined}
        style={{ minWidth: 0, flex: hasRich ? 1 : undefined }}
      >
        {message.pending ? (
          <LiveSteps steps={message.steps ?? []} />
        ) : (
          <Stack gap="xs" style={{ minWidth: 0 }}>
            {/* Prose answer FIRST — the user reads the reply, then sees the
                artefacts (stats/charts/cards) that back it up underneath. */}
            {isUser ? (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {message.content}
              </Text>
            ) : (
              message.content && (
                <TypographyStylesProvider fz="sm" className="chat-md" style={{ minWidth: 0 }}>
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {sanitizeContent(message.content)}
                  </Markdown>
                </TypographyStylesProvider>
              )
            )}

            {/* Confirmation stays right under the text — it's part of the reply,
                the user needs to act on it before anything happens. */}
            {!isUser && message.confirm && onConfirm && (
              <Group gap="xs">
                <Button
                  size="xs"
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => onConfirm(message.confirm!.token, true)}
                >
                  Confirm delete
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconX size={14} />}
                  onClick={() => onConfirm(message.confirm!.token, false)}
                >
                  Cancel
                </Button>
              </Group>
            )}

            {/* Artefacts come AFTER the prose: stats, charts, then invoice cards. */}
            {!isUser && stats && <ChatStats stats={stats} />}

            {!isUser &&
              charts.map((c, i) => <ChatChart key={i} chart={c} />)}

            {!isUser && invoices.length > 0 && <ChatInvoiceList invoices={invoices} />}

            {/* Clickable next-step suggestions — clicking sends the prompt. */}
            {!isUser && onPick && suggestions.length > 0 && (
              <Group gap={6} mt={4}>
                {suggestions.map((s) => (
                  <Button
                    key={s.label}
                    size="xs"
                    variant="light"
                    radius="xl"
                    onClick={() => onPick(s.prompt)}
                  >
                    {s.label}
                  </Button>
                ))}
              </Group>
            )}

            {/* The "Actions taken" technical summary stays at the very bottom. */}
            {!isUser && message.actions && message.actions.length > 0 && (
              <ToolActionList actions={message.actions} />
            )}
          </Stack>
        )}
      </Paper>
    </Group>
  );
}

/**
 * Live progress shown while a reply streams in: the latest step is "active"
 * (spinner + label); earlier steps are shown done (check). Falls back to a
 * plain "Thinking…" before the first step arrives (or if streaming is off).
 */
function LiveSteps({ steps }: { steps: AssistantStep[] }) {
  if (steps.length === 0) {
    return (
      <Group gap={8} wrap="nowrap" align="center">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Thinking…
        </Text>
      </Group>
    );
  }

  // Collapse consecutive "thinking" steps into the most recent one so the list
  // reads as distinct actions, not a stack of identical "Thinking" rows.
  const shown = steps.filter(
    (s, i) => !(s.kind === 'thinking' && steps[i + 1]?.kind === 'thinking'),
  );
  const lastIdx = shown.length - 1;

  return (
    <Stack gap={6} style={{ minWidth: 0 }}>
      {shown.map((step, i) => {
        const active = i === lastIdx;
        return (
          <Group key={i} gap={8} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
            {active ? (
              <Loader size={14} style={{ flexShrink: 0 }} />
            ) : (
              <ThemeIcon size="sm" radius="xl" variant="light" color="teal" style={{ flexShrink: 0 }}>
                <IconCheck size={12} />
              </ThemeIcon>
            )}
            <Text
              size="sm"
              c={active ? undefined : 'dimmed'}
              fw={active ? 500 : 400}
              style={{ minWidth: 0, overflowWrap: 'anywhere' }}
            >
              {step.label}
              {active && step.kind === 'thinking' ? '…' : ''}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}
