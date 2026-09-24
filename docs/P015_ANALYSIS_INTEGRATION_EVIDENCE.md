# P015 F4/M2 — auditor-to-Python analysis evidence

Date: 2026-09-24. Agent C — Codex. Owner: Mohan. Review pending.

## Scope and starting point

- Only `auditor-backend` is modified. No contract files or sibling repositories
  were edited. Starting auditor HEAD was the expected
  `67998d56ec03bf25525f0dc1bf2394c7ae2558bf`, clean on `main` and equal to
  `origin/main`.
- Python source was read from commit
  `36f5832f298379c3a889a32673c409152aa8eaf0` (P010). The Python repository's
  working tree and environment were not modified. The real check exported only
  committed `app/` files into an OS temporary directory and used its already
  installed interpreter/environment; the temporary copy was removed afterward.
- P006 import behavior remains covered by regression tests and the real import
  HTTP check. P006 history remains in `PROGRESS_LOG.md`.

## Public routes and behavior

- `POST /api/v1/analysis/jobs` accepts `{ "dataset_id": "..." }`; optional
  `from_utc` and `to_utc` select a contained, interval-aligned range. It
  returns `202` with `{ "data": { "job_id", "status": "queued" }, "meta": ... }`.
- `GET /api/v1/analysis/jobs/:id` returns queued/running progress or a
  completed/failed terminal state. Completed results are persisted, including
  method/version, requested range, actual coverage, warnings, exclusions,
  energy totals and findings. `page` / `page_size` paginate findings.
- A forward-only SQLite migration v2 adds job execution/result columns and
  indexes. Existing v1 migration text was not changed. Findings are inserted
  transactionally with job completion. A later failed job does not overwrite
  an earlier successful job.
- One worker runs at a time, with at most four waiting jobs. Restart marks all
  queued/running jobs failed as `JOB_INTERRUPTED`; none stays stuck as running.
- To bound result growth, one job is capped at 100,000 merged findings. A job
  that exceeds this fails `INSUFFICIENT_DATA` with a range-narrowing message;
  no partial findings are presented as a complete result.
- Merged warnings and evidence intervals per finding are each capped at
  100,000 as well. Python request batches are bounded; total persisted result
  size still scales with the number of devices and findings.
- The public terminal success status is `completed`, matching the existing
  persisted status vocabulary and this assignment's lifecycle wording. The
  generic contract job paragraph uses `succeeded`; this is documented as an
  additive status clarification, not a contract-file change.

Frontend examples covering import 201/200, identity conflict 409, validation
details, listing pagination, summary/gaps/provenance, tariff and analysis job
responses are in [AUDITOR_API_EXAMPLES.md](AUDITOR_API_EXAMPLES.md).

## Python client and batch ownership

- The client uses configured `ML_SERVICE_URL`; `ML_TIMEOUT_MS` defaults to
  10,000 ms. It validates the success/error envelope, request ID, required
  rule response fields, dataset/run/window identity, record counts and an
  8 MiB bounded response body. Refusal, timeout, malformed response and valid
  upstream errors become safe persisted job failures without stack traces.
- Production health probes Python `/health` with the same timeout. It reports
  reachability only after that probe; `model_available:false` still runs the
  rule analysis. Python remains `method: "rule"`, `model_used:false`.
- The worker uses existing imported SQLite readings and sends one relevant
  device, its room, and only policies referenced by that batch. Each request
  stays below 2,000 device and 2,000 room intervals. The code owns up to 1,000
  device intervals per batch and includes up to 3,600 seconds plus one source
  interval of preceding context. If that context cannot fit the Python record
  bounds, the job fails `INSUFFICIENT_DATA`; no rows are silently dropped.
- Owned intervals are disjoint. Context rows are supplied only to establish
  vacancy/grace and excluded from returned evidence/totals. Results merge from
  P010's interval-level `evidence.intervals`, not `finding_id`; per-interval
  supported energy follows P010's exact whole-interval or full-on
  constant-power cases. Unknown partial energy remains unknown. Missing room
  rows break continuity. Coverage is returned with counts and `complete`.
- Synthetic source/label is copied from the imported dataset. Dataset energy
  (`SUM(device_intervals.energy_kwh)`) stays separate from estimated avoidable
  energy. The client does not send tariff to Python. Results apply the current
  tariff at read time; a tariff edit does not trigger another analysis call.

