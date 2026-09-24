# HANDOFF — auditor-backend

## P026-R1 deployment-recovery addendum (2026-09-25; verification complete, review pending)

- **Assignment:** P026-R1, deployment recovery and detector integration
  verification. Follow-up to Mohan assignment 25 / approximately 29;
  approximately four further feature batches remain — this follow-up does not
  mark them complete. Exclusive write scope: `auditor-backend` only.
- **502 not reproduced.** Public read-only checks at 2026-09-25 02:10:01 /
  02:10:19 +0530 and 2026-09-24 20:44:43Z returned `GET
  /auditor/api/v1/health` **200** (`ml_reachable:true`) and `GET
  /auditor/api/v1/detectors` **200** with the full P026 catalogue; imports
  **200**; `/auditor` **301** (prefix redirect, not a failure). CORS preflight
  `OPTIONS /auditor/api/v1/analysis/jobs` for `https://enersave-coral.vercel.app`
  returned **204** with the expected allow-headers. A single earlier probe in
  the preceding layer had returned 502; the cause is **unknown and not
  reproduced**, no causal link to P026 was established, and **no restart,
  redeploy, Nginx, PM2 or VPS action was taken** (a healthy service must not be
  restarted).
- **Deployment actually observed:** the deployed service serves
  `GET /api/v1/detectors`, a P026-only route, so the **P026 revision is
  deployed**, not merely pushed. The exact deployed hash cannot be read from the
  public API; §7 of the P026-R1 evidence lists the minimal read-only VPS
  commands (`pm2 status`, `pm2 logs`, `ss -ltnp | grep 19002`, `git rev-parse`).
  VPS access was not exercised.
- **Changes:** `test/detectors.test.ts` gained a failed-detector-job identity
  regression test (failed job keeps `detector.id`, `PYTHON_UNAVAILABLE`, no
  stack leak, 0 persisted findings, survives reopen);
  `scripts/check-detector-http.mjs` gained vacancy-default, window-validation,
  not-assessed-vs-evaluated and no-invented-savings assertions;
  `scripts/check-analysis-http.mjs` got a **binary-safe Windows fix**
  (`git archive --format=tar -o <file>` + relative extraction path) and now
  passes. No application source, route, migration, contract or config changed —
  **no new application release was required.**
- **Checks:** `npm test` **37/37**, `verify:contract` **75/75**,
  `validate:schema` **24/24**, typecheck/lint/build 0, `check:detector-http`
  pass, `check:analysis-http` pass. Public vs local verification and the full
  frontend handoff (exact catalogue response, POST bodies for vacancy /
  excess_consumption / gradual_trend, GET job-result nesting, pagination,
  status vocabulary, `assessment_source`/exclusions/warnings/`other_changes`,
  error codes, limitations): [P026_R1 evidence](P026_R1_DEPLOYMENT_RECOVERY_EVIDENCE.md).
- **Not verified:** browser-witnessed detector UI, the exact deployed Git hash
  and historical log evidence of the earlier 502 (needs scoped VPS access).
  `auditor-frontend`, the separate reporting worktree, `energy-ml-service` and
  the simulator repos were left untouched.

## P026 device-detector addendum (2026-09-25; implemented, review pending)

- **Ownership transfer:** P026 was previously assigned to Mohan's **Codex**
  agent and no completion report was supplied. Current owner **Mohan | M-D —
  FreeBuff**; assignment ID unchanged. No P026 work existed to resume (clean
  tree at `f3b8e2c`, no P026 trace anywhere), so nothing was rebuilt or
  discarded. Exclusive write scope was `auditor-backend` only.
