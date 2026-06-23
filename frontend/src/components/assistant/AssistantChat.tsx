import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Box,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarRightCollapse,
  IconMessageChatbot,
  IconPlayerStopFilled,
  IconSend,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useAssistant } from '../../hooks/useAssistant';
import { MessageBubble } from './MessageBubble';
import { AssistantWelcome } from './AssistantWelcome';

interface AssistantChatProps {
  /** Whether the panel is in wide/expanded mode (changes the toggle icon/label). */
  expanded?: boolean;
  /** Toggle expanded/normal width. Omitted on mobile (overlay, no resize). */
  onToggleExpand?: () => void;
  /** Collapse the panel entirely. */
  onClose?: () => void;
}

export function AssistantChat({ expanded, onToggleExpand, onClose }: AssistantChatProps) {
  const { messages, send, confirmAction, reset, isPending, stop } = useAssistant();
  const [draft, setDraft] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  // Track the last message's pending state so we can tell "a reply just arrived"
  // (pending → settled) apart from "a new turn started" (user msg + pending).
  const prevTailRef = useRef<{ id?: string; pending?: boolean }>({});

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const tail = messages.at(-1);
    const prev = prevTailRef.current;
    prevTailRef.current = { id: tail?.id, pending: tail?.pending };

    // The assistant's answer just landed: the tail bubble is the same one that
    // was pending and is now settled. Scroll to the TOP of that bubble so the
    // user starts reading from the beginning of a long reply, not its end.
    const replyArrived =
      tail &&
      tail.role === 'assistant' &&
      !tail.pending &&
      prev.id === tail.id &&
      prev.pending === true;

    if (replyArrived) {
      const node = vp.querySelector<HTMLElement>(`[data-msg-id="${tail.id}"]`);
      if (node) {
        // Position the bubble's top near the viewport top (small breathing gap).
        // rect-based offset is robust to the nesting between viewport and bubble
        // (offsetTop would be relative to the wrong offsetParent here).
        const delta = node.getBoundingClientRect().top - vp.getBoundingClientRect().top;
        const top = Math.max(0, vp.scrollTop + delta - 12);
        vp.scrollTo({ top, behavior: 'smooth' });
        return;
      }
    }

    // Otherwise (new question sent, pending placeholder, reset) keep the latest
    // content in view by scrolling to the bottom.
    vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isPending) return;
    setDraft('');
    void send(text);
  };

  return (
    // The Aside has no padding now (so the resize handle can sit on its edge),
    // so the chat owns its own padding here. minWidth:0 lets every flex child
    // shrink below content width instead of overflowing a narrow panel.
    <Stack gap="sm" h="100%" p="md" style={{ minWidth: 0 }}>
      <Group justify="space-between" wrap="nowrap" style={{ minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon variant="light" size="md" radius="xl" style={{ flexShrink: 0 }}>
            <IconMessageChatbot size={16} />
          </ThemeIcon>
          <Text fw={600} truncate>
            Assistant
          </Text>
        </Group>
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          {messages.length > 0 && (
            <Tooltip label="Clear conversation">
              <ActionIcon variant="subtle" color="gray" onClick={reset} aria-label="Clear conversation">
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          {onToggleExpand && (
            <Tooltip label={expanded ? 'Collapse panel' : 'Expand to full screen'}>
              <ActionIcon
                variant={expanded ? 'filled' : 'subtle'}
                color="indigo"
                onClick={onToggleExpand}
                aria-label={expanded ? 'Collapse panel' : 'Expand to full screen'}
              >
                {expanded ? (
                  <IconLayoutSidebarRightCollapse size={18} />
                ) : (
                  <IconLayoutSidebarLeftCollapse size={18} />
                )}
              </ActionIcon>
            </Tooltip>
          )}
          {onClose && (
            <Tooltip label="Hide assistant">
              <ActionIcon variant="subtle" color="gray" onClick={onClose} aria-label="Hide assistant">
                <IconX size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
      <Divider />

      <ScrollArea
        flex={1}
        viewportRef={viewportRef}
        type="auto"
        offsetScrollbars
        style={{ minWidth: 0 }}
      >
        {messages.length === 0 ? (
          // Vertically center the welcome when it fits; when the panel is too
          // short the `margin:auto` collapses, so it sits at the top and scrolls
          // instead of clipping the hero icon.
          <Box style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* marginBlock:auto centers it; a slightly heavier top margin nudges
                it just below the optical center so it doesn't sit high. */}
            <Box style={{ marginTop: 'auto', marginBottom: 'auto', paddingTop: 24, width: '100%' }}>
              <AssistantWelcome onPick={(p) => void send(p)} />
            </Box>
          </Box>
        ) : (
          // Center the conversation and cap its line length on very wide panels
          // so full-screen mode reads well instead of sprawling edge to edge.
          <Box mx="auto" maw={expanded ? 900 : '100%'} style={{ minWidth: 0 }}>
            <Stack gap="md" p={4} style={{ minWidth: 0 }}>
              {messages.map((m) => (
                // data-msg-id lets the scroll effect find a bubble's top so an
                // arriving reply scrolls to its start, not the conversation end.
                <Box key={m.id} data-msg-id={m.id} style={{ minWidth: 0 }}>
                  <MessageBubble
                    message={m}
                    onConfirm={confirmAction}
                    onPick={(p) => void send(p)}
                    wide={expanded}
                  />
                </Box>
              ))}
            </Stack>
          </Box>
        )}
      </ScrollArea>

      <Box mx="auto" w="100%" maw={expanded ? 900 : '100%'}>
        <Group gap="xs" align="flex-end" wrap="nowrap" style={{ minWidth: 0 }}>
          <Textarea
            flex={1}
            placeholder="Ask the assistant…"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            autosize
            minRows={1}
            maxRows={4}
            disabled={isPending}
            radius="md"
            style={{ minWidth: 0 }}
          />
          {isPending ? (
            // While a reply is generating, the send button becomes a force-stop.
            <Tooltip label="Stop generating">
              <ActionIcon
                size="lg"
                radius="md"
                variant="filled"
                color="red"
                onClick={stop}
                aria-label="Stop generating"
                style={{ flexShrink: 0 }}
              >
                <IconPlayerStopFilled size={18} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <ActionIcon
              size="lg"
              radius="md"
              variant="gradient"
              gradient={{ from: 'indigo', to: 'cyan' }}
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="Send message"
              style={{ flexShrink: 0 }}
            >
              <IconSend size={18} />
            </ActionIcon>
          )}
        </Group>
      </Box>
    </Stack>
  );
}
