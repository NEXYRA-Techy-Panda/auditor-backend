# ACTIVE_TASK — auditor-backend

## Layer

P023, Agent C — Codex, A5-backend historical energy analytics. Owner: Mohan.
Exclusive write scope: `auditor-backend`. Starting HEAD:
`df1ecbd08369d71f88de9cf5f26e6d8fd44e8ebd`, branch `main`.

## Status

- Implementation: completed and pushed. Review: pending.
- P020 is preserved in `HANDOFF.md` and prior `PROGRESS_LOG.md` entries.
- Contract and sibling repositories unchanged.
- Feature commit `d683578106e718a4e1a42f9a29ce796bcb2d2857` was pushed normally
  to `origin/main`; `git ls-remote` matched local HEAD at publication.
- Final continuity commit `dec0c164eace26051a010b4ff2aefe113a0e9650` was also
  pushed normally; remote/local `main` matched and the auditor-backend tree was
  clean.

## Completed

- Added `/rooms`, `/devices`, `/timeseries`, and `/weekday-analytics`
  persisted-data routes; detailed filters, coverage, exact bucket behavior,
  provenance, pagination and examples are in `AUDITOR_API_EXAMPLES.md` and
  `P023_HISTORICAL_ANALYTICS_EVIDENCE.md`.
- Energy comes only from device interval energy, once per stored row. Added
  explicit expected/covered device-duration reporting, complete/partial/missing
  labels, null missing-bucket totals, local calendar weekday counts/means,
  current tariff cost, and synthetic provenance. No interval prorating.
- Summary now exposes source metadata and `gap_assessment.status` of
  `not_performed`, retaining compatibility `gaps: []`.
- Added a synthetic scratch-DB test that exercises the actual app over HTTP,
  including reference values, gaps, pagination, quantity, timezone/weekday and
  alignment behavior.

## Verification

- Contract 75/75; schema 24/24; typecheck/lint/build pass; tests 28/28.
- Actual HTTP regressions: import pass (201 then equivalent 200, 0.03 kWh,
  tariff 10 -> 0.30); analysis P010 pass; forecast P013 pass.
- P015 existing caps: 100,000 findings, 100,000 warnings, 100,000 evidence
  intervals per finding. Exceeding a cap fails the job without partial success;
  result pagination is retrieval-only, maximum 500.
- No task-owned process remains on 4001/8000; no temporary forecast directory.
  Full scale upload benchmark was not repeated.

## Exact next action

Exact next action: OpenCode integrates the documented office timeseries,
room/device breakdown and weekday routes in `auditor-frontend`, displaying
coverage/provenance and distinguishing full-period from page totals. Concurrent
frontend changes were observed and left untouched. Stop after P023; review
remains pending.