- Wires Python's additive detectors into the existing persisted job machinery:
  `POST /api/v1/analysis/jobs` accepts
  `detector: "excess_consumption"` (P022 `/v1/anomalies`,
  `excess-power-mad-v1`) or `detector: "gradual_trend"` (P024 `/v1/drift`,
  `gradual-power-trend-v1`) with explicit `reference_window` and
  `evaluation_window`; `"vacancy"` (or no `detector`) keeps the exact previous
  request/behaviour. New `GET /api/v1/detectors` catalogue; `GET
  /api/v1/analysis/jobs/:id` adds a `detector` identity block and returns the
  detector result with paginated findings, coverage, per-device statuses,
  warnings, exclusions, aggregation and (drift) `other_changes`.
- **No migration**: detector jobs reuse `analysis_jobs`/`findings`
  (`job_type='analysis'`, `method='rule'`, `method_version=<detector
  version>`). Queue bounds, progress batches, failure mapping,
  `JOB_INTERRUPTED` recovery and job-prefixed finding ids are P015/P020's.
- **Sections:** selected per device from persisted readings only. The finest
  contract resolution that fits Python's 2,000 device/2,000 room records per
  section is used; the stored resolution is sent **unchanged** when it fits,
  and deterministic aggregation (window-anchored bins, fully-on, contiguous,
  non-partial, single policy version, room context present) is applied only
  when it does not. Excluded bins are counted by reason under
  `aggregation.excluded_device_bins`; nothing is zero-filled, divided by
  `on_fraction`, multiplied by `quantity` or silently dropped. Room context is
  only sent at a device interval start.
- **Detectors:** excess consumption keeps one fixed reference section per
  device across evaluation batches (Python never refits from evaluation data)
  and may split the evaluation at the bound; gradual trend is never split,
  because Python cannot stitch temporal support — an oversized evaluation is
  reported as not assessed with a reason and a recommendation. A referenced
  policy that is not device-scoped is a precheck failure, so no invalid call is
  made. `unsupported_aggregation` is the auditor's own not-assessed state and is
  never presented as evaluated-no-findings; `model_available: false` does not
  block either detector.
- **Semantics:** detector findings/magnitudes are never priced (no cost field),
  never added to vacancy avoidable-energy totals, and a tariff change never
  reruns a detector. Thresholds, reference support, assumptions, method/version
  and suggested actions are stored and exposed as returned.
- **Verification:** `npm test` **36/36** (28 pre-existing + 8 new), contract
  **75/75**, schema **24/24**, typecheck/lint/build 0. Real integration
  `npm run check:detector-http` against pinned committed Python `a0a86cc`
  (isolated ephemeral loopback port, scratch DB): excess-consumption finding at
  1000 W vs 600 W median (threshold 660 W, 9.6 kWh above baseline, 288 flagged
  intervals) plus `evaluated_no_deviation` and `insufficient_reference`; drift
  trend +20 W/day (+50 %, 600 W reference level) plus
  `evaluated_no_gradual_trend`, `abrupt_level_change` as an observation and
  `insufficient_history`. Largest submitted section 1,440 records (native
  pass-through). Details: [P026 evidence](P026_DEVICE_ANALYSIS_INTEGRATION_EVIDENCE.md).
- `.gitattributes` was **missing** here; the two K002 LF rules were added
  (no verifier, manifest or contract content change; verifier stays 75/75).
- Not implemented / unverified: browser-witnessed detector UI, frontend adapter
  work for the new statuses, and any detector-result pricing (deliberately
  none). Pre-existing and untouched: `scripts/check-analysis-http.mjs` fails on
  this Windows checkout (zip through GNU tar); the new check uses `--format=tar`.

## P023 A5-backend addendum (2026-09-24; implemented, review pending)

- Adds persisted-reading endpoints `GET /api/v1/imports/:id/rooms`,
  `/devices`, `/timeseries`, and `/weekday-analytics`; request/response details
  and frontend examples are in `AUDITOR_API_EXAMPLES.md` and
  `P023_HISTORICAL_ANALYTICS_EVIDENCE.md`.
- Reads device interval energy only; office is device sum, room is its-device
  sum, and device quantity/cumulative counters/room interval metadata do not
  alter energy. Coverage counts distinct per-device interval unions. Missing
  buckets are null, partial buckets show known energy, overlaps/partial source
  intervals prevent a complete label, and energy is never prorated.
