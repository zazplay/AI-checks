# Claude Design prompt — "AI Settings" page

> Paste everything below the line into Claude Design. It is written to match the
> existing dark artifacts in `../invoice-modal/` (Invoice Modal / Detail — Split)
> so the new page is visually consistent, and detailed enough that the result can
> be rebuilt 1:1 in **Mantine v8** (the app's UI library, `primaryColor: indigo`,
> `defaultRadius: md`, dark scheme).

---

Design a single, self-contained **"AI Settings" page** for an invoice-processing
web app. Dark theme, dense, modern, calm. It is a full-page view (not a modal)
that lives behind a header tab toggle "Invoices | **Settings**". Match the exact
visual language below.

## Canvas & shell

- Page background: `radial-gradient(1200px 600px at 50% -10%, #181d21 0%, #101316 60%)`, min-height 100vh, padding `48px 32px 80px`, content centered in a **960px** max-width column.
- Font: `'IBM Plex Sans', system-ui, sans-serif`; monospace accents (ids, keys, numbers): `'IBM Plex Mono'`. Antialiased. Base text color `#e8eaed`, muted `#7d858d`, dim `#6b7178`.
- Page header block: title `AI Settings` (19px, weight 600, letter-spacing -0.01em) + subtitle `Choose the AI engines, check provider keys, and tune extraction & assistant behavior.` (13.5px, color `#7d858d`, margin-top 4px).
- Custom scrollbar: width 10px, thumb `#2e343a` radius 6px, transparent track. Selection highlight `#8b5cf6` on `#fff`.

## Color tokens (use these exactly)

- Surfaces: page `#101316`, card `#15181b`, raised input `#1c2125`, deeper inset `#13161a`. Card border `#2a2f34`, inner divider `#23282d`.
- Text: primary `#e8eaed`, secondary `#cbd0d4`, muted `#9aa1a8` / `#7d858d`, dim `#6b7178`.
- Accent (indigo/blue primary): `#3b82f6` (solid), gradient buttons `linear-gradient(135deg,#3b82f6,#2563eb)`, light-blue text `#7fb0f5`, violet `#8b5cf6` / text `#b9a4fb`.
- Status semantics: success green `#34d399` (text `#7fe7b8`), warning amber `#e0a458`, danger red `#ef4444` (text `#f08886`/`#ef6461`).
- Radii: cards `18px`, inner panels `12–14px`, controls/inputs `9–11px`, pills `999px`. Card shadow `0 40px 100px -30px rgba(0,0,0,0.8)`.
- Common font-sizes: section title 15px/600, body 13px, label 12.5px, helper/caption 11px / 10.5px, pill 10px uppercase letter-spacing 0.08em.

## Layout — three stacked cards (each: bg `#15181b`, border 1px `#2a2f34`, radius 18px, padding 22px, gap 18px between cards)

Each card has a header row: a 32px rounded icon tile (bg `#1c2125`, border `#2a2f34`, radius 9px) + title (15px/600) + one-line description (12px, `#7d858d`) on the next line.

### CARD 1 — "Engines"  (icon: cpu/chip)

Two labeled dropdown rows, side by side on wide screens, stacked on narrow.

- **Extraction engine** — label (12.5px `#9aa1a8`) + helper "Engine tried first on upload; others stay as fallback." A custom **Select** styled like a button: bg `#1c2125`, border `#2a2f34`, radius 10px, height 36px, left chip icon, value text 13px, chevron right. The open dropdown is grouped: a "Claude" group (item `claude-haiku-4-5`) and a "Gemini" group (items `gemini-2.5-flash`, `gemini-2.5-flash-lite`). Selected item has a blue check `#7fb0f5` and bg `#23292e`.
- **Assistant engine** — same control. Grouped dropdown: "Gemini", "Groq (big free quota)", "Claude (Haiku)". Show the chosen value as `provider / model` e.g. `groq / llama-3.3-70b-versatile`. Disabled (greyed, 0.4 opacity, not selectable) any option whose provider key is missing.

Show the current selection of each as a small monospace pill under the control (bg `#13161a`, border `#23282d`, text `#cbd0d4`).

### CARD 2 — "Providers"  (icon: key)

