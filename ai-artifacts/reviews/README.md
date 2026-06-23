# Code reviews

AI-assisted code-review records for the project. A multi-agent review was run
across the whole codebase (5 reviewers — 3 Claude Sonnet 4.6 + 2 Claude Opus 4.8),
cross-compared, and manually verified against the source.

| File | Covers |
|------|--------|
| [00-code-review-report.md](00-code-review-report.md) | Full report: verification pass, ranked action list, consensus findings, disagreements, and every reviewer's findings. |
| [01-cross-model-comparison.md](01-cross-model-comparison.md) | How the Sonnet vs Opus reviewers differed (breadth/line-level vs depth/architectural) and how to use both. |
| [02-api-test-plan.md](02-api-test-plan.md) | What to test across all 20 routes + auth boundary, validation, and the anti-hallucination guards. |
| [03-api-test-results.md](03-api-test-results.md) | Results of running that plan against the live backend — **42/42 passed**, no application defects. |
| [04-broken-file-tests.md](04-broken-file-tests.md) | Malformed/empty/oversized/wrong-type upload tests — **8/9**, all bad input rejected or failed gracefully; one MIME-sniffing finding. |
| [05-hallucination-tests.md](05-hallucination-tests.md) | Adversarial assistant tests (fake ids, prompt injection, ungrounded figures, refusals) — **9/9**, every guard held. |
| [06-scalability-audit.md](06-scalability-audit.md) | Per-operation scaling audit as invoice/upload counts grow (multi-agent, adversarially verified). Confirms the `findAll`-then-filter-in-JS root cause; **#1 (SQL filtering) and #2 (upload backpressure) implemented + runtime-verified**; #3–#6 + upload-spam UI races logged as backlog. Directly extends headline items 2 & 6 below. |

## Headline result

All 7 requirements are met and the codebase is solid; the review surfaced
improvements, not blockers. Highest-value verified items to act on first:

1. **Secret startup guard** — refuse to boot with the `dev-insecure-jwt-secret`
   fallback; the same secret signs auth JWTs *and* destructive-action tokens.
2. **`findEmpty()` status filter** — it currently includes in-flight invoices, so
   "delete empty invoices" could remove actively-processing ones.
3. **Atomic retry/reprocess** — add `@VersionColumn` / atomic guarded UPDATE to
   close the duplicate-job and lost-update races.
4. **SSE client-disconnect abort** — stop burning AI quota after a tab closes.
5. **CORS allowlist** + **login/assistant rate limiting**.
6. **Push filtering/pagination into SQL** — replace the `findAll`-then-filter-in-JS
   read strategy (the one issue all three reviewer families converged on).
7. **Stand up a test suite** — currently zero test files.

> Note: the reviewers' "rotate committed API keys" item was **downgraded** on
> verification — `backend/.env` is gitignored and not committed; only on-disk keys
> exist. See the verification section of the main report.
