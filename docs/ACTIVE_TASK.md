# ACTIVE_TASK — auditor-backend

## Layer

P015, Agent C — Codex, F4/M2 auditor-to-Python analysis integration. Owner:
Mohan. Exclusive write scope: `auditor-backend`. Python source is read-only at
P010 commit `36f5832f298379c3a889a32673c409152aa8eaf0`.

## Status

- Task: completed and published. Review: pending.
- Starting auditor HEAD `67998d56ec03bf25525f0dc1bf2394c7ae2558bf` was clean on
  `main`, equal to remote. No applicable `AGENTS.md` found.
- P006 outcome is preserved in `PROGRESS_LOG.md` and `HANDOFF.md`.

## Checkpoint — 2026-09-24

- Implemented Python client with bounded response bodies/timeouts, real health
  probe, validated envelopes, and safe errors; configured `ML_TIMEOUT_MS`.
- Added migration v2 for analysis execution metadata/results. Added persisted
  jobs/findings, single-worker/four-waiting queue, progress, startup recovery,
  failure states, current-tariff result costs, and paginated status results.
- Added context-window batching per device with no overlapping owned interval,
  one room, exact referenced policies, 3,600-second-plus-one-interval context,
  evidence-based merging, and explicit bound failure.
- Focused checks: 14 tests pass. Real `check:analysis-http` against an isolated
  export of P010 commit `36f5832f298379c3a889a32673c409152aa8eaf0` passed:
  reference finding 0.01 kWh; total 0.03 kWh; tariff costs ₹0.10/₹0.30;
  batch sizes 1000/317 equivalent; missing room history breaks continuity;
  requests never exceeded 1000 records per array.
- Final verification passed: contract (75), schema (24), typecheck, lint,
  tests (14), build, import HTTP regression, and real analysis HTTP integration.
- Exact next action: review pending; stop after P015.
