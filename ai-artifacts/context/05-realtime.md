# Real-time Status Updates — WebSocket Gateway

## Goal & Decision

The invoice list must reflect lifecycle transitions (`uploaded → processing → completed / failed`) **with zero manual refresh**. We push state changes from the backend to the browser over a single Socket.IO connection. The frontend loads initial state via REST on mount, then applies live deltas from the socket.

**Decision: WebSocket (Socket.IO), not SSE.** Justification at the bottom — but the short version is that Socket.IO gives us auto-reconnect, room semantics, and a clean path to client→server messages (e.g. "subscribe to invoice X") that we will not need today but get for free, plus a Redis adapter that solves the multi-process problem cleanly.

---

## Architecture at a Glance

```
            ┌─────────────┐   BullMQ job    ┌──────────────────┐
 POST /api  │  API process │ ─────────────▶ │  Worker process  │
 upload  ──▶│  (Nest http) │                 │  (OCR + Claude)  │
            └──────┬──────┘                 └────────┬─────────┘
                   │                                  │
                   │ status: uploaded                 │ status: processing/completed/failed
                   │                                  │
                   ▼                                  ▼
            ┌──────────────────────────────────────────────┐
            │   Socket.IO server  +  Redis Adapter (pub/sub) │
            └───────────────────────┬──────────────────────┘
                                    │ invoice.created / invoice.updated
                                    ▼
                            ┌───────────────┐
                            │  React client │  useInvoiceSocket()
                            └───────────────┘
```

**The critical gotcha:** the BullMQ worker may run as a **separate OS process** from the HTTP/Socket.IO server. A `server.emit()` called inside the worker process only reaches sockets connected to *that* process — and the worker has no connected sockets. The fix is the **Socket.IO Redis adapter**: every `emit` is published to Redis, and every process subscribed to the adapter re-emits to its local sockets. This is non-negotiable for a separate worker. If you run API + worker in one process (single Nest app, BullMQ `Worker` instantiated in-process), you can skip the adapter — but install it anyway so scaling out doesn't silently break real-time.

---

## Packages

```bash
# backend
npm i @nestjs/websockets @nestjs/platform-socket.io socket.io
npm i @socket.io/redis-adapter ioredis

# frontend
npm i socket.io-client
```

Exact versions that match the fixed stack (Nest 10):

- `@nestjs/websockets@^10`
- `@nestjs/platform-socket.io@^10`
- `socket.io@^4.7`
- `@socket.io/redis-adapter@^8`
- `ioredis@^5`
- `socket.io-client@^4.7` (must be major-version-compatible with `socket.io@4`)

---

## Event Contract

One namespace, two server→client events. Keep payloads small and self-describing.

```ts
// shared/invoice-events.ts  (copy into both backend and frontend, or publish as a tiny shared package)

export type InvoiceStatus = 'uploaded' | 'processing' | 'completed' | 'failed';

export interface InvoiceEventPayload {
  id: string;
  status: InvoiceStatus;
  fileName: string;
  vendor?: string | null;
  total?: number | null;
  currency?: string | null;
  error?: string | null;     // populated on 'failed'
  updatedAt: string;          // ISO 8601
}

export const INVOICE_EVENTS = {
  CREATED: 'invoice.created',
  UPDATED: 'invoice.updated',
} as const;
```

- `invoice.created` — fired once at upload time (`status: 'uploaded'`). Lets the list prepend the new row immediately without a refetch.
- `invoice.updated` — fired on every subsequent transition (`processing`, `completed`, `failed`, and after a retry). The frontend reducer is **idempotent**: it upserts by `id`, so a late/duplicate `created` followed by `updated` still converges to the correct state.

We deliberately do **not** send a separate `invoice.completed` / `invoice.failed` event. One `updated` event keyed on `status` keeps the client reducer trivial and the contract closed.

---

## Rooms vs Broadcast

This assignment is **single-user** (one assignee, no auth tenancy). **Broadcast to all connected sockets is correct and simplest** — every connected tab is the same user and should see every invoice.

