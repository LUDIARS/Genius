# Ingest reader I/O had no upper bound and could stall a run silently

- Date recorded: 2026-09-01
- Incident observed: 2026-09-01 (Tier1 run `01M1CKP6D2EG2TPD2S0EPG0SNA`)
- Status: Reader timeout gap mitigated in the working branch; incident root cause unresolved
- Area: Ingest reader I/O
- Severity: High

## Summary

A Tier1 ingest run was accepted (run id returned) but `filesProcessed` stayed at 0
for more than 6 minutes, confirmed by a direct `distill_runs` SELECT (not an API
display bug — `SPEC-GENIUS-INGEST-RUN-PROGRESS` and `SPEC-GENIUS-BUILD-FRESHNESS`
were both already fixed and ruled out). `logs/ingest.jsonl` and stderr had zero
entries for this run; the last stderr line before it was from the previous run,
about 20.5 hours earlier. `unresolvedFailures=10` was leftover from a prior run,
not new progress. Later, the service's own `/healthz` (documented as I/O-free —
its latency *is* event-loop availability, spec/feature/operations.md §9) started
timing out, indicating the Node event loop itself had stopped responding, not
just the ingest task.

## Cause

Every I/O path introduced after the run begins already had a bound: Claude CLI
completion (5 min), Claude CLI readiness (10–30s), the JSONL ingest logger append
(5s, fixed by `2026-08-04-ingest-jsonl-logger-hang.md`), and the Memoria reader's
`fetch` calls (`AbortSignal.timeout`, 30s). But `IngestService#ingestSource` awaited
`reader.listDocuments()` and `IngestService#processDocument` awaited
`reader.readDocument()` with no timeout at all. If either returned Promise never settles —
for example because of a degraded filesystem or a future reader defect —
the run stops after the preceding `run-started` and `source-started` entries. This
is the same shape of gap as the JSONL logger hang: an un-timed `await` sitting
directly on the ingest run's critical path.

This is a confirmed timeout-coverage gap, but not a confirmed root cause of the
incident. The observed run had no log entries at all, whereas either reader call is
made only after `run-started` and `source-started` have been written. Moreover, an
unresolved asynchronous Promise does not by itself block Node's event loop, so it
cannot explain the later `/healthz` timeout. If the event loop itself is blocked,
the timer introduced by this fix cannot fire either. The exact call that hung in
this incident was not identified (document/card
bodies are never persisted to logs per spec/feature/operations.md §4, so the
hang could not be diagnosed after the fact from `ingest_failures` or
`ingest.jsonl`). The fix closes the *class* of bug rather than one call site.

## Resolution

- Wrap `reader.listDocuments()` and `reader.readDocument()` calls in
  `IngestService` with a timeout (`withReaderTimeout` in
  `src/ingest/ingest-service.ts`): 120s for `listDocuments`, 60s for
  `readDocument`.
- A timeout raises `SourceReaderError`, so it flows through the existing
  classification (`source-read-failed`) and isolation paths unchanged —
  `listDocuments` timeouts isolate to the source (matches the existing
  Memoria #696 source-level isolation), `readDocument` timeouts isolate to
  the document (existing `ingest_failures` / `--retry-failed` path).
- The original (never-settling) promise itself cannot be cancelled generically
  after it has been passed to `IngestService`. A reader may implement its own
  cancellation with `AbortSignal`; otherwise the run simply stops waiting, the same
  trade-off already accepted for the JSONL logger fix.

## Regression coverage

`test/ingest/ingest-failure-isolation.test.ts` adds two cases using
`vi.useFakeTimers()`: a `listDocuments` call that never resolves (isolates to
the source, run finishes `completed-with-errors`) and a `readDocument` call
that never resolves for every document in the batch (isolates each to a
document-level failure, still finishes `completed-with-errors`).

## Follow-up

The actual stuck call and the cause of event-loop unavailability in this incident
are still unknown. A reader stall while the event loop remains responsive now
surfaces a `source-failed` or `document-failed` log entry with
`errorKind: source-read-failed` and a bounded message identifying which
`operation` (`listDocuments` or `readDocument`) and `source` timed out —
enough to narrow down the reader without inspecting document bodies. A recurrence
with zero run logs or another `/healthz` timeout requires a separate investigation.