- Query windows are half-open, source-grid aligned, at most 366 days;
  supported buckets are 60, 300, 600, 900, 1800, 3600, and 86400 seconds if
  divisible by source resolution. Calendar analytics are Asia/Kolkata only;
  weekdays are calendar-only, not policy-derived workdays. Pagination is stable
  and capped at 2,000, with current-page and full filtered totals separate.
- Summary keeps legacy `gaps: []` but now labels assessment
  `not_performed` and exposes source metadata. Analytics include synthetic
  provenance. No dataset-wide gap list is generated.
- Focused scratch-DB actual HTTP evidence: office 0.03 kWh, light 0.02,
  refrigerator 0.01; ₹10 gives ₹0.30; zero vs unset is distinct. Missing
  interval, missing bucket, pagination, equal timestamps across devices,
  quantity, IST midnight/weekday, unequal complete-day counts/means and
  unsupported alignment/crossing intervals are covered.
- Checks passed: contract 75/75; schema 24/24; typecheck, lint, build;
  tests 28/28; import, analysis and forecast HTTP regressions. P015 findings
  and warning caps remain 100,000 each, evidence cap 100,000 per finding;
  cap overflow fails the job instead of publishing a partial result, while
  findings pagination is retrieval-only (max page size 500).
- Contract and sibling repos remain unchanged. Next frontend action: OpenCode
  integrates the documented office timeseries, room/device, and weekday routes
  with explicit provenance, coverage and page/full-period totals. Review is
  pending; stop after P023.
- Feature commit `d683578106e718a4e1a42f9a29ce796bcb2d2857` was pushed normally
  to `origin/main`; `git ls-remote` matched local HEAD at verification.
- Continuity commit `dec0c164eace26051a010b4ff2aefe113a0e9650` was published.
  During P023 close, `auditor-frontend` showed concurrent uncommitted changes:
  modified `docs/ACTIVE_TASK.md` and `docs/PROGRESS_LOG.md`, plus untracked
  `app/lib/forecast.ts` and `app/lib/__tests__/forecast.test.mjs`. These were
  not read or modified. Other sibling worktrees were clean at the earlier
  inspection; frontend state can continue to change independently.

## P020 M3 addendum (2026-09-24; implemented and published, review pending)

- Adds `POST /api/v1/forecasts` and `GET /api/v1/forecasts/:id`. The POST
  returns 202 with a forecast/job ID; the GET reports queued/running/completed/
  failed and completed contract forecast fields. This additive polling shape
  is documented in `AUDITOR_API_EXAMPLES.md`; import and analysis routes remain
  intact.
- Forecasts share the P015 persisted job queue and one worker. SQLite migration
  v3 adds the forecast job type and hourly result fields to the existing
  `forecast_records`; hourly predictions, totals, request assumptions, result,
  warnings, limitations, coverage, method and provenance persist.
- Reads only stored per-device `energy_kwh`; includes each office hour only
  when every expected device has complete, non-overlapping coverage. Exact
  partial-interval unions are usable; crossing-hour or overlapping intervals
  are omitted with reasons. No quantity multiplication, room-energy sum,
  prorating, or missing-hour zero fill.
- History is limited to the latest 2,160 local-hour slots. Default origin is
  the first Asia/Kolkata local-hour boundary at/after the dataset end. Calendar
  and real schedule assumptions come from the office-hours policy effective
  at origin; no future weather or occupancy is invented.
- P013 `hourly-profile-median-v1` runs while no trained model is available.
  Next-calendar-month boundaries remain the complete next local month. Python
  errors are retained as failed jobs; totals and points are validated before
  completion.
- Forecast energy is persisted independently of tariff. Current tariff cost
  is calculated on reads (`null` when unset, zero when rate zero); tariff edits
  never rerun Python. Synthetic provenance is copied when present.