We still structure the gateway so per-invoice rooms are a one-line change later:

- **Broadcast (what we ship):** `server.emit(event, payload)` → all clients.
- **Per-invoice room (future, e.g. an invoice detail page that only wants its own updates):** client emits `subscribe:invoice` with an id, server does `socket.join(\`invoice:${id}\`)`, worker emits with `server.to(\`invoice:${id}\`).emit(...)`.

Shipping broadcast now, with the room plumbing present but unused, is the right altitude. Don't build multi-tenant room routing for a single-user app.

---

## Backend: The Gateway

```ts
// src/realtime/invoice.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { INVOICE_EVENTS, InvoiceEventPayload } from '../shared/invoice-events';

@WebSocketGateway({
  // dedicated namespace keeps invoice traffic isolated from any future sockets
  namespace: '/invoices',
  cors: {
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  },
})
export class InvoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InvoiceGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`client disconnected: ${client.id}`);
  }

  /** Broadcast helpers — the only public surface other modules call. */
  emitCreated(payload: InvoiceEventPayload) {
    this.server.emit(INVOICE_EVENTS.CREATED, payload);
  }

  emitUpdated(payload: InvoiceEventPayload) {
    this.server.emit(INVOICE_EVENTS.UPDATED, payload);
  }

  /** Optional future hook: per-invoice room subscription. Unused by current UI. */
  @SubscribeMessage('subscribe:invoice')
  onSubscribeInvoice(
    @MessageBody() id: string,
    @ConnectedSocket() client: Socket,
  ) {
    client.join(`invoice:${id}`);
  }
}
```

```ts
// src/realtime/realtime.module.ts
import { Module } from '@nestjs/common';
import { InvoiceGateway } from './invoice.gateway';

@Module({
  providers: [InvoiceGateway],
  exports: [InvoiceGateway],
})
export class RealtimeModule {}
```

The gateway exposes exactly two emit methods. Nothing outside this module knows about Socket.IO. Note `client.id` is the Socket.IO connection id (renamed to avoid colliding with invoice ids in logs).

---

## Wiring the Redis Adapter (multi-process correctness)

Without this, a separately-running worker's emits go nowhere. Configure a custom adapter so every Nest process (API and worker, if the worker also hosts a gateway — or just the API if only the API holds sockets and the worker emits *through* Redis) participates.

```ts
// src/realtime/redis-io.adapter.ts
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis'; // or ioredis equivalent
import { INestApplicationContext } from '@nestjs/common';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(url: string): Promise<void> {
    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
```

```ts
// src/main.ts (excerpt)
const app = await NestFactory.create(AppModule);
const redisAdapter = new RedisIoAdapter(app);
await redisAdapter.connectToRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
app.useWebSocketAdapter(redisAdapter);
await app.listen(3000);
```

**How the worker reaches sockets:** the worker process imports `RealtimeModule` and calls `gateway.emitUpdated(...)`. Because the Socket.IO server in the worker shares the same Redis adapter, the emit is published to Redis and the **API process re-emits it to its connected browser sockets**. The worker need not have a single browser socket of its own. This is the entire reason the adapter exists.

> If you choose the simpler **single-process** deployment (BullMQ `Worker` instantiated inside the same Nest app as the HTTP server), the adapter is unnecessary — the gateway and worker share one `Server` instance. Install it regardless; flipping to a separate worker later then "just works."

---

## Emitting from the Pipeline

The upload controller emits `created`; the BullMQ processor emits `updated` at each transition. Both go through the gateway service — no direct Socket.IO usage leaks out.

```ts
// src/invoices/invoices.service.ts (excerpt)
async createFromUpload(file: UploadedFile): Promise<Invoice> {
  const invoice = await this.repo.save(
    this.repo.create({ status: 'uploaded', fileName: file.originalname }),
  );
  this.gateway.emitCreated(this.toPayload(invoice));
  await this.queue.add('extract', { invoiceId: invoice.id });
  return invoice;
}

private toPayload(i: Invoice): InvoiceEventPayload {
  return {
    id: i.id,
    status: i.status,
    fileName: i.fileName,
    vendor: i.vendor ?? null,
    total: i.total ?? null,
    currency: i.currency ?? null,
    error: i.error ?? null,
    updatedAt: i.updatedAt.toISOString(),
  };
}
```

