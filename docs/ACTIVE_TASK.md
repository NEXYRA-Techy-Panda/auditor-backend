# ACTIVE_TASK — auditor-backend

## Layer

P006, Agent C — Codex, F5-A — Auditor file import and reference-data
integration. Owner: Mohan. Exclusive write scope: this repository.

## Objective

Implement the CSV/JSON multipart import flow, dataset listing/summary/tariff
routes, strict structural and semantic validation, deterministic semantic
fingerprints, and persistence using the existing `AuditorDatabase`.
Contract 1.0.1 under `contracts/v1/` is read-only.

## Status

- Task: in_progress.
- Review: pending.
- Expected accepted baseline: `aa53d0c190ec9295354d34cb432a810144c79345`.
- Startup: fetched `origin`; branch `main` was clean at expected baseline.
- No applicable AGENTS.md found; no sibling or parent files will be edited.

## Checkpoint — 2026-09-24

- Read P003 evidence, continuity docs, contract, CSV representation, API and
  database/app code.
- Design decision: uploads go to generated private OS temp directories with a
  512 MiB bound; CSV uses a streaming RFC 4180 parser, with a 900,000 CSV-row
  bound (above the 803,520-row 31-day, one-minute, 18-device target), and a
  maximum 8 MiB metadata envelope. Parsing emits normalized records directly;
  only bounded canonical arrays are retained for the existing store API.
- Implemented: multipart upload with cleanup, streamed CSV reconstruction and
  JSON structural+semantic validation; duplicate normalization and streamed
  SHA-256 fingerprint; import/list/summary/tariff routes; HTTP errors with
  field/row validation reports; generated temporary scale and live-server
  check scripts.
- Focused tests pass: 10/10, including JSON/BOM and CSV/CRLF uploads, cross
  format duplicate IDs, reordered fingerprint equivalence, conflict response,
  metadata/reference/timestamp/energy/fault-label negatives, limit 413,
  rollback/no writes, summary and tariff.
- Live server checks succeeded on port 4001 with temporary DB. The 31-day CSV
  comprised 133,304,273 bytes, 803,520 device rows and 223,200 room intervals;
  final-code import plus summary completed in 66 seconds. A mid-run Windows
  process sample observed 838,115,328 working-set bytes (not a peak measurement).
  Both owned server processes and temporary resources were stopped/removed.
- Final checks against the final code: contract 75/75; schema 24/24;
  typecheck/lint/build pass; tests 10/10; live HTTP and scale scripts pass.
- Next action: commit/push the reviewed auditor-backend files without force,
  verify `origin/main` equals local HEAD and confirm clean process/tree status.

## Exact next action

Commit the reviewed auditor-backend changes, push without force, verify remote
HEAD and clean process/tree status. Stop after P006.