A vertical list of **three provider rows** (Claude, Gemini, Groq), each row: left = provider name (13px/600) + tiny monospace env-var hint (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY`, 10.5px `#6b7178`); right = a **status pill** + a **"Test" button**.

Status pill states (render ALL of these as separate visual states so I can wire them):
- `no key` — grey: bg `#1c2125`, border `#2a2f34`, dot `#6b7178`, text `#9aa1a8`.
- `configured` — neutral blue: bg `rgba(59,130,246,0.12)`, border `rgba(59,130,246,0.3)`, dot `#3b82f6`, text `#7fb0f5`.
- `working` — green: bg `rgba(52,211,153,0.12)`, border `rgba(52,211,153,0.28)`, dot `#34d399` with glow `0 0 8px #34d399`, text `#7fe7b8`, label `WORKING`.
- `invalid (401)` — red: bg `rgba(239,68,68,0.12)`, border `rgba(239,68,68,0.32)`, dot `#ef4444`, text `#f08886`, label `INVALID KEY`.
- `rate-limited (429)` — amber: bg `rgba(224,164,88,0.12)`, border `rgba(224,164,88,0.3)`, dot `#e0a458`, text `#e0a458`, label `RATE LIMITED`.
- `testing` — blue spinner (10px ring, `#7fb0f5` top, `animation:spin .7s linear infinite`) + `TESTING…`.

"Test" button: bg `#15181b`, border `#2a2f34`, radius 9px, 13px `#cbd0d4`, hover border `#3b82f6`/text `#7fb0f5`. When testing, it's disabled with the spinner.

Under each row, a thin **rate-limit line** (only shown after a test/real call): monospace, e.g. `requests: 48 / 50 remaining · resets in 42s` (label `#6b7178`, numbers `#cbd0d4`). Plus a one-line muted footnote at the bottom of the card: "Remaining quota is the last value seen on a real request. Account balance is not exposed by the provider APIs." (11px `#6b7178`).

### CARD 3 — "Behavior"  (icon: sliders/adjustments)

Four tunable controls. Each: label (12.5px `#9aa1a8`) + helper line (11px `#6b7178`) + the control + a live "current value" readout on the right.

1. **Extraction strictness** — a 3-stop **segmented slider**: `Lenient · Balanced · Strict`. Track bg `#13161a` border `#23282d` radius 11px; active segment bg `#23292e` text `#e8eaed`; inactive text `#7d858d`. Helper: "Higher = reject low-confidence or math-inconsistent extractions (they land in Failed)." Default `Balanced`.
2. **"Looks like an invoice" threshold** — a continuous **slider 0.00–1.00**, step 0.05, default 0.50. Filled track gradient `linear-gradient(90deg,#3b82f6,#8b5cf6)`, thumb white 16px with shadow, value bubble in mono `0.50`. Helper: "Below this confidence the document is flagged 'may not be an invoice'."
3. **Chat action mode** — a 3-stop segmented control: `Read-only · Ask first · Autonomous`. Show a small colored pill next to the active one: Read-only = grey, Ask first = blue, Autonomous = amber (with a tiny warning glyph). Helper: "Controls whether the assistant can retry/delete/export on its own, must confirm first, or only answer."
4. **Throughput** — two compact **number-steppers on one row**: "Concurrency" (1–8, default 2) and "Rate limit" (jobs / min, default 8). Stepper: inset bg `#13161a`, border `#23282d`, −/＋ buttons `#1c2125`. A small amber inline note: "Applied on next worker restart." (10.5px `#e0a458`).

## Footer action bar (sticky at the bottom of the column)

A right-aligned row: a muted "Unsaved changes" hint (appears only when dirty, 12px `#e0a458`) + a ghost **"Reset to defaults"** button (bg transparent, border `#2a2f34`, text `#cbd0d4`) + a primary **"Save changes"** button (gradient `linear-gradient(135deg,#3b82f6,#2563eb)`, white, radius 10px, shadow `0 8px 22px -10px rgba(59,130,246,0.8)`, hover `filter:brightness(1.08)`).

## Interactive states to render (so each can be wired)

Use the artifacts' state-toggle pattern (a small control bar at the top with `<sc-if>` variants) so reviewers can flip between:
- Providers: all-configured / one-invalid / one-rate-limited / one-missing-key.
- A "testing in progress" state for one provider (spinner pill + disabled Test).
- Behavior card: strictness on each of the 3 stops; chat mode on each of the 3 stops; threshold slider at 0.20 / 0.50 / 0.80.
- Footer: clean vs. dirty (unsaved-changes visible).

## Notes for faithful rebuild in Mantine v8 (keep the design mappable)

- Cards → Mantine `<Card withBorder>`; section icon tile → `<ThemeIcon variant="default">`.
- Dropdowns → Mantine `<Select>` with `data` groups + `renderOption` (the existing app already styles these); pills → `<Badge>`; Test button → `<Button variant="default" size="xs">`.
- Strictness / chat-mode → `<SegmentedControl>`; threshold → `<Slider>`; throughput → `<NumberInput>` with steppers.
- Footer → `<Group justify="flex-end">` with `<Button variant="default">` + `<Button variant="gradient" gradient={{from:'indigo',to:'cyan'}}>`.
- Keep every interactive element a real, distinct element (no baked-in single state) so behavior and status variants can be bound to props/state.

Deliver one page showing the full layout in its default (Balanced / Ask-first / all-configured / clean) state, plus the state toggles above.