```ts
// src/invoices/extraction.processor.ts (BullMQ)
@Processor('invoices')
export class ExtractionProcessor extends WorkerHost {
  constructor(
    private readonly repo: InvoiceRepository,
    private readonly gateway: InvoiceGateway,
  ) { super(); }

  async process(job: Job<{ invoiceId: string }>) {
    const id = job.data.invoiceId;

    await this.transition(id, 'processing');
    try {
      const data = await this.extract(id);              // OCR -> Claude structuring
      await this.transition(id, 'completed', { ...data });
    } catch (err) {
      await this.transition(id, 'failed', { error: String(err?.message ?? err) });
      throw err; // let BullMQ record the failure for retry bookkeeping
    }
  }

  private async transition(id: string, status: InvoiceStatus, patch: Partial<Invoice> = {}) {
    await this.repo.update(id, { status, ...patch });
    const fresh = await this.repo.findOneByOrFail({ id });
    this.gateway.emitUpdated(this.gateway.toPayload(fresh)); // single source of truth
  }
}
```

**Persist before emit, always.** The DB is the source of truth; the socket is a notification. A client that missed an event recovers by refetching the REST list — which reads the same persisted state. Never emit a status the DB doesn't already hold.

**Retry:** the retry endpoint (`POST /invoices/:id/retry`) flips status back, emits `updated` with `status: 'processing'`, and re-enqueues the job. The same `updated` path carries it through to `completed`/`failed`. No special retry event.

---

## Frontend: `useInvoiceSocket` Hook

Strategy: **REST on mount for initial state, live socket deltas thereafter.** The reducer upserts by `id`, so order/duplicates/reconnect gaps are self-healing. On reconnect we **refetch the list** to close any gap during the disconnect window.

