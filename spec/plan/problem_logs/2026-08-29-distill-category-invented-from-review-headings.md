# Distillation still invents categories from review document headings after correction hints

- Date recorded: 2026-08-29
- Incident observed: 2026-08-29 Tier 1 daily ingest (run `01M14WFN0WCDF02PVWW60FX3NW`)
- Status: Mitigated by prompt change; still recurring as of 2026-08-31
- Area: Distillation / prompt
- Severity: Medium

## Summary

Despite the 2026-08-23 correction-hint fix (`spec/plan/problem_logs/2026-08-23-distill-retry-repeats-invalid-category.md`),
`review` source documents kept failing with `category: invalid_value` on all 3
attempts, hints included. A one-off reproduction outside the normal ingest path
(direct `claude` CLI call with the same system prompt and one failing document,
`Review/Augur/2026-07-13/REVIEW.md`) confirmed the model invents category names such
as `cicd_supply_chain` and `test_coverage` — snake_case labels that mirror the
document's own section headings (`REVIEW_VULNERABILITY.md`, "Test Coverage", "CI/CD
Supply Chain"), not any value in the controlled vocabulary. Only the raw `category`
field was inspected for this diagnosis, per the non-transcription rule; no other card
content or document text was recorded.

## Impact

Same as the 2026-08-23 log: affected `review` documents never ingest even with
`--retry-failed`, because the model repeats the same invented category every attempt.
The 2026-08-23 fix (surfacing the allowed-value list on retry) did not stop the
model from re-deriving a category from the document's own structure — the hint says
what is allowed but does not say the heading-derived guess is the actual mistake.

## Cause

The prompt's category section told the model to "never invent a value that is not
listed", but gave no concrete example of the exact failure mode this project's
`review` documents trigger: treating a Markdown section heading or review-dimension
label as if it were a `category` value. Nothing in the prompt named this specific
confusion, so the correction hint (a bare allowed-values list) did not address the
model's actual misconception.

## Resolution

Added a paragraph to `prompts/distill.md` directly under the category vocabulary
list, naming the concrete failure mode (`review` document headings like
"Vulnerability" / "Test Coverage" / "CI/CD Supply Chain" are the document's own
section names, not `category` values) and the exact invented values observed
(`cicd_supply_chain`, `test_coverage`), instructing the model to fall back to
`general` when no listed category clearly fits rather than deriving one from
surrounding document structure.

This is a prompt-only mitigation; no code path changed. A later Tier 1 run on
2026-08-31 still produced 14 `category: invalid_value` failures from 169 `review`
documents; one `--retry-failed` attempt resolved 7 and left 7 recurring failures.
The next diagnosis must capture only the raw `category` value again (via the same
one-off, out-of-band reproduction — never persisted to `ingest_failures` or logs)
to determine whether the model is still deriving from headings or has moved on to
a different invented pattern. Because the prompt-only fix did not eliminate the
failure, evaluate constrained generation or another observable recovery path that
preserves the existing fail-fast rule: out-of-vocabulary values must still be
rejected rather than silently coerced to `general`.