- Full checks and pinned P013 HTTP integration passed. Feature commit
  `a7129f23873df9481fea249021d6a2599bcfd37d` is on `origin/main`. Exact next
  frontend action: implement forecast submit/poll/result UI in
  `auditor-frontend`; review pending, stop after P020.

## P015 F4/M2 addendum (2026-09-24; implemented and published, review pending)

- Adds `POST /api/v1/analysis/jobs` and `GET /api/v1/analysis/jobs/:id`.
  First response is 202 queued; status progresses queued → running → completed
  or failed. A forward SQLite migration adds persisted method/version, range,
  coverage, batch progress, result and safe failure fields. Findings persist
  and are paginated in the job status response.
- Auditor calls configured `ML_SERVICE_URL` server-side with bounded response
  size and `ML_TIMEOUT_MS`. `GET /api/v1/health` probes `/health`; reachability
  is not model availability. P010 `model_available:false` still supports
  `method: rule`, `model_used:false`.
- Batch ownership is non-overlapping by device interval. Each request contains
  one device, its room, referenced policies, no more than 2,000 records of
  either type, and up to 3,600 seconds plus one interval of prior context.
  Only P010 interval evidence inside the owned range contributes to merged
  findings/energy. If the required context cannot fit the limits, the job fails
  `INSUFFICIENT_DATA` without truncation. Missing room intervals break vacancy
  continuity; incomplete coverage is returned as `complete:false`.
- Analysis keeps imported consumption separate from avoidable energy. Current
  tariff-derived costs are applied when results are read; tariff edits do not
  rerun Python. Unfinished queued/running jobs are failed with
  `JOB_INTERRUPTED` at next startup. One worker runs at a time with four
  waiting jobs maximum.
- Jobs cap merged findings and warnings at 100,000 each, and evidence rows at
  100,000 per finding; exceeding a cap fails instead of returning partial
  results as complete. Request batches are bounded; total persisted result
  size still depends on the job's result counts.
- Real HTTP evidence uses only an extracted copy of committed Python P010
  `36f5832f298379c3a889a32673c409152aa8eaf0`; Python's working tree and
  environment were left unchanged. Reference result: one light finding,
  0.01 kWh avoidable, refrigerator excluded, 0.03 kWh imported consumption,
  ₹0.10 avoidable and ₹0.30 consumption cost at ₹10/kWh. Partition comparison
  (1000 vs 317 owned rows) matched; missing-room case broke continuity.
- Public examples for P006 import/summary/tariff and P015 jobs:
  [AUDITOR_API_EXAMPLES.md](AUDITOR_API_EXAMPLES.md). Full real/mocked results
  and limitations: [P015 evidence](P015_ANALYSIS_INTEGRATION_EVIDENCE.md).
- Remaining integration: auditor frontend/browser wiring is pending;
  forecasting remains explicitly deferred. P010 provides only its deterministic
  vacancy rule and warnings; no drift, spike, forecast or trained model result
  is claimed.
- Additive clarification: the contract's generic analysis-job text says
  `succeeded`; this backend persists/returns `completed`, matching its existing
  SQLite status vocabulary and P015 lifecycle wording.
- Feature implementation commit `49b61fc079246ace1914ff640b3f292bbf3f86ca`
  is published on `origin/main`. Final continuity commit and remote hash are
  recorded in the P015 evidence note; review is pending. Exact next action:
  review pending; stop after P015.

## P006 F5-A addendum (2026-09-24; implemented, review pending)

- Uses existing P003 `AuditorDatabase.storeDataset()` and the version 1.0.1
  contract without editing `contracts/v1/`. Adds `POST /api/v1/imports`,
  `GET /api/v1/imports`, `GET /api/v1/imports/:id/summary` and
  `PUT /api/v1/imports/:id/tariff`; health still reports
  `ml_reachable: not_checked`.
