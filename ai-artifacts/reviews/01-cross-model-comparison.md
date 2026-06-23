# Cross-model comparison — Sonnet vs Opus reviewers

> How the three **Claude Sonnet 4.6** reviewers and the two **Claude Opus 4.8**
> reviewers differed in reviewing the same codebase. Companion to
> [00-code-review-report.md](00-code-review-report.md).

## At a glance

| | Sonnet (×3) | Opus (×2) |
|---|---|---|
| Total findings | 50 | 26 |
| Findings per reviewer | ~16 | ~13 |
| Altitude | line-level, exact `file:line` + copy-paste fix | system-level patterns + refactors |
| Strength | discrete, instantly-verifiable bugs | single symptoms traced to shared root causes |

## Per-reviewer breakdown

| Model | Reviewer | Findings | Severity mix | Top categories |
|---|---|---|---|---|
| Sonnet | correctness & reliability focus | 15 | high:4, low:5, medium:6 | bug(5), reliability(5), security(3) |
| Sonnet | security-focused senior engineer | 14 | critical:1, high:3, low:6, medium:4 | security(11), reliability(1), bug(1) |
| Sonnet | frontend/React/UX reviewer | 21 | high:3, low:7, medium:11 | bug(9), performance(6), reliability(2) |
| Opus | Principal Engineer (architecture | 12 | high:1, low:5, medium:6 | maintainability(5), bug(3), reliability(2) |
| Opus | staff engineer (performance, sca | 14 | high:4, low:6, medium:4 | performance(7), reliability(3), maintainability(2) |

## What the comparison agent observed

BREADTH vs DEPTH: The three Sonnet reviewers produced more findings total (14+14+22) and operated at line-level — each finding pinned to an exact line with a concrete copy-paste fix (add @IsNotEmpty here, add enabled:true there, wrap in useMemo). They were strongest at catching discrete bugs the orchestrator can verify in seconds (findEmpty status filter, InvoiceThumb empty-string query, role=button without onKeyDown, dead throw lastError). The two Opus reviewers produced fewer findings (13+15) but each was a system-level pattern: 'three near-identical agentic loops with no shared abstraction', 'four hand-synced tool registries', 'findAll-then-filter as a data-access STRATEGY', 'no test suite at all'. Opus consistently traced single symptoms back to a shared root cause (the lost-update race, the double-serialization, and the watcher fragility were all framed as instances of larger design gaps) and proposed refactors (AssistantEngine interface, single tool-definition array) rather than spot fixes.\n\nDIVISION OF LABOR: Sonnet reviewers were explicitly persona-scoped (correctness, security, frontend) and stayed in lane — the frontend Sonnet owned all React/a11y/hook findings that neither Opus touched; the security Sonnet owned helmet/rate-limiting/file-MIME/Swagger that no one else raised. Opus reviewers ranged wider per head (the principal covered AI architecture AND a chart currency bug AND magic constants; the staff reviewer covered perf AND data model AND the complete absence of tests AND a date-string-comparison bug).\n\nCONFIDENCE CALIBRATION: Both families self-rated honestly. Sonnet flagged its own speculative items as 'low confidence' (the millisecond dedup-key collision, the threshold gap). Opus hedged its medium-confidence design claims ('confusing branch', 'likely-unintended fall-through' on engine selection). I found NO outright false positives in either set on the claims I verified — every high/critical item checked out (findEmpty, JWT fallback, retry race, SSE abort, .env on disk, double-serialization, rawText dead column, dead throw lastError all confirmed). The closest to a soft finding is Sonnet security's navigate_ui UUID guard (mitigated today, future-proofing) and Sonnet correctness's reprocess attempts-counter (arguably intended) — both correctly self-rated 'low'. Opus's 'unbounded history' overlapped with two Sonnet reviewers, showing the same issue surfaces independently across models.\n\nNET: Sonnet = high-recall, ship-today bug list with exact fixes. Opus = high-precision, root-cause refactor map plus the two things no Sonnet reviewer raised at all (zero test coverage; the provider/tool-registry duplication that makes every future change a 3-5-place edit).

## Reading of the pattern

- **Sonnet = breadth + precision.** More findings, each pinned to a line with a
  concrete fix the orchestrator could verify in seconds (the `findEmpty` status
  filter, `InvoiceThumb` empty-string query, `role=button` without `onKeyDown`,
  the dead `throw lastError`). The personas stayed in lane, so coverage was wide:
  the frontend Sonnet owned all React/a11y/hook findings no Opus touched; the
  security Sonnet owned helmet / rate-limiting / file-MIME / Swagger that no one
  else raised.
- **Opus = depth + synthesis.** Fewer findings, but each was a *pattern*: "three
  near-identical agentic loops with no shared abstraction", "four hand-synced tool
  registries", "findAll-then-filter as a data-access *strategy*", "no test suite at
  all". Opus repeatedly traced several symptoms to one root cause (the lost-update
  race, double-serialization, watcher fragility all framed as instances of larger
  design gaps) and proposed refactors rather than spot fixes.
- **Best used together.** The strongest signal is where they *converged* without
  coordinating — e.g. all three families independently flagged the
  `findAll`-then-filter strategy and the weak-secret fallback. Sonnet tells you
  *what to fix now*; Opus tells you *what to redesign so the class of bug stops
  recurring*.

## Practical takeaway for this project

- **Act on the Sonnet line-level highs first** — they are cheap, verified, and
  high-value (findEmpty filter, empty-message guard, CORS allowlist, secret guard).
- **Schedule the Opus structural items** as follow-up — the SQL-filter refactor,
  the unified `AssistantEngine` abstraction, the single tool-definition registry,
  and standing up a test suite — because they remove whole categories of future bugs.
