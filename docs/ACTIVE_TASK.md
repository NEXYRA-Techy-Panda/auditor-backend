# ACTIVE_TASK — auditor-backend

## Layer

P020, Agent C — Codex, M3 auditor forecast integration. Owner: Mohan.
Exclusive write scope: `auditor-backend`. Read-only Python baseline:
P013 commit `7f71363aa9361e67a0cb2815b98aee79b0708cf9`.

## Status

- Task: completed; publication pending. Review: pending.
- Starting auditor HEAD `32d88beabc7d0e1d1a3fb7d26ae74117b4cce6ca` was clean on
  `main`, equal to `origin/main`.
- P006 and P015 outcomes are preserved in `PROGRESS_LOG.md` and `HANDOFF.md`.
- P015 correctness evidence addendum is in
  `P015_ANALYSIS_INTEGRATION_EVIDENCE.md`; it closes the result-cap overflow
  test gap and distinguishes retrieval pagination from result bounds.

## Checkpoint — 2026-09-24

- Reused P015's persisted job queue for forecasts; added migration v3, typed
  Python `/v1/forecast` client, public forecast job routes and persisted hourly
  results. Existing import and analysis APIs remain available.
- Built history from stored device interval energy on the Asia/Kolkata hourly
  grid, with complete non-overlapping coverage required for every expected
  device. Exact partial unions are accepted; crossing-hour intervals,
  overlaps and missing device hours are omitted and disclosed.
- Added deterministic/API tests for all horizons, 2,160-hour cap,
  missing/overlap/partial/crossing inputs, origin defaults, policy transitions,
  persistence, tariff handling and Python response validation. Final suite:
  27/27 pass.
- Real P013 HTTP check: 672 observed hours, 720 November points, 10.8 kWh,
  current tariff repricing, and a persisted insufficient-history failure.
- Contract 75/75, schema 24/24, typecheck, lint, build and import HTTP regression
  pass. Exact next action: inspect scope, commit and push without force, verify
  remote `main`; review pending.