- First valid import: HTTP 201, `status: accepted`, `already_imported: false`.
  Equivalent export identity/fingerprint repeat: HTTP 200,
  `status: already_imported`, `already_imported: true`, same dataset ID.
  Conflicting semantic content for an existing export identity: HTTP 409
  `CONFLICT`. Invalid files use HTTP 400/422 with `details.errors` and first
  `field`/`row`; upload bounds return HTTP 413 `REQUEST_TOO_LARGE`.
- Upload bounds: default 512 MiB (`UPLOAD_MAX_BYTES`, configurable up to
  1 GiB), one file and no form fields, 900,000 CSV data rows, 1,100,000 JSON
  device intervals, 250,000 room intervals and 8 MiB metadata. CSV parsing is
  streamed with `csv-parse`; Multer writes to generated OS temp directories;
  temporary upload directories are cleaned on all handled success/failure
  paths. Uploaded names are never filesystem paths.
- Fingerprint is SHA-256 over streamed deterministic serialization of
  normalized validated data. It ignores top-level `source`, all run IDs,
  `export_id`, `export.created_utc`, `created_note`, transport format, byte
  formatting, object-key order and array order. It includes schema version,
  scenario/comparison, run start, export period/resolution, timezone, synthetic
  provenance, inventory, policies and deduplicated readings. User tariff and
  optional file hash are not fingerprint input.
- Verification: contract 75/75; formal schema 24/24; typecheck/lint/build all
  pass; test 10/10. Actual server on 4001 with temporary database verified JSON
  201, equivalent JSON and CSV repeats 200, listing, 0.03 kWh summary, tariff
  update to ₹10/kWh and ₹0.30 cost. Month-size CSV: 133,304,273 bytes,
  803,520 device records + 223,200 room intervals, imported in 66 s;
  summary was 93.74400026784001 kWh. One mid-run process working-set sample was
  838,115,328 bytes (~799 MiB); this is a sample, not a peak guarantee.
- Commands: `npm ci`; `npm run db:migrate`; `npm run dev`; full verification
  commands listed in `P006_F5_A_EVIDENCE.md`; live reference path
  `npm run check:import-http`; month-size path `npm run check:import-scale`
  (build first; requires free port 4001).
- No Python/model/anomaly/forecast/report/chart/frontend changes. Current next
  action after commit/push: provide this handoff to the next assigned task;
  import is the only new analysis-facing capability.
- Implementation commit `3154e78493a0b310d58dd1101b5ccc337e64b0fb` was pushed
  without force; remote hash matched local HEAD. Final continuity-document
  publication verification is recorded in the P006 evidence.

## P003 F3-A addendum (2026-09-24; implementation complete, review pending)

- Base: F2-B `7ce573408d0bec51b7c08900052431df9cd8ed66`; task-owned changes
  remain in this repository only. Shared contract 1.0.1 and verifier remain
  unchanged.
- Driver: exact `better-sqlite3` 13.0.3 runtime pin, Node engine `>=22`, plus
  exact `@types/better-sqlite3` 7.6.13. Selected as a maintained synchronous
  SQLite driver that runs on Node 24 and can be deployed with a Linux Node
  runtime. npm reports zero vulnerabilities at installation.
- DB path: `DATABASE_PATH` defaults to `./data/auditor.sqlite`; busy timeout
  defaults to 5000 ms (`DATABASE_BUSY_TIMEOUT_MS`, range 0–60000). File DBs
  use WAL; `:memory:` tests use MEMORY. Foreign keys are explicitly enabled.
- Schema v1 records datasets/provenance, dataset-scoped buildings/rooms/devices,
  policy versions, room/device intervals, tariff settings, analysis jobs,
  findings, forecasts and comparisons. `migration_history` tracks versions;
  no reset/drop migration is present. Dataset import is one transaction.
- Export identity is `(source, simulator_run_id, export_id)`. A supplied
  semantic fingerprint determines exact semantic re-import; equal fingerprint
  returns the existing auditor `dataset_id`, different fingerprint raises a
  conflict. File SHA-256 is retained only as provenance and is not used for
  equivalence. CSV/JSON normalization remains for the import layer.
