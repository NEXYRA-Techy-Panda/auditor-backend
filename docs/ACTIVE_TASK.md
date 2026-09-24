# ACTIVE_TASK — auditor-backend

## Layer

P003, Agent C — Codex, F3-A — Auditor SQLite foundation. Owner: Mohan.

## Objective

Implement a migration-backed, dataset-scoped SQLite foundation for the auditor.
Contract/API/schema 1.0.1 is read-only. Do not edit sibling repositories,
frontends, parent files, or shared contract snapshots.

## Task and review status

- Task status: in_progress (implementation/checkpoint complete; final commit and
  remote verification pending).
- Review status: pending.

## Ownership and baseline

- Exclusive write scope: this repository only.
- Baseline: `7ce573408d0bec51b7c08900052431df9cd8ed66` (F2-B), clean and equal
  to `origin/main` after fetch at task start.
- No applicable `AGENTS.md` was found in this repository or parent workspace.
- Existing F2-B outcome preserved; `GET /api/v1/health` remains unchanged.

## Checkpoint — 2026-09-24

- Added exact dependency pins `better-sqlite3@13.0.3` and
  `@types/better-sqlite3@7.6.13`; driver declares Node `>=22` and was exercised
  with Node 24.21.0 on this Windows workspace.
- Added SQLite v1 schema and automatic startup migration, configurable path,
  5000 ms default busy timeout, WAL for file databases and MEMORY for `:memory:`.
- Added atomic dataset persistence, dataset-scoped metadata/readings/policies,
  export identity deduplication with semantic fingerprint conflict detection,
  tariff settings, and typed job/finding/forecast/comparison insertion APIs.
- Added focused temporary-database test. Migration repeat, empty startup,
  reference import/counts/0.03 kWh, atomic rollback, cross-dataset IDs, foreign
  key rejection, duplicate/conflict handling, tariff independence and reopen
  persistence passed.
- Updated README/setup command and ignored DB/WAL/SHM files. No development DB
  was written; test DBs are removed by the test.
- Pending: run full contract/schema/typecheck/lint/test/build set, inspect
  diff/status, commit and push without force, then verify remote branch hash.

## Exact next action

Finish all listed checks and evidence docs, commit task-owned changes, push
`main`, verify `origin/main` equals the pushed commit, and report results.
