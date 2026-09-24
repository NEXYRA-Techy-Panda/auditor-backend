# P003 F3-A — Auditor SQLite foundation evidence

Date: 2026-09-24. Agent C — Codex. Owner: Mohan. Status: implementation
complete; review pending.

## Scope and baseline

Work was restricted to `auditor-backend`. No applicable `AGENTS.md` was found
in the repository or workspace parent. The repository was clean on `main` at
F2-B commit `7ce573408d0bec51b7c08900052431df9cd8ed66`, equal to
`origin/main` after `git fetch origin`. Contract 1.0.1 and its verifier were
left unchanged. Neither simulator nor frontend repositories were edited.

## Driver and connection

- `better-sqlite3` **13.0.3**, exact runtime dependency; package engine is
  Node `>=22`. Exact type package: `@types/better-sqlite3` **7.6.13**.
- Selected for Node 24 compatibility and its maintained native SQLite API;
  the driver opened successfully on installed Node `v24.21.0` with SQLite
  `3.53.4`. It is suitable for eventual Linux Node VPS use; Linux deployment
  itself was not exercised in this Windows workspace.
- `DATABASE_PATH` defaults to `./data/auditor.sqlite`; relative paths resolve
  from the service working directory. Set `DATABASE_PATH=:memory:` for an
  in-memory database. `DATABASE_BUSY_TIMEOUT_MS` defaults to 5000 (allowed
  0–60000).
- Foreign keys are enabled per connection. Local file DBs use WAL; in-memory
  DBs use MEMORY. `AuditorDatabase.close()` is idempotent. Migration failures
  close the opened connection. The server closes its database after HTTP
  shutdown.
- Database files and `-wal`/`-shm` sidecars are ignored. No development DB was
  written.

## Schema and data decisions

Migration version 1 creates:

- `datasets` (auditor dataset ID, source/format/resolution, timezone,
  synthetic provenance, building metadata, original simulator run/export
  identity, supplied semantic fingerprint and optional source file hash);
- dataset-scoped `buildings`, `rooms`, `devices`, `policy_versions`,
  `room_intervals` and `device_intervals`, with composite foreign keys and
  unique keys;
- `user_tariff_settings`, `analysis_jobs`, `findings`, `forecast_records`,
  `comparison_records`, and `migration_history`.

Dataset import and every metadata/policy/interval insert run in one SQLite
transaction. No simulator rooms/devices are seeded. `dataset_id` is distinct
from the source run/export IDs. Room and device IDs are only unique within a
dataset. Device interval FKs ensure the selected device belongs to the
referenced room in that dataset; policy FKs resolve the exact ID/version.

Logical export identity is `(source, simulator_run_id, export_id)`. On repeat,
the future importer supplies its validated semantic fingerprint:

- same identity + same fingerprint returns the existing auditor dataset ID,
  without inserting rows;
- same identity + different fingerprint throws a conflict;
- optional file SHA-256 is stored as provenance, never used to decide semantic
  equivalence. CSV/JSON canonicalization is intentionally not implemented.

Tariffs are independent user settings. Updating one does not touch readings or
dataset identity. Forecast rows store `energy_kwh` separately from optional
tariff rate, currency and cost fields. Comparison rows retain both dataset
IDs; no date-only scenario matching or analysis claim is performed.

## Setup and migration

```sh
npm ci
npm run db:migrate
npm run dev
```

`npm run db:migrate` opens the configured database, applies pending versioned
migrations and prints migration history. Server startup also migrates before
serving requests. There is no reset command or destructive automatic reset.
Overrides can be set in `.env` (ignored by Git) or the environment:

```text
DATABASE_PATH=./data/auditor.sqlite
DATABASE_BUSY_TIMEOUT_MS=5000
```

## Verification

| Check | Result |
|---|---|
| `npm run verify:contract` | 75 passed, 0 failed; contract snapshot untouched |
| `npm run validate:schema` | 24 passed, 0 failed (Ajv 8.20.0, Draft 2020-12 strict) |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 8 passed, 0 failed |
| `npm run build` | Passed |
| migration CLI | Passed with `DATABASE_PATH=:memory:`; version 1 recorded |

The temporary-DB persistence test exercised fresh/repeated migration,
zero-dataset initial state, reference fixture storage through
`storeDataset()`, counts (2 rooms, 2 devices, 3 policies, 4 room intervals,
4 device intervals), and 0.03 kWh sum. It also checked rollback after an
intentional FK failure, same room/device IDs across isolated datasets,
invalid-FK rejection, exact repeat suppression, semantic conflict rejection,
tariff update independence and data persistence after close/reopen. Temporary
DB resources are removed by the test.

The existing health test continues to assert the health payload. No HTTP
process was started for this assignment; `ml_reachable` remains
`not_checked`.

## Limits and next consumer

There is no production CSV/JSON importer, upload route, fingerprinting or
canonicalization pipeline, analysis/model logic, forecast generation, report,
or Python call. `storeDataset()` accepts an already validated structured
dataset plus a supplied validated semantic fingerprint. The next import task
can use this method to persist validated metadata and intervals atomically,
then use typed job/finding/forecast/comparison methods. Ensure the importer
computes fingerprints from semantic content, not file bytes alone.

## Repository and remote status

At evidence authoring time, implementation checks were green. Commit/push,
final clean working tree and remote branch hash verification remain pending
and will be recorded in the task handoff after publication.
