# One categorize failure aborts the whole backfill

- Date recorded: 2026-08-04
- Incident observed: 2026-08-02
- Status: Fixed in the working branch
- Area: Categorize backfill
- Severity: High

## Summary

A categorize backfill stopped at card 96 of 4,687 when one Claude CLI invocation
reached its five-minute timeout. A single card-level exception escaped the loop and
terminated the process, so the remaining cards were never attempted.

## Impact

- One malformed, slow, or unavailable response could abort a long-running batch.
- Operators needed an external retry loop to make progress.
- The run did not provide a reliable skipped-card count for later recovery.

## Cause

The categorize loop did not isolate failures at the card boundary. Exceptions from
categorizing or persisting one card propagated to the command-level handler.

## Resolution

- Catch and report failures independently for each card.
- Leave failed cards uncategorized so a later run can retry them.
- Continue processing the remaining cards and report the skipped count.
- Return a failing exit status only when every attempted card fails.

## Regression coverage

`test/services/categorize-backfill.test.ts` covers mixed success and failure, skipped
counts, continued processing, and the all-failed exit condition.
