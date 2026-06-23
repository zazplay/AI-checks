# AI Roadmap — Gemini-powered chat, stats, analyzer & upload helper

> **Supersedes [07-ai-assistant.md](07-ai-assistant.md).** That doc specified the assistant on
> Claude (`@anthropic-ai/sdk`). This build runs **all** AI on **Google Gemini** (`@google/genai`,
> default `gemini-2.5-flash`) so a single free key powers both extraction and the assistant. The
> tool surface and the stateless-history decision carry over verbatim; only the SDK and message
> format change — Gemini `functionDeclarations` / `functionCall` / `functionResponse` instead of
> Anthropic `tool_use` / `tool_result`.

## Decisions up front

- **One Gemini client, one selectable model.** `GeminiService` (`src/ai/gemini.service.ts`, in a
  `@Global() AiModule`) holds a *mutable* current model (default from `GEMINI_MODEL`). Both
  `ExtractionService` and `AssistantService` read it, so the in-app **model switcher** affects
  everything. Endpoints: `GET /ai/models`, `PUT /ai/model`.
- **Stateless backend; the client passes history.** No session store — the frontend already keeps
  the chat log and sends prior turns as `history[]` each request. Additive, backwards-compatible.
- **Manual function-calling loop**, `MAX_TURNS = 5` (free-tier quota safety).
- **Destructive actions are gated by a signed confirmation token** (HMAC of `{tool,input,exp}` with
  a `JWT_SECRET`-derived key, 5-min TTL) — two-step, no server state.
- **Anomaly detection is deterministic TypeScript** (zero Gemini calls); Gemini writes prose over
  already-computed numbers — one call per analyze, regardless of invoice count.
- **`@mantine/charts`** (recharts under the hood) for the dashboard — themed to the existing UI.

## 1. Tool surface

Six tools, mapped 1:1 to `InvoicesService` (`src/assistant/assistant.tools.ts`):

| Tool | InvoicesService | Confirm? |
|---|---|---|
| `list_invoices(status?, limit?)` | `findAll(status)` (sliced) | — |
| `get_invoice(id)` | `findOne(id)` | — |
| `search_invoices(query)` | `search(query)` (ILIKE filename + jsonb vendor/number) | — |
| `get_invoice_stats()` | `getStats()` | — |
| `retry_invoice(id)` | `retry(id)` (guards `status==='failed'`) | — |
| `delete_invoice(id)` | `remove(id)` | **yes** (token round-trip) |

Tool results are projected to a tiny shape (`{id, vendor, total, status, …}`) before going back to
the model — never raw files or full line items — to conserve tokens.

## 2. The agentic loop

```ts
// src/assistant/assistant.service.ts
for (let turn = 0; turn < MAX_TURNS; turn++) {
  const res = await this.gemini.client.models.generateContent({
    model: this.gemini.model,
    contents,                       // history + user msg + prior functionResponses
    config: { systemInstruction: SYSTEM_PROMPT,
              tools: [{ functionDeclarations: TOOL_DECLARATIONS }] },
  });
  const calls = res.functionCalls ?? [];
  if (calls.length === 0) {
    // *-lite models sometimes end without final text after a tool call →
    // fall back to narrating the actions so the user always gets a reply.
    const content = res.text?.trim() || actions.map(a => a.summary).join(' ') || 'Done.';
    return { content, actions, history: [...] };
  }
  contents.push(res.candidates[0].content);          // model's functionCall turn
  for (const call of calls) {
    if (DESTRUCTIVE_TOOLS.has(call.name))             // delete → stop, ask to confirm
      return { pendingConfirmation: { token: sign({tool,input}), prompt, … }, … };
    const r = await dispatchTool(call.name, call.args, this.invoices);
    actions.push({ tool: call.name, input: call.args, result: r.result, summary: r.summary });
    contents.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: r.data } }] });
  }
}
```

Multi-step works out of the box: *"Retry all failed invoices"* → `list_invoices(status:'failed')`
→ N×`retry_invoice` across turns; each retry broadcasts over the existing `EventsGateway`
(`invoice.updated`), so the UI updates live — see [04-async-processing.md](04-async-processing.md),
[05-realtime.md](05-realtime.md). Verified end-to-end on `gemini-2.5-flash-lite`.

Confirmation round-trip: `delete_invoice` returns `pendingConfirmation{token,prompt}` and executes
nothing; the next request carries `confirm:{token}`; the backend verifies the HMAC + expiry and
runs `remove(id)`. Defense in depth: loop gate + tool description + signed token.

## 3. Stats aggregations

`InvoicesService.getStats()` + `GET /invoices/stats` (declared **before** `GET /:id` or the UUID
pipe shadows it). jsonb `->>` yields text, so every numeric/date cast is guarded by a regex:

```ts
// src/invoices/invoices.service.ts
const numeric = `i."extractedData"->>'total' ~ '^[0-9]+(\\.[0-9]+)?$'`;
const isoDate = `i."extractedData"->>'dueDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
// counts by status; SUM/COUNT by currency; top-5 vendors by spend;
// overdue = completed AND (dueDate)::date < CURRENT_DATE; AVG total; count-by-day
```
Returns `{ total, byStatus, byCurrency[], topVendors[], overdue, averageInvoiceValue, overTime[] }`
([invoice-stats.dto.ts](../../backend/src/invoices/dto/invoice-stats.dto.ts)). See
[03-data-model.md](03-data-model.md).

## 4. Upload helper (extraction extension)

`INVOICE_SCHEMA` + prompt in `src/processing/extraction.service.ts` gain three fields, mirrored in
`ExtractedInvoice` (backend + frontend types). No DB migration — jsonb absorbs it; defensive
defaults applied like the existing `lineItems` guard.

```ts
isInvoice: boolean;     // false → probably not an invoice
confidence: number;     // 0..1
docType: string | null; // invoice | receipt | statement | purchase_order | other
```
UI surfaces a yellow badge on the card and an Alert in the detail when
`isInvoice === false || confidence < 0.6`. See [06-extraction.md](06-extraction.md).

## 5. AI analyzer (insights)

- `POST /assistant/analyze` → deterministic anomalies (duplicates by `(vendor, number)`; high-amount
  outliers > mean + 3σ per currency) **+ one** Gemini narrative over the compact stats. Returns
  `{ summary, anomalies, stats }`.
- `POST /assistant/invoices/:id/explain` → one Gemini call → 2-sentence plain-language summary.
- Frontend: `InsightsPanel` on the Analytics tab; an "Explain with AI" button in `InvoiceDetail`.

## 6. Frontend contract (additive)

```ts
// POST /assistant/messages
{ message, history?: ChatTurn[], confirm?: { token } }
→ { content, actions: ToolAction[], history?, pendingConfirmation? }
ChatTurn = { role: 'user' | 'model', content }
ToolAction = { tool, input, result: 'ok'|'error', summary }   // unchanged
```
`MessageBubble`/`ToolActionList` are unchanged; `useAssistant` derives `history` from its local log
and renders Confirm/Cancel buttons for `pendingConfirmation`. See [09-frontend.md](09-frontend.md).

## 7. Tiers (what shipped)

- **MINIMAL** — working chat (answer + act) + `GET /invoices/stats`. ✅
- **MEDIUM** — Analytics tab (`@mantine/charts`: donut/bar/line + stat tiles) + upload-helper
  `isInvoice`/`confidence`/`docType` with low-confidence warnings. ✅
- **MAXIMUM** — AI analyzer (`/analyze`, `/explain`), `InsightsPanel`, per-invoice Explain, and a
  global **model switcher**. ✅
- Deferred (low value): streaming chat over Socket.IO — the pack rejected it for short tool-driven
  turns. See [11-decisions-and-risks.md](11-decisions-and-risks.md).

## 8. Risks

- **Gemini free-tier quota.** Two ceilings hit in testing: per-minute (RPM/TPM) and **per-day**
  (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). Mitigations: `MAX_TURNS=5`, tiny tool
  payloads, anomaly detection in TS, analyzer = one call, `humanizeError` turns 429 into a friendly
  503 message, and the **model switcher** lets you hop to a model with separate quota
  (`gemini-2.5-flash-lite` etc.) without a redeploy.
- **jsonb casts** throw on malformed values → every `::numeric`/`::date` is regex-guarded.
- **Loop safety** — `MAX_TURNS`; tool errors caught into `functionResponse`; `retry` keeps its
  `failed` guard; delete needs a valid signed token.
- **`*-lite` may end without final text** after a tool call → action-summary fallback guarantees a
  reply.
- **Single backend instance** — a stale process on :3000 silently serves the *old* model; kill it
  before relying on a model switch.

## 9. Verification

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H content-type:application/json \
  -d '{"username":"admin","password":"admin"}' | jq -r .accessToken)
H="-H authorization:Bearer $TOKEN -H content-type:application/json"

curl -s $H localhost:3000/invoices/stats | jq                          # aggregations
curl -s $H localhost:3000/ai/models | jq                               # list + current
curl -s $H -X PUT localhost:3000/ai/model -d '{"model":"gemini-2.5-flash-lite"}' | jq
curl -s $H localhost:3000/assistant/messages -d '{"message":"How many failed?"}' | jq
curl -s $H localhost:3000/assistant/messages -d '{"message":"Retry all failed invoices."}' | jq
# delete: first call → pendingConfirmation.token; second call with confirm:{token} → delete_invoice ok
curl -s $H -X POST localhost:3000/assistant/analyze | jq '{summary, anomalies}'
```
Frontend: model switcher in the header; Analytics tab renders the charts + AI insights; uploading a
non-invoice shows the low-confidence warning; chat retries/deletes update the list live. See
[10-run-and-test.md](10-run-and-test.md).

---

## Fact-check & corrections to apply

> _Generated artifact — kept as-is per the assignment deliverables. Unlike the rest of the pack,
> this roadmap was written **after** the code it describes and verified against a running system
> (chat answer / retry-all / delete-confirm, stats endpoint, model switcher, extraction
> classification all exercised live), so the items below are confirmations rather than an
> adversarial audit._

- [VERIFIED] `response.functionCalls` exists on `@google/genai@2.8.0` (getter → `FunctionCall[] | undefined`); `systemInstruction` and `tools.functionDeclarations` are valid `config` fields.
- [VERIFIED low] The assistant's `humanizeError` and extraction's local `humanizeGeminiError` overlap. Kept separate on purpose: extraction adds file-specific cases (password-protected, "no pages") the assistant never sees. Consolidate only if a third caller appears.
- [VERIFIED] Daily free-tier quota is real and per-model — the switcher is the practical workaround, not just a demo nicety.
- [NOTE] Bundle grew to ~1.1 MB after adding recharts. Acceptable for the assignment; code-split the Analytics tab with `React.lazy` if it ever matters.