## Real HTTP integration

Command: `npm run check:analysis-http` (also runs build).

- The check starts committed P010 on an unused ephemeral loopback port, using
  an isolated `git archive` source copy and existing compatible Python
  interpreter. It starts the actual auditor Express app on another ephemeral
  loopback port with a scratch SQLite database. All uploads/jobs/results use
  HTTP `fetch`; this is not mocked integration.
- Python `/health` returned `status: ok`, `model_available:false`; auditor
  health returned `ml_reachable:true` after probing it.
- It uploaded `contracts/v1/fixtures/reference.json` via multipart: first
  import 201, job submit 202, job completed with exactly one `light-a`
  `vacant_but_on` finding, 0.01 kWh avoidable. `fridge-b` was excluded.
  Dataset energy was 0.03 kWh. Unset tariff stayed null; zero tariff returned
  numeric zero; ₹10/kWh returned ₹0.10 avoidable cost and ₹0.30 dataset cost.
  The Python request counter did not change after tariff updates.
- A generated 1,005-minute fixture crossed the 1,000-row batch boundary. It
  included 120-second grace and changed the light policy version at interval
  1,000 (grace 300 seconds). Runs partitioned at 1,000 and 317 owned intervals
  had identical findings, warnings, exclusions and coverage; the merged
  finding referenced both policy versions and estimated 10.02 kWh (asserted
  within `1e-9` kWh; raw binary float `10.01999999999983`).
- Deleting one room interval produced `coverage.complete:false`,
  `NO_ROOM_INTERVAL` and insufficient-context warnings, and split the findings
  into two periods. It did not bridge vacancy or count the unsupported period.
- Across these calls, observed maxima were 1,000 device intervals and 1,000
  room intervals; 22 real Python analysis requests were made. The owned
  auditor/Python processes and scratch DB/source copy were removed. Python runs
  with bytecode generation disabled and cleanup retries transient Windows file
  locks. Ports 4001 and 8000 were not used by this integration.

## Mocked failure and persistence checks

`npm test` includes mocked Python refusal, timeout, malformed envelope and
upstream 413 cases. Each becomes a persisted `failed` job with a safe reason;
no success result/findings are returned. Other focused checks cover:

- 202 queue response, completed result and finding pagination;
- job/result persistence after closing and reopening SQLite;
- both queued and running jobs become `JOB_INTERRUPTED` on startup recovery;
- model unavailable does not prevent the rule request;
- null tariff and configured zero tariff are distinct;
- tariff updates do not invoke Python or change stored energy/findings.

## Full verification

| Command/check | Result |
|---|---|
| `npm run verify:contract` | 75 passed, 0 failed |
| `npm run validate:schema` | 24 passed, 0 failed (Ajv Draft 2020-12 strict) |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 14 passed, 0 failed |
| `npm run build` | Passed |
| `npm run check:import-http` | Real auditor server/scratch DB; JSON 201, equivalent JSON and CSV 200 same ID; summary 0.03 kWh; ₹10 tariff → ₹0.30; temp DB removed |
| `npm run check:analysis-http` | Real HTTP integration above against committed P010 snapshot; passed |

No full-month import benchmark was repeated; this task did not modify the CSV
ingestion parser or persistence import path. P010 supports only its deterministic
vacant-beyond-grace rule; no drift detection, spike detection, forecast, or
trained-model analysis is claimed. At unusually fine source resolution, the
3,600-second room context itself can exceed Python's 2,000-row bound; that
scope fails clearly. Browser/frontend wiring and forecasting are remaining
separate work.

## Continuity and publication

Setup: `npm ci`; copy `.env.example` to `.env`; set `ML_SERVICE_URL` to the
private Python service origin and optionally `ML_TIMEOUT_MS`; `npm run db:migrate`
(server startup also migrates); then `npm run dev`. Run checks using the table
above. The real integration harness requires the existing
`energy-ml-service/.venv/Scripts/python.exe` on this Windows workspace and does
not install or update dependencies.

Feature implementation commit:
`49b61fc079246ace1914ff640b3f292bbf3f86ca` on `main`. No task-owned process
remains running. The continuity publication commit
`c270b2f89f88eac837044c76179f4631f21667a4` was pushed normally; remote
`refs/heads/main` matched local HEAD at verification. Review remains pending.