- Verification: contract 75/75; schema 24/24; typecheck/lint/build passed;
  tests 8/8 (including temporary-DB persistence checks); standalone migration
  CLI succeeded with `DATABASE_PATH=:memory:`. `GET /api/v1/health` source is
  unchanged and still reports `ml_reachable: not_checked`. No service process
  or development DB was created by verification.
- Full command/results and remaining integration limits: see
  [P003_F3_A_EVIDENCE.md](P003_F3_A_EVIDENCE.md). Next task can use
  `AuditorDatabase.storeDataset()` with a validated semantic fingerprint and
  validated structured export. Do not infer fingerprint equivalence from the
  file hash.
- Commit/push: `571078274730811392ddbd53990d6eb17b0cde09` on `main`, pushed
  without force; `git ls-remote origin refs/heads/main` returned the same hash.
  Working tree was clean after push. No task-owned runtime process remains.

## 0. Continuity and current layer (F0.1, 2026-09-24)

- Current layer: **F2-B** (backend application scaffold) — status
  **completed**, review **pending** (F1-R2 accepted based on supplied evidence). Contract: **1.0.1 defined** (canonical
  `simulation-backend/contracts/v1/`, mirrored to siblings; replaces the
  unaccepted 1.0.0 prototype, no backward compatibility claimed).
- Continuity files: [ACTIVE_TASK.md](ACTIVE_TASK.md) and [PROGRESS_LOG.md](PROGRESS_LOG.md).
- Continuation procedure for a replacement agent: read `AGENTS.md` (absent at
  F0.1 — record if still absent), then `PROJECT_CONTEXT.md`, `WORKSPACE_MAP.md`,
  this `HANDOFF.md`, `ACTIVE_TASK.md`, and recent `PROGRESS_LOG.md` entries;
  inspect `git branch/status/log` and source; reconcile docs with code; resume
  the ACTIVE_TASK next action. Do not restart completed work. See
  [AGENT_START_PROMPT.md](AGENT_START_PROMPT.md) for the full protocol.
- Verified vs planned: **verified** = §2 state below (empty repo on `main`,
  no commits, docs-only untracked files, origins/ports/tooling as measured).
  Everything marked "Not implemented" or "planned" is **not** built. This repo
  has NOT completed application setup — F2 has not run.
- Layer clarifications: **F1 is contract work and does not require Python.**
  Python installation/runtime verification belongs to **F2 for
  energy-ml-service**. Auditor Node work (this repo) can proceed independently;
  Python is required only for the relevant auditor↔Python integration checks
  (F4). Runtime recommendations from F0 (Node `>=20.9`, Python `3.12`, npm,
  venv+pip) remain **provisional until checked against chosen dependency
  versions and official compatibility documentation during F2**.
- F0 review status: accepted by architecture lead based on supplied evidence;
  local files were not directly inspected by the lead.
- F1 addendum (2026-09-24, completed, review pending): contract v1.0.0 defined;
  this repo holds a byte-identical mirror under `contracts/v1/` (canonical:
  `simulation-backend/contracts/v1/`; see `contracts/v1/manifest.json`).
  `node scripts/verify-contract.mjs` → 49 passed, 0 failed in all five repos
  (semantic checks only; formal schema validation is F2). Links:
  [contract](contracts/v1/CONTRACT.md), [schema](contracts/v1/dataset.schema.json),
  [CSV](contracts/v1/CSV_COLUMNS.md), [API](contracts/v1/API.md),
  [evidence](F1_EVIDENCE.md), [active task](ACTIVE_TASK.md),
  [progress](PROGRESS_LOG.md).
- Dated corrections (history preserved in PROGRESS_LOG): Python 3.13.15
  verified — auditor Node work proceeds independently; Python needed only for
  F4 integration checks; F0.1 "read-only sibling" wording corrected — F0.1
  explicitly covered all five repositories; runtime recommendations stay
  provisional until F2; hosting plan — frontends on Vercel, Node backends +
  Python service on Mohan's VPS (no deployment in F1); from F1 onward
  completed layer work is committed and pushed (F0/F0.1 no-push was historical
  only).