```ts
// src/hooks/useInvoiceSocket.ts
import { useEffect, useReducer, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { INVOICE_EVENTS, InvoiceEventPayload } from '../shared/invoice-events';

type State = { byId: Record<string, InvoiceEventPayload>; order: string[]; connected: boolean };
type Action =
  | { type: 'load'; rows: InvoiceEventPayload[] }
  | { type: 'upsert'; row: InvoiceEventPayload }
  | { type: 'connection'; connected: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load': {
      const byId: State['byId'] = {};
      for (const r of action.rows) byId[r.id] = r;
      return { ...state, byId, order: action.rows.map((r) => r.id) };
    }
    case 'upsert': {
      const exists = state.byId[action.row.id] != null;
      return {
        ...state,
        byId: { ...state.byId, [action.row.id]: action.row },
        order: exists ? state.order : [action.row.id, ...state.order], // new -> top
      };
    }
    case 'connection':
      return { ...state, connected: action.connected };
  }
}

const SOCKET_URL = `${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/invoices`;

export function useInvoiceSocket() {
  const [state, dispatch] = useReducer(reducer, { byId: {}, order: [], connected: false });
  const socketRef = useRef<Socket | null>(null);

  // initial REST load + refetch-on-reconnect helper
  async function loadList() {
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/invoices`);
    dispatch({ type: 'load', rows: await res.json() });
  }

  useEffect(() => {
    loadList();

    const socket = io(SOCKET_URL, {
      transports: ['websocket'],   // skip long-poll upgrade; we control both ends
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => dispatch({ type: 'connection', connected: true }));
    socket.on('disconnect', () => dispatch({ type: 'connection', connected: false }));

    // close the gap that opened while disconnected
    socket.io.on('reconnect', () => { loadList(); });

    const onCreated = (row: InvoiceEventPayload) => dispatch({ type: 'upsert', row });
    const onUpdated = (row: InvoiceEventPayload) => dispatch({ type: 'upsert', row });
    socket.on(INVOICE_EVENTS.CREATED, onCreated);
    socket.on(INVOICE_EVENTS.UPDATED, onUpdated);

    return () => {
      socket.off(INVOICE_EVENTS.CREATED, onCreated);
      socket.off(INVOICE_EVENTS.UPDATED, onUpdated);
      socket.disconnect();
    };
  }, []);

  const invoices = state.order.map((id) => state.byId[id]);
  return { invoices, connected: state.connected };
}
```

Consumed in the list component:

```tsx
function InvoiceList() {
  const { invoices, connected } = useInvoiceSocket();
  return (
    <>
      <ConnectionBadge online={connected} />
      <table>{invoices.map((inv) => <InvoiceRow key={inv.id} invoice={inv} />)}</table>
    </>
  );
}
```

Three correctness properties this gives us:

1. **No manual refresh** — every transition arrives as an `updated` event and re-renders the row.
2. **Reconnect-safe** — `socket.io.on('reconnect')` refetches the full list, so any events missed during a drop are recovered. Idempotent upsert means the refetch and any in-flight events converge.
3. **Cold-start correct** — REST load on mount means an already-`completed` invoice (uploaded before this tab opened) shows up immediately, not just ones that change while watching.

---

## WebSocket vs SSE — Why WebSocket

| Concern | SSE (`EventSource`) | WebSocket (Socket.IO) — **chosen** |
|---|---|---|
| Direction | Server→client only | Bidirectional — future `subscribe:invoice`, "user is typing" for the AI assistant, etc. |
| Reconnect | Built-in, but you implement `Last-Event-ID` gap recovery yourself | Built-in reconnect + we add a simple refetch-on-reconnect |
| Multi-process fan-out | Roll your own Redis pub/sub bridge | `@socket.io/redis-adapter` drops in — directly solves the separate-worker emit problem |
| Rooms / targeting | Manual | Native `join` / `to(room)` for the per-invoice future |
| Nest integration | No first-class module; hand-rolled controller streaming | First-class `@nestjs/websockets` gateway with DI |
| Browser connection limit | 6 per host over HTTP/1.1 (real pain with multiple tabs) | One multiplexed connection |

SSE would technically satisfy "push status with no refresh." We pick WebSocket because (a) the **same app already needs a real-time channel for the AI assistant**, and a single Socket.IO connection serves both; (b) the **Redis adapter is the cleanest answer to the multi-process worker emit problem**, which we have to solve anyway; and (c) Nest's gateway gives us DI-clean, typed plumbing with reconnect handled. The bidirectional capability is a bonus we don't pay for. For this stack, WebSocket is the lower-total-cost choice, not the heavier one.

---

## Fact-check & corrections to apply

> _Generated artifact — produced by a multi-agent Claude workflow during design.
> Kept as-is per the assignment deliverables. The “Fact-check & corrections to apply”
> section at the end is the output of an adversarial review agent that audited this draft._

## Review: Real-time status updates via WebSocket gateway

The doc's own opening claim is correct and worth affirming: this area decides no model ids, pricing, or SDK calls, so the Claude-specific surface (model strings, tool_use/tool_result blocks, Anthropic message roles) is genuinely out of scope here and contains nothing to correct. The errors below are all in the NestJS / Socket.IO / BullMQ / TypeORM plumbing.

- [SEVERITY high] The Redis adapter wiring is internally inconsistent: `RedisIoAdapter` imports and uses `createClient` from `redis` (node-redis), but the Packages section installs and pins `ioredis` (`npm i @socket.io/redis-adapter ioredis`, `ioredis@^5`) and never installs `redis`. -> Pick one client. Either install `redis` (node-redis v4+, which is what `createClient({url}).connect()` / `.duplicate()` matches) or rewrite the adapter for `ioredis` (`new Redis(url)` and `pubClient.duplicate()`, no `.connect()` call since ioredis connects eagerly). As written the code will fail at `import { createClient } from 'redis'` with a missing module.

- [SEVERITY high] `this.gateway.toPayload(fresh)` is called in the processor, but `toPayload` is defined as a `private` method on the service (`InvoicesService`), not on `InvoiceGateway`. The gateway exposes only `emitCreated` / `emitUpdated`. -> Either move `toPayload` onto the gateway (and make it public), or have the processor build the payload via the service. As written this is a compile error (property `toPayload` does not exist on `InvoiceGateway`) and contradicts the doc's own stated design that the gateway exposes "exactly two emit methods."

- [SEVERITY med] The BullMQ processor uses `@Processor('invoices')` and the service enqueues with `this.queue.add('extract', …)`, but the queue the service injects is never shown being registered to the name `'invoices'`. The decorator string is the queue name and must match the `BullModule.registerQueue({ name: 'invoices' })` / `@InjectQueue('invoices')` used by the service. -> This is only a latent wiring gap, not wrong API, but the doc should state the queue name binding so `@Processor('invoices')` and the injected `Queue` refer to the same queue; otherwise jobs are added to one queue and the worker listens on another.

- [SEVERITY med] `@Processor`/`WorkerHost` from `@nestjs/bullmq`: the class extends `WorkerHost` and implements `process(job)`, which is correct, but for the gateway emit to work from inside the worker the doc claims the worker "imports `RealtimeModule` and calls `gateway.emitUpdated(...)`" and that the emit is "published to Redis ... and the API process re-emits." That requires the worker process to also instantiate a Socket.IO `Server` bound to the same Redis adapter. A `@WebSocketGateway` only creates a `Server` when the Nest app actually initializes the WS adapter (i.e., a full Nest application with `useWebSocketAdapter` + a listening server), not in a bare worker context. -> The doc should make explicit that the worker process must boot a Nest app that installs `RedisIoAdapter` (the publish side of `@socket.io/redis-adapter` needs a `Server` with the adapter attached); otherwise `this.server` in the worker's gateway is `undefined` and `server.emit` throws. The "worker need not have a single browser socket" claim is true, but it does need an adapter-attached `Server` instance, which the current wiring section only sets up in `main.ts` for the API.

- [SEVERITY low] `transition()` does `await this.repo.update(id, {status, ...patch})` then `findOneByOrFail({ id })`. `repo.update` with a partial that includes `error` (string) and spreads arbitrary `data` from extraction is fine for TypeORM, but the payload typing `patch: Partial<Invoice>` combined with `{ ...data }` (the structured extraction result) can include keys that aren't columns. -> Minor: constrain the patch to known columns, or the `update` call silently ignores/errors on unknown keys depending on TypeORM strictness. Not a hard bug, but worth flagging since the extraction `data` shape is unvalidated.

- [SEVERITY low] `findOneByOrFail({ id })` requires `id` typed as the entity's PK type. If the `Invoice.id` column is a uuid (implied by `id: string` in the payload and `invoiceId` flowing through the queue), the entity must declare `@PrimaryGeneratedColumn('uuid')` for `id: string` to be correct. -> Not shown in this doc (the entity lives elsewhere), so only a cross-cutting note: ensure the entity PK is `uuid`, not the default `increment` (which yields `number`), or the `id: string` contract here is wrong.

- [SEVERITY low] Frontend: `socket.io.on('reconnect', …)` is correct for the Manager (`socket.io` is the `Manager`), and `socket.on('connect'|'disconnect')` is correct for the `Socket` — these are right and a common place to get wrong, so noting it as solid. Also correct: client `transports: ['websocket']` plus a server on a namespace works, and the namespace URL form `${API}/invoices` matches the gateway's `namespace: '/invoices'`.

Solid sections: the event contract (two server→client events, idempotent upsert reducer), the broadcast-vs-rooms altitude call, the `@WebSocketGateway`/`@WebSocketServer`/`@SubscribeMessage`/`@MessageBody`/`@ConnectedSocket` decorator usage, the `OnGatewayConnection`/`OnGatewayDisconnect` lifecycle, the persist-before-emit ordering, and the WebSocket-vs-SSE comparison are all technically accurate. The two high-severity items (Redis client mismatch, `toPayload` on the wrong class) are the only outright code-breaking errors; the rest are wiring gaps the doc should close.
