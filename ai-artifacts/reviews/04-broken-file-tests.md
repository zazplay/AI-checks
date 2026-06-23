# Broken / malformed file upload tests

> Upload-robustness tests against the live backend: malformed, empty, oversized,
> wrong-type, and content/extension-mismatched files. Asserts that bad input is
> either rejected at upload OR processed to a graceful `failed` state — never
> crashing the worker or leaving an invoice stuck. Generated artifact.

## Summary

**8/9 as expected.** One defense-in-depth **finding** (not a crash): MIME
is validated by the request header, not by file content (magic bytes), so a text
file renamed `.pdf` is accepted at upload — but extraction then fails it cleanly, so
no crash and no stuck invoice.

## Files tested
- Real fixtures from `test-invoices/bad-invoices/` (mojibake PDF, blank form, docx, noisy scans).
- Synthetic edge cases: 0-byte PDF, truncated PDF, text-as-`.pdf`, text-as-`.png`, HTML-as-`.pdf`, 12 MB oversized PDF.

## Results

| # | File / case | Expected | Got | Result |
|---|---|---|---|---|
| BF1 | oversized.pdf (12MB)<br>_size limit enforced (10MB) -> 413_ | 413/400 rejected | `413` | PASS |
| BF2 | docx (wrong mime) | 400 rejected | `400` | PASS |
| BF3 | empty.pdf (0 byte)<br>_0-byte: accepted, will check it fails_ | rejected OR accepted-then-failed | `201` | PASS |
| BF4 | fake.pdf (text as pdf)<br>_accepted by mime (text/* ? check), will verify outcome_ | rejected OR accepted-then-failed | `201` | PASS |
| BF5 | fake.png (text as png) | rejected OR accepted-then-failed | `201` | PASS |
| BF6 | truncated.pdf | accepted-then-failed (graceful) | `201` | PASS |
| BF7 | html.pdf | rejected OR accepted-then-failed | `201` | PASS |
| BF8 | empty/fake/truncated processing<br>_empty->PDF empty; fake/truncated->Invalid PDF structure; no worker crash, no stuck processing_ | all reach failed gracefully | `all 4 failed with clear errors` | PASS |
| BF9 | content-vs-mime mismatch<br>_DEFENSE-IN-DEPTH GAP: multer fileFilter trusts request content-type, not file content. Caught later by extraction (->failed), so no crash, but a real magic-byte sniff would reject earlier. Design pack recommended sniffing; impl does not._ | FINDING: mime checked by header not magic bytes | `fake.pdf(text)/fake.png(text) accepted at upload` | FINDING |

## What this proves
- **Size limit works** — a 12 MB upload is rejected with **413** (limit 10 MB).
- **Wrong MIME (docx) rejected** at upload with **400**.
- **Graceful failure is solid** — empty / fake / truncated PDFs that pass the header
  MIME check are accepted, then **all reach `failed`** with clear errors ("The PDF
  file is empty", "Invalid PDF structure"). The worker never crashes; nothing is
  stuck in `processing`; they stay retryable.

## Finding & recommendation
**BF9 — MIME checked by header, not content.** `multer`'s `fileFilter` trusts the
request `Content-Type`, so `fake.pdf` (text) and `fake.png` (text) are accepted.
The design pack recommended sniffing magic bytes; the implementation does not.
Impact is low (extraction rejects them → `failed`), but a magic-byte check would
reject earlier, before a worker slot and AI call are spent.

_Recommendation:_ in `multer.config.ts`, read the first bytes and verify `%PDF-` /
PNG `89 50 4E 47` / JPEG `FF D8 FF`; reject mismatches with 415 instead of trusting
the declared MIME type.
