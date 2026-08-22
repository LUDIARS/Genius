# Distillation retries repeat the same invalid category without correction

- Date recorded: 2026-08-23
- Incident observed: 2026-08-21/22 (Tier 1 daily ingest)
- Status: Fixed in the working branch
- Area: Distillation / retry
- Severity: Medium

## Summary

The 2026-08-21/22 Tier 1 run ended `completed-with-errors` with 25 failed documents,
all from the `review` source. Every failure was
`ZodError(cards.N.category: invalid_value)` after exactly 3 attempts, with no
document ever recovering on retry. Filenames such as `REVIEW_QUALITY.md` and
`REVIEW_VULNERABILITY.md` strongly suggest the model was inferring a category from the
filename (e.g. `quality`, `vulnerability`) instead of picking from the controlled
vocabulary. The same failure pattern (25-653 documents) recurred across multiple runs
(2026-08-13, 2026-08-14, 2026-08-21), so it is not a one-off transient error.

## Impact

- `review` source documents whose filename suggests an out-of-vocabulary category name
  never ingest, even after `--retry-failed`, because the model repeats the same wrong
  guess every time.
- Three LLM calls were spent per failing document for a deterministically repeating
  error, wasting distillation budget without a chance of success.

## Cause

`requestValidatedJson` (`src/distill/json-completion.ts`) retried by resending the
exact same request on every attempt. When the model's error was systematic — not a
one-off flub — nothing in the retry differed, so the outcome was identical every time.

## Resolution

- On a Zod validation failure, build a correction hint from the issue list. For an
  invalid enum value (`invalid_value` with a `values` list, e.g. `category`), the hint
  spells out the exact allowed values.
- Identical instructions are collapsed. The real failure shape is the same enum
  violation on many array elements (`cards.0.category`, `cards.1.category`, …), so
  paths are generalised to `cards[].category` and deduplicated — the allowed-value
  list appears once per retry instead of once per offending card.
- The hint is always derived from the immediately preceding attempt and applied to a
  fresh copy of the original request, so hints never compound across attempts and the
  caller's request object is never mutated. No LLM output is transcribed into the hint
  or into logs — only issue `path`/`code`/allowed-values, matching the existing
  non-transcription rule (`spec/feature/operations.md` §4).
- A `SyntaxError` (malformed JSON) retries with the unchanged prompt, since there is no
  schema-derived correction to offer. If a schema failure is followed by a syntax
  failure, the now-irrelevant schema hint is dropped rather than carried forward.

## Regression coverage

`test/distill/json-completion.test.ts` covers: an invalid enum value on the first
attempt where the corrected retry prompt lists the allowed values and the second
attempt succeeds; a JSON syntax failure where the retry prompt is unchanged; a
multi-element enum violation where the allowed-value list is stated exactly once; a
schema-then-syntax failure sequence where the stale hint is dropped; and a repeated
schema failure where the hint never accumulates.
