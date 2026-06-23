# Frontend Architecture — Vite + React

## 1. Scope & decisions up front

This frontend does five things: upload an invoice, show a live list of invoices with status, show extracted data when a row completes, retry failed rows, and chat with an AI assistant that can both answer and act. Everything is real-time over Socket.IO, so the central architectural concern is **keeping one server-owned cache of invoices in sync across REST mutations and socket pushes**.

Decisions (non-negotiable for this build):

- **Add `@tanstack/react-query` + `axios`.** Do not hand-roll fetch hooks. The list is server state with three independent mutation paths (REST upload, REST retry, socket push). React Query gives you one cache keyed by `['invoices']`, dedup, and `queryClient.setQueryData` to merge socket events without a refetch. Hand-rolling this means reimplementing cache invalidation, in-flight dedup, and stale handling — that is the bug surface, not the assignment.
- **Assistant chat is request/response, not token streaming.** The assistant returns an answer plus a structured list of tool actions it took. Streaming the text adds SSE/socket plumbing and partial-render state for marginal UX on short invoice answers. Render the final message and an explicit "Actions taken" block. (If you want streaming later, it's an additive SSE endpoint — do not block on it.)
- **React 18**, per fixed stack. Pin `react@^18` / `react-dom@^18` and use `createRoot`.
- **Socket.IO is read-only for invoices.** All writes go through REST (`POST /invoices`, `POST /invoices/:id/retry`). The socket only delivers `invoice.updated` events. This keeps mutations idempotent and auditable; the socket is a notification channel, not a command channel.

## 2. npm dependencies to add

Current baseline: `react`, `react-dom` only. Add exactly:

```bash
npm i react@^18 react-dom@^18 \
  @tanstack/react-query@^5 \
  axios@^1 \
  socket.io-client@^4 \
  clsx@^2

npm i -D vite@^5 @vitejs/plugin-react@^4 typescript@~5.5 \
  @types/react@^18 @types/react-dom@^18 \
  @tanstack/react-query-devtools@^5
```

Deliberately **not** added: a form library (the only form is a file input), a component kit (status badges are 30 lines of CSS), a markdown renderer (assistant returns plain text + structured actions; add `react-markdown` only if the backend starts returning markdown). `clsx` is the one utility worth its weight for conditional badge classes.

## 3. Folder structure under `frontend/src`

```
frontend/src/
  main.tsx                 # createRoot, QueryClientProvider, SocketProvider
  App.tsx                  # layout: <InvoicePanel/> | <AssistantChat/>
  index.css

  lib/
    api.ts                 # axios instance (baseURL from env), typed endpoint fns
    socket.ts              # singleton socket.io-client instance + SocketProvider
    queryClient.ts         # configured QueryClient

  types/
    invoice.ts             # Invoice, InvoiceStatus, ExtractedData
    assistant.ts           # ChatMessage, ToolAction

  hooks/
    useInvoices.ts         # useQuery(['invoices'])
    useUploadInvoice.ts    # useMutation, optimistic insert
    useRetryInvoice.ts     # useMutation, optimistic status flip
    useInvoiceSocket.ts    # subscribes, merges events into cache
    useAssistant.ts        # chat send mutation + local message log

  components/
    invoices/
      InvoicePanel.tsx     # composes list + detail, owns selectedId
      UploadDropzone.tsx
      InvoiceList.tsx
      InvoiceRow.tsx
      StatusBadge.tsx
      InvoiceDetail.tsx
      ExtractedDataView.tsx
    assistant/
      AssistantChat.tsx
      MessageBubble.tsx
      ToolActionList.tsx
    ui/
      Spinner.tsx
```

## 4. Types (the contract)

```ts
// types/invoice.ts
export type InvoiceStatus = 'uploaded' | 'processing' | 'completed' | 'failed';

export interface ExtractedLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface ExtractedData {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;   // ISO
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: ExtractedLineItem[];
}

export interface Invoice {
  id: string;
  fileName: string;
  status: InvoiceStatus;
  createdAt: string;            // ISO
  updatedAt: string;
  errorMessage: string | null;  // set when status === 'failed'
  extracted: ExtractedData | null; // non-null only when 'completed'
}
```

```ts
// types/assistant.ts
export interface ToolAction {
  tool: string;                       // e.g. 'retry_invoice', 'list_invoices'
  input: Record<string, unknown>;
  result: 'ok' | 'error';
  summary: string;                    // human-readable, server-generated
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: ToolAction[];             // present on assistant messages that acted
  pending?: boolean;                  // assistant bubble while awaiting response
}
```

## 5. Data layer

### axios instance + endpoints

```ts
// lib/api.ts
import axios from 'axios';
import type { Invoice } from '../types/invoice';
import type { ChatMessage, ToolAction } from '../types/assistant';

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
});

export const api = {
  listInvoices: () => http.get<Invoice[]>('/invoices').then(r => r.data),

  uploadInvoice: (file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    return http.post<Invoice>('/invoices', form, {
      onUploadProgress: e =>
        onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
    }).then(r => r.data);
  },

  retryInvoice: (id: string) =>
    http.post<Invoice>(`/invoices/${id}/retry`).then(r => r.data),

  ask: (message: string) =>
    http.post<{ content: string; actions: ToolAction[] }>(
      '/assistant/messages', { message },
    ).then(r => r.data),
};
```

### Query client

```ts
// lib/queryClient.ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,        // socket is the freshness source, not polling
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
```

### List hook

```ts
// hooks/useInvoices.ts
export const invoiceKeys = { all: ['invoices'] as const };

export function useInvoices() {
  return useQuery({ queryKey: invoiceKeys.all, queryFn: api.listInvoices });
}
```

## 6. Real-time integration

One socket, one event, one merge function. The hook mounts once near the top of the tree and writes server pushes directly into the React Query cache — **no refetch on every event**.

```ts
// lib/socket.ts
import { io, type Socket } from 'socket.io-client';

export const socket: Socket = io(
  import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
  { transports: ['websocket'], autoConnect: true },
);
```

```ts
// hooks/useInvoiceSocket.ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { socket } from '../lib/socket';
import { invoiceKeys } from './useInvoices';
import type { Invoice } from '../types/invoice';

export function useInvoiceSocket() {
  const qc = useQueryClient();

  useEffect(() => {
    const onUpdated = (incoming: Invoice) => {
      qc.setQueryData<Invoice[]>(invoiceKeys.all, (prev) => {
        if (!prev) return [incoming];
        const idx = prev.findIndex(i => i.id === incoming.id);
        if (idx === -1) return [incoming, ...prev];        // new invoice from another tab
        const next = prev.slice();
        next[idx] = incoming;                               // server is source of truth
        return next;
      });
    };

    socket.on('invoice.updated', onUpdated);
    return () => { socket.off('invoice.updated', onUpdated); };
  }, [qc]);
}
```

Mount it once in `App.tsx`. The backend emits `invoice.updated` on every lifecycle transition (`uploaded→processing→completed/failed`), sending the full `Invoice` object each time. Sending the full object (not a patch) makes the merge a flat replace and avoids partial-state bugs. **Refetch is the fallback only**: on socket `reconnect`, call `qc.invalidateQueries({ queryKey: invoiceKeys.all })` once to recover any events missed while offline.

## 7. Upload UX — optimistic row

Drag-drop + click-to-browse. On drop, immediately insert a temporary row with `status: 'uploaded'` so the user sees feedback before the network round-trip. React Query's mutation `onMutate` does the optimistic insert; the server response reconciles the temp id to the real one; the socket then drives it through `processing → completed/failed`.

```ts
// hooks/useUploadInvoice.ts
export function useUploadInvoice() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState(0);

  const mutation = useMutation({
    mutationFn: (file: File) => api.uploadInvoice(file, setProgress),

    onMutate: async (file) => {
      await qc.cancelQueries({ queryKey: invoiceKeys.all });
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimistic: Invoice = {
        id: tempId, fileName: file.name, status: 'uploaded',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        errorMessage: null, extracted: null,
      };
      qc.setQueryData<Invoice[]>(invoiceKeys.all, p => [optimistic, ...(p ?? [])]);
      return { tempId };
    },

    onSuccess: (real, _file, ctx) => {
      // swap temp row for the server row (real id); socket takes it from here
      qc.setQueryData<Invoice[]>(invoiceKeys.all, p =>
        (p ?? []).map(i => (i.id === ctx?.tempId ? real : i)));
    },

    onError: (_err, _file, ctx) => {
      qc.setQueryData<Invoice[]>(invoiceKeys.all, p =>
        (p ?? []).filter(i => i.id !== ctx?.tempId));
    },

    onSettled: () => setProgress(0),
  });

  return { ...mutation, progress };
}
```

`UploadDropzone.tsx` owns drag state and a hidden `<input type="file" accept="application/pdf,image/*">`. While `mutation.isPending`, render a thin progress bar driven by `progress`. Guard accepted types client-side (`pdf`, `png`, `jpg`) and reject the rest before calling mutate.

## 8. Status visualization

`StatusBadge` is a pure function of status. `processing` shows a spinner; `failed` rows carry a retry button.

```tsx
// components/invoices/StatusBadge.tsx
const MAP: Record<InvoiceStatus, { label: string; cls: string; spin?: boolean }> = {
  uploaded:   { label: 'Uploaded',   cls: 'badge-gray' },
  processing: { label: 'Processing', cls: 'badge-blue', spin: true },
  completed:  { label: 'Completed',  cls: 'badge-green' },
  failed:     { label: 'Failed',     cls: 'badge-red' },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const m = MAP[status];
  return (
    <span className={clsx('badge', m.cls)}>
      {m.spin && <Spinner size={12} />}
      {m.label}
    </span>
  );
}
```

Retry mutation flips the row to `processing` optimistically; the backend re-enqueues the BullMQ job and the socket drives the real outcome:

```ts
// hooks/useRetryInvoice.ts
export function useRetryInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.retryInvoice(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: invoiceKeys.all });
      const prev = qc.getQueryData<Invoice[]>(invoiceKeys.all);
      qc.setQueryData<Invoice[]>(invoiceKeys.all, p =>
        (p ?? []).map(i => i.id === id
          ? { ...i, status: 'processing', errorMessage: null } : i));
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(invoiceKeys.all, ctx.prev);
    },
  });
}
```

`InvoiceRow` renders `fileName`, `<StatusBadge>`, and — only when `status === 'failed'` — a Retry button wired to this mutation plus the `errorMessage` as a tooltip/inline note. Clicking a row sets `selectedId` in `InvoicePanel`.

## 9. InvoiceDetail + extracted data

`InvoiceDetail` reads the selected invoice from the cache (no extra fetch — it's already in `['invoices']`). It renders one of three states by status: a spinner for `uploaded`/`processing`, `ExtractedDataView` for `completed`, or an error panel with the Retry button for `failed`.

`ExtractedDataView` renders the `ExtractedData` as a labeled summary (vendor, invoice number, dates, totals) and `lineItems` as a table. Null fields render as "—" rather than being hidden, so the user can see what the model failed to extract — that visibility is the point of the app.

## 10. Assistant chat UI

Request/response. Local message log in the hook (not server state — the conversation is ephemeral for this assignment). On send: push the user message and a `pending` assistant bubble, await the response, replace the pending bubble with content + actions. Crucially, **invalidate the invoice list after any acting response** so the UI reflects actions the assistant took (e.g. it retried an invoice).

```ts
// hooks/useAssistant.ts
export function useAssistant() {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const send = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text };
    const pendingId = crypto.randomUUID();
    setMessages(m => [...m, userMsg,
      { id: pendingId, role: 'assistant', content: '', pending: true }]);

    try {
      const res = await api.ask(text);
      setMessages(m => m.map(msg => msg.id === pendingId
        ? { id: pendingId, role: 'assistant', content: res.content, actions: res.actions }
        : msg));
      if (res.actions.length) {
        // assistant may have mutated invoices server-side
        qc.invalidateQueries({ queryKey: invoiceKeys.all });
      }
    } catch {
      setMessages(m => m.map(msg => msg.id === pendingId
        ? { id: pendingId, role: 'assistant',
            content: 'Sorry, something went wrong.' } : msg));
    }
  }, [qc]);

  return { messages, send };
}
```

`AssistantChat` renders a scrollable `MessageBubble` list, an input with Enter-to-send, and a disabled state while the last message is `pending`. When an assistant message has `actions`, render `ToolActionList` beneath the text: one line per action showing the tool name, an ok/error indicator, and the server's `summary` (e.g. "Retried invoice #1042 — re-queued for processing"). This makes the "assistant takes actions" requirement visible and auditable rather than a hidden side effect. Because actions invalidate `['invoices']`, the list re-syncs in the same render cycle the user reads the action summary — no manual refresh.

## 11. Wiring (`main.tsx` / `App.tsx`)

```tsx
// main.tsx
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
```

```tsx
// App.tsx
export default function App() {
  useInvoiceSocket();                 // single subscription for the whole app
  return (
    <div className="app">
      <InvoicePanel />
      <AssistantChat />
    </div>
  );
}
```

## 12. Vite + env config

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

`.env` (dev): `VITE_API_URL=http://localhost:3000`. One variable; both `axios` and `socket.io-client` read it. No proxy — CORS is enabled on the NestJS side for `http://localhost:5173`, which keeps the socket origin and the REST origin identical and avoids dev-proxy quirks with WebSocket upgrades.

## 13. What this buys / what to improve

The cache-merge-from-socket pattern means status transitions, upload, retry, and assistant actions all converge on one source of truth with zero polling and no manual refresh anywhere. Improvements worth flagging in the README, deferred deliberately: SSE token streaming for the assistant, pagination/virtualization on the invoice list (fine to skip under ~a few hundred rows), persisting the chat thread server-side, and a PDF/image preview pane in `InvoiceDetail` (you already have `react-pdf` available in the repo if you want it).

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

## Frontend Architecture (Vite + React) — Review

Overall this is a solid, internally-consistent frontend spec. The React Query cache-as-single-source pattern, the optimistic upload/retry mutations, the socket-merge-without-refetch design, and the dependency choices are all correct and idiomatic for the stack. The errors below are minor; none are architecture-breaking.

- [SEVERITY low] The preamble says the existing `frontend/package.json` is "React 19, Stripe, Tailwind" from `kosher-dubai`, then says it will treat the "current minimal package.json (react, react-dom only)" as authoritative. These two statements describe different files and the doc never resolves which is actually on disk -> internally inconsistent framing; the reviewer cannot tell whether `react@19` must be downgraded (a real, breaking step the spec glosses over) or whether the baseline truly is bare `react`/`react-dom`. State which file is actually present and, if it's the React 19 one, call out the downgrade as an explicit task.

- [SEVERITY med] The `ToolAction` contract (`{ tool, input, result: 'ok' | 'error', summary }`) does not match the Anthropic tool-use wire shape, and the doc presents it as "the contract." Anthropic's actual structure is a `tool_use` content block on the assistant turn `{ type: "tool_use", id, name, input }` paired with a `tool_result` block on the following user turn `{ type: "tool_result", tool_use_id, content, is_error? }` -> this is fine *as a backend-flattened DTO* (the server runs the agentic loop and projects each tool_use/tool_result pair into one `ToolAction`), but the doc never says that. As written, a reader could mistake `ToolAction` for the SDK shape. Add one line noting this is a server-side projection of the `tool_use`/`tool_result` block pair (`tool`←`name`, `input`←`input`, `result`←`is_error`, `summary`←server-rendered from `tool_result.content`), or the "contract" claim is misleading.

- [SEVERITY low] `axios` `onUploadProgress` is typed as `(e: AxiosProgressEvent)` and `e.total` is `number | undefined`; the guard `e.total ? ... : 0` is correct, but note that on cross-origin requests without a `Content-Length`-friendly setup, `e.total` is frequently `undefined`, so the progress bar will sit at 0% until completion. Not wrong, but the "thin progress bar driven by `progress`" UX claim is overstated for the common case -> acknowledge progress may be unavailable and fall back to an indeterminate bar.

- [SEVERITY low] `crypto.randomUUID()` is used in `onMutate` (`temp-${crypto.randomUUID()}`) and in `useAssistant`. `crypto.randomUUID()` is only available in **secure contexts** (HTTPS or `localhost`). Dev on `http://localhost:5173` is fine, but any non-localhost HTTP origin (e.g. testing from a LAN IP, which the upload UX section implicitly invites) will throw `TypeError: crypto.randomUUID is not a function` -> note the secure-context requirement, or use a tiny fallback.

- [SEVERITY low] Socket client is created with `{ transports: ['websocket'] }` only. Forcing websocket-only disables Socket.IO's HTTP long-polling upgrade fallback; if the dev/proxy path can't establish a raw WS upgrade the client will fail to connect rather than degrade -> the doc elsewhere claims same-origin CORS "avoids dev-proxy quirks with WebSocket upgrades," but pinning `transports: ['websocket']` reintroduces exactly that fragility. Either drop the transports pin (let it negotiate) or acknowledge the tradeoff.

- [SEVERITY low] Section 6 says on socket `reconnect` call `invalidateQueries` once, but `useInvoiceSocket` only registers `invoice.updated` — it never subscribes to the `reconnect` event. The recovery mechanism described in prose is not present in the code sample -> add `socket.io`'s `socket.on('connect', ...)` (or `socket.io.on('reconnect', ...)`) handler, otherwise missed-while-offline events are silently lost despite the doc claiming they're recovered.

- [SEVERITY low] `staleTime: 30_000` with `refetchOnWindowFocus: false` and no `refetchInterval` means the *only* freshness source is the socket. That's the stated intent, but if the socket silently drops (and the reconnect-invalidate hook above is missing), the list can go stale indefinitely with no fallback poll -> the design is sound only once the reconnect handler actually exists; flag the coupling.

- [SEVERITY low] Section 13 claims `react-pdf` is "available in the repo," but the dependency list in Section 2 (and the stated minimal baseline) doesn't include it, and the preamble's description of the existing package.json doesn't mention it either -> unverifiable/inconsistent claim; drop it or confirm it's actually a dependency.

No issues found with: the React Query keys/mutation lifecycle (`onMutate`/`onSuccess`/`onError`/`onSettled` with rollback context), `createRoot` + `QueryClientProvider` wiring, the `StatusBadge` record map, the optimistic retry status-flip, the `accept="application/pdf,image/*"` input, or the model ids referenced by the stack. Those are all correct.