- F1-R1 addendum (2026-09-24, completed, review pending): pre-acceptance
  corrections, version retained at 1.0.0 (not published). This repo holds the
  corrected mirror: self-contained envelope CSV, 12 dp precision + consistent
  tolerances, extended verifier (reconstruction parity + negatives + budget).
  54/54 in all five repos. Repo-local identity configured. History preserved.
- F1-R2 addendum (2026-09-24, completed, review pending): version 1.0.1
  (replaces unaccepted 1.0.0 prototype). This repo holds the corrected mirror:
  9dp power precision + fractional checks, V/I average semantics,
  kind-specific closed policy rules, persist-until-cleared overrides, concrete
  Python A/B requests with bounds, full API paths + scaffold health states.
  75/75 in all five repos; CSV-alone parity unchanged. History preserved.
- F2-B addendum (2026-09-24, implementation completed, review **pending**):
  F1-R2 (contract 1.0.1) was accepted by the architecture lead based on
  supplied evidence. Contract 1.0.1 is the baseline, and `contracts/v1` + the
  verifier were left unmodified (verifier 75/75).
  Full evidence: [F2_B_EVIDENCE.md](F2_B_EVIDENCE.md).
  Implemented: Express 5.2.1 + TypeScript 6.0.3 scaffold on Node 24.21.0
  (npm 11.19.0), same tooling as simulation-backend; exact pins +
  package-lock.json. createApp is separate from the listening entrypoint, with
  graceful shutdown. Env config, CORS for one origin, 100kb JSON limit,
  contract envelopes and error handling. ONLY `GET /api/v1/health` →
  `{"status":"ok","contract_version":"1.0.1","ml_reachable":"not_checked"}`
  inside `{data,meta}`; Python is not contacted (F4).
  Formal schema validation: `npm run validate:schema` (Ajv 8.20.0 Draft
  2020-12, strict) 24/24. typecheck/lint/build exit 0; tests 7/7; live check
  on http://localhost:4001 passed, and the process was stopped.
  Commands: `npm ci`, `npm run dev|build|start|typecheck|lint|test|verify:contract|validate:schema`.
  Env names: PORT (4001), HOST (127.0.0.1), FRONTEND_ORIGIN
  (http://localhost:3001), ML_SERVICE_URL (http://localhost:8000, origin
  only, not yet used), JSON_BODY_LIMIT (100kb), SHUTDOWN_TIMEOUT_MS (10000).
  Deliberately not implemented: DB/migrations, uploads/imports, analysis jobs,
  forecasts, comparisons, reports, auditor→Python calls. Next layer: **F3**,
  pending its assigned prompt.

## 1. Purpose and owner

- **Purpose**: Auditor API. Node.js + Express + TypeScript + SQLite service for
  CSV/JSON upload validation, preview, deduplication, persistence, office/room/
  device + weekday/schedule analytics, tariff handling (flat ₹/kWh), waste/
  anomaly findings, forecasts (via Python), original/improved comparison, and
  monthly-report data. Calls the private Python service server-side; serves the
  auditor frontend. Owns its own SQLite DB; never opens the simulator DB.
- **Owner (foundation + long-term)**: Mohan.

## 2. Current verified state (F0, 2026-09-24)

- Local path: `K:\NEXYRA\auditor-backend` (portable: `../auditor-backend`).
- Remote: `https://github.com/NEXYRA-Techy-Panda/auditor-backend.git`
  (verified; fetch OK).
- Branch: `main`. HEAD: **No commits yet**.
- Working tree before F0 docs: clean (only `.git/`).
- After F0 docs (uncommitted): new untracked `docs/PROJECT_CONTEXT.md`,
  `docs/WORKSPACE_MAP.md`, `docs/HANDOFF.md` (this file),
  `docs/AGENT_START_PROMPT.md`, `README.md`. Not committed/pushed.
