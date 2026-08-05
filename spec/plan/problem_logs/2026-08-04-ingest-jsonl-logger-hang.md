# Ingest JSONL logger hang stalls a run

- Date recorded: 2026-08-04
- Incident observed: 2026-08-02
- Status: Fixed in the working branch
- Area: Ingest logging
- Severity: High

## Summary

An ingest run stopped making progress after its last card was created. The expected
`document-completed` log entry did not appear for roughly 19 hours even though the
Claude and Ollama timeout paths had already completed. The run was awaiting the
JSONL log append on its critical path.

## Impact

- The active ingest run appeared hung and did not advance to the next document.
- Operational recovery required intervention even though the card-processing work
  itself had completed.
- A degraded loopback filesystem or append operation could therefore stop the
  entire run indefinitely.

## Cause

`JsonlIngestLogger.append` awaited `appendFile` without a time bound. If that call
never settled, the caller also never settled and the ingest pipeline could not
continue.

## Resolution

- Bound each append attempt to five seconds.
- Drop only the affected log entry after the timeout.
- Emit a warning through the injected warning sink.
- Keep later appends and the ingest run able to continue.

## Regression coverage

`test/ingest/jsonl-ingest-logger.test.ts` covers an append implementation that never
settles, checks that the timeout returns control, verifies the warning, and confirms
that a later append can still succeed.
