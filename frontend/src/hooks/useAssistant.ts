import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, apiErrorMessage } from '../lib/api';
import { newId } from '../lib/id';
import type { AssistantStep, ChatMessage, ChatTurn } from '../types/assistant';
import { invoiceKeys } from './useInvoices';

/**
 * Chat is request/response with an ephemeral local log. The backend is
 * stateless — we send the prior turns as `history` each time. After any
 * response where the assistant acted, the invoice list is invalidated so the
 * UI reflects those actions without a manual refresh. Destructive actions come
 * back as `pendingConfirmation`; the user confirms via a button which re-sends
 * with the signed token.
 */
export function useAssistant() {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Lets the user force-stop an in-flight request. Aborting the fetch/axios call
  // unwinds `run` via the catch below, where we settle the pending bubble.
  const abortRef = useRef<AbortController | null>(null);

  const isPending = messages.at(-1)?.pending === true;

  /** Derive Gemini-format history from the local message log. */
  const toHistory = useCallback(
    (msgs: ChatMessage[]): ChatTurn[] =>
      msgs
        .filter((m) => !m.pending && m.content)
        .map((m) => ({
          role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
          content: m.content,
        })),
    [],
  );

  const run = useCallback(
    async (text: string, confirm?: { token: string }) => {
      const history = toHistory(messages);
      const pendingId = newId();
      setMessages((m) => [
        ...m,
        // Show the user's message unless this is a pure confirmation click.
        ...(text ? [{ id: newId(), role: 'user' as const, content: text }] : []),
        { id: pendingId, role: 'assistant' as const, content: '', pending: true, steps: [] },
      ]);

      // Append a live progress step to the pending bubble as it streams in.
      const onStep = (step: AssistantStep) =>
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pendingId
              ? { ...msg, steps: [...(msg.steps ?? []), step] }
              : msg,
          ),
        );

      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      try {
        // Stream live steps; fall back to the plain request if streaming fails
        // (older proxy, transport error) so the chat still works.
        let res;
        try {
          res = await api.askStream(text, history, confirm, onStep, signal);
        } catch (streamErr) {
          // Don't fall back after a user abort — a stop should stop, not re-fire
          // the request on the non-streaming endpoint.
          if (signal.aborted) throw streamErr;
          res = await api.ask(text, history, confirm, signal);
        }
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pendingId
              ? {
                  id: pendingId,
                  role: 'assistant',
                  content: res.content || (res.pendingConfirmation?.prompt ?? ''),
                  actions: res.actions ?? [],
                  confirm: res.pendingConfirmation,
                }
              : msg,
          ),
        );
        if (res.actions?.length) {
          qc.invalidateQueries({ queryKey: invoiceKeys.all });
          qc.invalidateQueries({ queryKey: ['stats'] });
        }
      } catch (error) {
        // A user-triggered stop settles the bubble with a neutral note instead
        // of an error — the request was cancelled on purpose.
        const stopped = signal.aborted;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pendingId
              ? {
                  id: pendingId,
                  role: 'assistant',
                  content: stopped
                    ? '_Stopped._'
                    : `Sorry, something went wrong: ${apiErrorMessage(error)}`,
                }
              : msg,
          ),
        );
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [messages, qc, toHistory],
  );

  const send = useCallback((text: string) => run(text), [run]);

  /** Force-stop the in-flight request, if any. */
  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Confirm or decline a pending destructive action. */
  const confirmAction = useCallback(
    (token: string, approved: boolean) => {
      // Clear the confirm prompt from the bubble that raised it.
      setMessages((m) => m.map((msg) => (msg.confirm?.token === token ? { ...msg, confirm: undefined } : msg)));
      if (approved) {
        void run('', { token });
      } else {
        setMessages((m) => [
          ...m,
          { id: newId(), role: 'assistant', content: 'Okay, cancelled — nothing was deleted.' },
        ]);
      }
    },
    [run],
  );

  const reset = useCallback(() => setMessages([]), []);

  return { messages, send, confirmAction, reset, isPending, stop };
}
