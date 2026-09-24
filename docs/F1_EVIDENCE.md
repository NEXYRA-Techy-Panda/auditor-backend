# F1_EVIDENCE — auditor-backend (contract mirror)

Written before commit; final commit hashes are returned in the F1 evidence
report, not invented here.

## F1 status

Contract v1.0.0 authored and verified 2026-09-24. Task completed, review pending.
This repo holds a byte-identical mirror; canonical copy:
`simulation-backend/contracts/v1/`.

## Python verification (agent-run, current terminal)

- `Python 3.13.15` (64-bit) at the supplied interpreter path; pip `26.2.1`,
  SQLite `3.50.4`, venv OK. PATH shims stale; PATH untouched.
- User-verified + agent-verified; dependency compatibility is F2. Auditor Node
  work proceeds independently; Python is needed only for F4 integration checks.

## Contract artifacts (mirrored; full hashes in manifest)

CONTRACT.md (`a10dc136…`), dataset.schema.json (`dd4feedd…`),
CSV_COLUMNS.md (`4e217d7b…`), API.md (`49e54a7d…`),
fixtures/reference.json (`14dec040…`) + reference.csv (`f7f6883a…`) +
expected.json (`522fb8dc…`), manifest.json, scripts/verify-contract.mjs
(`c6f10494…`), .gitignore.

## Verification commands and actual results

- `node scripts/verify-contract.mjs` (built-ins only) in all five repo roots:
  **49 passed, 0 failed in each**. Hand totals 0.02/0.01/0.03 kWh, Rs 0.30,
  reconciliation, uniqueness, policy refs, hashes, CSV/JSON parity (1e-9),
  fault-label scan. Semantic checks only; formal schema validation is F2.
- No scaffolding, installs, migrations, training, servers, or deployment.

## Shapes and decisions (summary)

JSON envelope: `schema_version, source, synthetic, building, run, export,
rooms[], devices[], policies[], room_intervals[], device_intervals[]`.
CSV: UTF-8, exact 28-column header (asserted by script), one row per device
interval, `meta_run`/`meta_policy` the only JSON columns, aligned-grid
coverage, no total rows. Half-open UTC intervals; missing ≠ zero;
policy versions immutable; tolerance 1e-6 kWh; tariff never alters identity;
`dataset_id` (auditor) distinct from `run_id` (simulator).

## Checks not performed

Formal schema-validator run; runtime integration; Python installs. F2+.

## Mirror consistency

Hash step passes in this repo against the canonical manifest. Version entry +
coordinated updates required for later changes.

## Commit / push

Authorised by F1 ("docs: establish foundation and v1 data contracts").
Recorded in the F1 evidence report with verified remote hashes.