- Parent is not a Git repository. No `AGENTS.md` found at F0.
- Tooling: Git `2.55.0.windows.5`, Node `v24.21.0`, npm `11.19.0`. Proposed
  port `4001` free at F0.
- Application state: **Not implemented** — no `package.json`, no source, no DB.

## 3. Completed layers and evidence

- **F0 (in review)**: cloned empty repo; verified origin/branch/HEAD/status;
  fetched; recorded tooling/ports; created docs. Evidence in F0 report.
- **F1–F6**: Not implemented.

## 4. Pre-existing implementation discovered during inspection

None. Empty repository; nothing to preserve.

## 5. Planned next layers

- **F1**: shared contract — import schema, dedup keys, analytics shapes,
  tariff/forecast/comparison semantics, auditor↔Python request/response shapes,
  UTC/Asia-Kolkata and kWh reconciliation rules.
- **F2**: Express + TypeScript scaffold via npm; health endpoint; Node pin.
- **F3**: private SQLite file (e.g. `./data/*.sqlite` — finalise in F3),
  migrations + seeds for imports/readings/findings.
- **F4**: CORS for `http://localhost:3001`; `ML_SERVICE_URL` (proposed,
  e.g. `http://localhost:8000`) health path to Python; upload → persist →
  analyse flow.
- **F5**: reference-data integration (rooms/devices/tariff defaults).
- **F6**: verified end-to-end (frontend upload → backend → Python → results →
  report).

## 6. Prerequisites

- Git, Node `>=20.9` + npm. SQLite driver (F2). Python service (sibling
  `../energy-ml-service`, port `8000`) required from F4 onward — Python
  `3.12` must be installed before then (missing at F0).

## 7. Actual run/check commands, if implemented

No app commands exist. F0 checks:

```powershell
git -C auditor-backend rev-parse --show-toplevel
git -C auditor-backend remote -v
git -C auditor-backend branch --show-current; git -C auditor-backend status -sb
git -C auditor-backend rev-parse HEAD   # unknown revision — no commits
git -C auditor-backend log --oneline -5 # no commits yet
git -C auditor-backend fetch --all
git -C auditor-backend ls-remote --heads origin  # empty
node --version; npm --version; git --version
netstat -ano | Select-String ':3000 |:3001 |:4000 |:4001 |:8000 '  # no matches
```

No migration/test commands — do not invent.

## 8. Configuration names without secret values

Proposed only (no `.env` at F0):

- `PORT` → `4001`; `FRONTEND_ORIGIN` → `http://localhost:3001`
- `ML_SERVICE_URL` / `ENERGY_ML_SERVICE_URL` → `http://localhost:8000`
- `DATABASE_URL` / `SQLITE_PATH` → private file in this repo (F3 finalises).
- No secrets or credentials.

## 9. Contracts and external dependencies

- **F1 contract**: Not implemented.
- **Planned**: serves auditor-frontend (HTTP); calls energy-ml-service (HTTP,
  server-side only). No simulator-DB access; no browser-DB access.
- **npm deps**: none yet.

## 10. Database/migration status

Not implemented. Separate SQLite DB owned privately (F3). No schema,
migrations, seeds, or files at F0.

## 11. Known issues and blockers

1. Empty remote — greenfield.
2. Python `3.12` not installed — blocks F4 Python wiring until resolved.
3. Node pin + SQLite driver/file location undecided until F2/F3.
4. F0 docs uncommitted — pending review.

## 12. Deferred features

Per shared context: live mode, advanced tariffs, sensor/BMS, pricing, doodle
occupants. No live simulator connection in MVP1 (file upload only).

## 13. Last verification date and relevant existing commit references

- Date: 2026-09-24. No commits. F0 docs untracked, pending review.

## 14. Instructions to update this document after every completed layer

After each layer, update date, branch/HEAD, §§2–3/7–11 with actual files,
commands and results; preserve history; keep §§1/12/14 unless scope formally
changes. Return updated sections as evidence.
