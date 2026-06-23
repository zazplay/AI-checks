# AI Assistant — Multi-engine tool use (as built)

> **Updated to match the shipped code.** The original plan was a Claude-only
> tool-use loop with 6 tools. The system actually built runs the **same tool
> surface across three engines** (Groq / Claude / Gemini), grew to **15 tools**,
> **streams its progress over SSE**, and adds **anti-hallucination guards** and a
> **field-edit** action with confirmation. This doc describes the real
> `backend/src/assistant/`. See also [12-ai-roadmap.md](12-ai-roadmap.md).

## Decisions

- **Multi-engine, runtime-switchable.** One tool surface, converted to each SDK's
  format: Gemini `functionDeclarations`, OpenAI/Groq `tools`, Anthropic
  `tool_use`. Default engine is **Groq** (big free quota), with Claude
  (`claude-haiku-4-5`) and Gemini selectable at runtime (`PUT /ai/assistant-engine`).
- **Manual agentic loop**, `MAX_TURNS = 8`, so we control the destructive-action
  gate, the per-tool dispatch, and the live progress emit.
- **Stateless endpoint; client passes history.** `POST /assistant/messages` takes
  `{ message, history?, confirm? }` and returns `{ content, actions, history,
  pendingConfirmation? }`. A streaming twin, `POST /assistant/messages/stream`,
  emits the same result preceded by live `step` events (SSE).
- **Destructive actions are gated by an HMAC-signed token** (5-min TTL): delete
  and field-edit return a `pendingConfirmation`; nothing happens until the user
  confirms.

## The tool surface (15 tools)

All wrap `InvoicesService`, so the assistant can only reach states the REST API
can.

**Read / find**
- `list_invoices(status?, limit?)`, `get_invoice(id)`, `search_invoices(query)`
- `list_empty_invoices()` — invoices with no usable data
- `query_invoices(sort?, minTotal?, maxTotal?, vendor?, limit?)` — by amount
- `filter_invoices(...)` — **targeted subset** by status / vendor / amount /
  currency / issue & due dates / overdue / problems / empty / line-item text /
  search; returns full per-invoice detail so the model analyses just that subset
- `get_dataset(status?)` — the whole dataset in one call (for cross-invoice analysis)
- `get_invoice_stats()` — aggregate counts/totals

**Act**
- `retry_invoice(id)`, `retry_all_failed()`, `retry_failed_then_cleanup()`
- `reprocess_invoice(id)` — re-run extraction on **any** status (re-check)
- `update_invoice(id, fields…)` — **correct extracted fields**, gated by a
  before→after confirmation
- `delete_invoice(id)` / `delete_invoices(ids)` — gated by confirmation
- `export_invoices(format, filters…)` — xlsx / csv / zip download

**UI / meta**
- `render_chart(type, metric, title?)` — draws a real chart from server stats
- `navigate_ui(...)` — open a detail, switch tab, set a filter/search, open upload
- `suggest_actions(suggestions[])` — clickable next-step buttons under the reply

## The agentic loop (per engine)

Same shape in all three; only the SDK message format differs.

```
messages = history + user message
for turn in 0..MAX_TURNS:
  onStep('thinking')                       # emitted live over SSE
  res = engine.generate(messages, tools)
  if no tool calls: return groundReplyText(res.text), actions, history
  for each tool call:
    if destructive(tool): return buildGatedPending(...)   # ask to confirm, stop
    onStep('tool', label)                                  # live step
    result = dispatchTool(name, args, InvoicesService)
    actions.push({tool, input, result, summary, data?})
    append tool result to messages
return "couldn't finish within the step limit"
```

`data` is forwarded to the UI for rich rendering (invoice cards, stats chart,
navigation intent, chart spec, download, suggestions).

## Streaming (SSE)

`POST /assistant/messages/stream` writes Server-Sent Events: a `step` frame per
`thinking`/`tool` step as the loop runs, then a `result` frame with the same
`AskResult`, then closes. The chat shows live progress ("Thinking → Filtering
invoices → Working on it") instead of a mute spinner; the non-streaming endpoint
stays for scripts. The client falls back to it if streaming fails.

## Confirmation round-trip (delete & edit)

Destructive tools don't execute inline:

1. The loop hits a `delete_*` / `update_invoice` call → `buildGatedPending`
   resolves the **real** invoice(s), then returns `pendingConfirmation` with a
   signed token and a human prompt (delete: file name + total; edit:
   `field: before → after`). Nothing is changed yet.
2. The frontend renders Confirm / Cancel buttons.
3. On confirm, the client re-posts with `confirm: { token }`. The backend
   verifies the HMAC + expiry and applies the action **without re-invoking the
   LLM** (an empty user message would 400 on Claude).

## Anti-hallucination guards

The assistant was hardened against acting on invented ids (full notes:
[../research/hallucination-mitigation.md](../research/hallucination-mitigation.md)):

- **UUID guard** on every id-taking tool (`get_invoice`, `retry_invoice`,
  `reprocess_invoice`, delete, edit): a non-UUID id returns a friendly "look it
  up first" error instead of reaching Postgres.
- **Find-then-act** is enforced in the system prompt with a worked example: for a
  request by description ("delete the largest overdue invoice"), the model must
  `filter_invoices` first and take the real id from the result.
- **Resolve-before-confirm**: delete/edit tokens are only signed for ids that
  actually resolve to real invoices.
- **Grounding guard**: any UUID the model writes in its prose that isn't in this
  turn's tool results is stripped (replaced with "that invoice").

These are verified end-to-end in
[../reviews/05-hallucination-tests.md](../reviews/05-hallucination-tests.md) (9/9).

## Other assistant endpoints

- `POST /assistant/analyze` — deterministic anomaly detection (duplicates by
  vendor+number; high-amount outliers > mean+3σ per currency) **plus** one
  narrative summary from the selected engine.
- `POST /assistant/invoices/:id/explain` — a 2-sentence plain-language summary of
  one invoice.

## Engine config

```
ASSISTANT_PROVIDER=        # gemini | groq | claude ; empty = auto (Groq>Claude>Gemini)
ANTHROPIC_API_KEY=...      # claude-haiku-4-5
GROQ_API_KEY=...           # llama-3.3-70b-versatile / gpt-oss-120b / …
GEMINI_API_KEY=...         # gemini-2.5-flash / -lite
```

A provider is selectable only when its key is set. The chat engine is independent
of the extraction engine and both are switchable at runtime from the header.
