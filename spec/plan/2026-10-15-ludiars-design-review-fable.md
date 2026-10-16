---
title: LUDIARS 9-tool design review — Genius
type: plan
status: proposed
updated: 2026-10-17
---

# Genius: judgment advice with private provenance and observable ingestion

Genius owns judgment cards, ingestion provenance and recorded outcomes. Cc owns
coordination, Actio task status, Pf specifications, An analysis, Augur test planning,
Rv review/merge, Br public summaries and Cf game adoption. Advice must not become
implicit execution authority, and private cards must not become public Br data.

Reviewed main 441266e: CLAUDE.md, README.md, excubitor.catalog.yaml,
src/api/routes/health.ts, spec/feature/operations.md (§9, §12, §13).
SPEC-GENIUS-HEALTH-READINESS separates I/O-free /healthz from dependency-aware
/readyz. The implementation already does this; the old catalog comment incorrectly
said /healthz waited for Ollama/model warmup. Implemented comment correction only.
Probe URL, timings, process behavior and restart policy are unchanged.

## Priorities and rebuttals

1. Observe ingestion progress/outcomes separately from process liveness. Existing
   completed-with-errors, buildStale and reader timeouts already address parts of
   the handoff; do not introduce a second run lifecycle. Acceptance: stale build,
   no progress, source failure and unavailable dependency are distinguishable.
2. Preserve local embeddings for sensitive text and explicit configured LLM backend.
   An external embedding fallback or a no-op success would violate CLAUDE.md.
   Acceptance: unavailable configuration fails explicitly without sending sensitive
   content outward; tests use synthetic cards and never production data/config.
3. Cc requests should retain judgment-card references and applicability, rather than
   copy cards into task/spec stores or treat lack of precedent as a block forever.
   Human direction remains authoritative. Outcome feedback belongs to Genius.
4. Reduce repeated calls only after measuring them. Health readiness and judgment
   lookup have different freshness needs; a shared health cache must not turn old
   success into current dependency readiness. Preserve source revision/provenance
   when sharing bounded summary evidence with An/Augur/Br.

The reader timeout described in operations does not cancel arbitrary underlying
Promises or unblock a blocked event loop. Do not claim all stalls are solved.
The handoff's large integration and operational changes remain proposals; no
performance gain, deployment or human UX acceptance is asserted.

Source consistency and git diff --check performed; no tests, service operations,
ingest runs or real-data access were executed. Recovery: revert comments and this
proposal; no database migration, configuration change or restart is necessary.
