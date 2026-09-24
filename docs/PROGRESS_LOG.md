# PROGRESS_LOG — auditor-backend

Append-only. Newest entry at the bottom. Correct outdated facts with a dated
correction entry; do not rewrite history.

---

## 2026-09-24 — F0 (reconstructed)

- Layer ID: F0 (repository setup and mapping).
- Developer/agent: F0 implementation agent (prior session). Reconstructed
  2026-09-24 during F0.1 from F0 docs and the supplied F0 report — commands
  below are **reported**, not re-run by the F0.1 agent.
- Objective: clone five repos, verify origins/branches, record tooling/ports,
  create shared context + handoffs + prompts + READMEs. No implementation.
- Changes: cloned `auditor-backend` from
  `https://github.com/NEXYRA-Techy-Panda/auditor-backend.git` into
  `../auditor-backend` (`main`, no commits). Created untracked `README.md`,
  `docs/PROJECT_CONTEXT.md`, `docs/WORKSPACE_MAP.md`, `docs/HANDOFF.md`,
  `docs/AGENT_START_PROMPT.md`. Same pattern in siblings.
- Decisions/reasons: five independent repos; npm for JS/TS; proposed ports
  (this repo 4001; Python service 8000); Node `>=20.9` / Python `3.12`
  provisional until F2.
- Commands/checks (as reported): clone/verify/fetch/ls-remote (empty),
  version checks (Node v24.21.0, npm 11.19.0, Git 2.55.0.windows.5; Python
  unavailable), netstat (ports free). Parent not a Git repo.
- Unresolved at F0 close: Python missing; Node pin undecided; docs uncommitted;
  F1 pending.
- Next action (as closed): return F0 evidence; await review.
- Review status and evidence source: **Accepted by architecture lead based on
  supplied evidence; local files were not directly inspected by the lead.**
- Commit references: none.

---

## 2026-09-24 17:47:57 +05:30 (IST) — F0.1 (actual)

- Layer ID: F0.1 (durable agent continuity, docs only).
- Developer/agent: F0.1 implementation agent (this session).
- Objective: continuity files + onboarding protocol.
- Changes (this repo): created `docs/ACTIVE_TASK.md`; this `docs/PROGRESS_LOG.md`;
  pending: `HANDOFF.md`, `AGENT_START_PROMPT.md`, `README.md` updates + final
  ACTIVE_TASK update.
- Decisions/reasons: verify-then-edit; preserve F0 docs; per-repo identity
  (owner Mohan; auditor Node work independent of Python until F4 integration).
- Commands/checks and actual results: AGENTS.md absent; `main`; correct origin;
  `status --short` → `?? README.md`, `?? docs/`; `log` → no commits; file
  listing matches F0 report.
- Unresolved items: remaining F0.1 edits; review pending; no commits (by design).
- Next action: update HANDOFF/START_PROMPT/README; mark ACTIVE_TASK completed;
  readiness check; return F0.1 evidence. Do not begin F1.
- Review status and evidence source: pending; this file set + F0.1 report
  (working tree inspected directly).
- Commit references: none.

---

## 2026-09-24 17:51:10 +05:30 (IST) — F0.1 completion checkpoint (actual)

- Layer ID: F0.1. Task status: completed. Review status: pending (never
  self-assigned).
- Changes since the 17:47 entry: HANDOFF.md §0 set to completed; README links
  added; ACTIVE_TASK.md marked completed with full record; verification suite
  run (branch/origin/status/log per repo, 35-path link check, no-artifact scan,
  secret scan — all clean).
- Uncommitted changes: all F0 + F0.1 docs remain untracked by design; no commits.
- Next action: Return F0.1 evidence for architecture review; do not begin F1
  until its prompt is supplied.
- Commit references: none.

---

## 2026-09-24 18:02:31 +05:30 (IST) — F1 started (actual)

- Layer ID: F1 (versioned shared data + interface contract, design only).
- Developer/agent: F1 implementation agent (this session).
- Objective: define contract v1.0.0 (canonical in simulation-backend,
  mirrored to siblings) with fixtures + dependency-free verification; no
  application code.
- F0.1 outcome preserved above (completed; review pending at F0.1 close).
  F0/F0.1 review: accepted by architecture lead based on supplied evidence;
  local files were not directly inspected by the lead.
- Startup state: no AGENTS.md; all repos on `main`, correct origins, no
  commits, only untracked F0/F0.1 docs; fetch OK. Matches report.
- Owner updates applied/planned: Python 3.13.15 verified at supplied
  interpreter path (PATH shim stale, not modified); F0.1 "read-only" wording
  to be corrected; commit+push authorised from F1; hosting plan recorded
  (frontends Vercel, backends+Python on Mohan's VPS; no deployment in F1).
- Blockers/unknowns: no git user.name/user.email configured and no `gh` —
  commit/push will be attempted at completion; if auth fails, hashes and the
  exact remediation will be reported, nothing invented.
- Next action: author canonical contract bundle in
  `simulation-backend/contracts/v1/` + `scripts/verify-contract.mjs`.
- Review status: pending. Commit references: none yet.

---

## 2026-09-24 18:40:00 +05:30 (IST) — F1 contract authored + verified (actual)

- Changes: contract mirror received under `contracts/v1/` (+
  `scripts/verify-contract.mjs`, `.gitignore`); canonical copy lives in
  `simulation-backend/contracts/v1/`.
- Verification: `node scripts/verify-contract.mjs` → 49 passed, 0 failed in
  all five repos. Semantic checks only; formal schema validation is F2.
- Next action: continuity doc updates, then commit + push per repo.
- Review status: pending. Commit references: none yet.

---

## 2026-09-24 18:29:39 +05:30 (IST) — F1 commit/push blocked (actual)

- Contract work complete and verified (49/49 in all five repos); mirror +
  continuity docs + evidence files done.
- Commit blocked: no git user.name/user.email (commit in simulation-backend
  failed with exit 128, "Author identity unknown"). Asked Mohan twice; no
  values supplied, nothing configured, nothing invented. No commits exist;
  no push attempted (push auth untested). This repo remains fully untracked.
- To unblock: configure identity, then per repo `git add`, `git commit -m
  "docs: establish foundation and v1 data contracts"`, `git push -u origin
  main`, verifying each remote hash. No force-push.
- Task status set to blocked (commit/push step only); review pending.

---

## 2026-09-24 18:37:52 +05:30 (IST) — F1-R1 started (actual)

- Layer ID: F1-R1 (targeted pre-acceptance corrections, mirror repo). F1
  implementation completed; architecture review: changes_requested.
- Prior publishing resolved: F1 committed + pushed in all five repos.
- Objective: receive corrected mirrors (self-contained CSV; 12 dp precision +
  tolerances; extended verifier). Version stays 1.0.0. No F2.
- Startup: no AGENTS.md; clean tree at F1 commit; repo-local identity set.
- Next action: corrections authored in `simulation-backend`, then mirrored here.
- Review status: pending.

---

## 2026-09-24 19:07:48 +05:30 (IST) — F1-R2 completed (actual)

- Corrected 1.0.1 mirror received and verified 75/75 (all five repos).
- Continuity updated: ACTIVE_TASK completed, HANDOFF F1-R2 addendum,
  F1_EVIDENCE F1-R2 section. Review pending; no approval claimed.
- Next action: commit, push `main`, verify remote hash; return F1-R2 evidence.
  Do not begin F2.
- Commit references: F1-R1 pushed; F1-R2 recorded after push. Commit references: F1 pushed (see ACTIVE_TASK).

---

## 2026-09-24 18:43:07 +05:30 (IST) — F1-R1 completed (actual)

- Corrected mirror received and verified 54/54 (all five repos).
- Continuity updated: ACTIVE_TASK completed, HANDOFF F1-R1 addendum,
  F1_EVIDENCE F1-R1 section. Review pending; no approval claimed.
- Next action: commit, push `main`, verify remote hash; return F1-R1 evidence.
  Do not begin F2.
- Commit references: F1 pushed; F1-R1 recorded after push.

---

## 2026-09-24 19:01:33 +05:30 (IST) — F1-R2 started (actual)

- Layer ID: F1-R2 (mirror repo). F1-R1 completed; review changes_requested
  after direct inspection (CSV accepted, 54/54 confirmed).
- Objective: receive corrected 1.0.1 mirrors. No F2.
- Startup: no AGENTS.md; clean tree; fetch clean; repo-local identity present.
- Next action: corrections authored in `simulation-backend`, mirrored here.
- Review status: pending.

---

## 2026-09-24 19:20:00 +05:30 (IST) — F2-B started (actual)

- Layer ID: F2-B (backend application foundations), Agent B, developer Mohan.
- Previous outcome preserved: F1-R2 completed + pushed at `8e3086546c65bbac05a2c31c4623e5ee1d0ac292`;
  accepted by the architecture lead based on supplied evidence. Contract
  1.0.1 is the implementation baseline and is read-only during F2-B.
- Startup: no AGENTS.md; clean tree; origin in sync; verifier 75/75.
- Ownership: Agent B owns the three backend repos only; Agent A owns the
  frontends concurrently.
- Next action: scaffold, install, verify, document, commit + push.
- Review status: pending.

---

## 2026-09-24 19:35:36 +05:30 (IST) — F2-B checkpoint (actual)

- Node backends scaffolded; verify:contract 75/75, validate:schema 24/24
  (Ajv 8.20.0, Draft 2020-12 strict), typecheck/lint/test/build exit 0.
- energy-ml-service .venv created (Python 3.13.15); pinned requirements;
  pip check clean; pytest 8 passed; fresh-venv repro install freeze identical.
- Environment incident: pandas import initially failed —
  "DLL load failed while importing parsing: An Application Control policy has
  blocked this file" (Windows Smart App Control). Mohan changed the Windows
  setting; re-test: numpy/scipy/scikit-learn/pandas import OK,
  scripts/check_env.py exit 0. No workaround in code.
- Next action: live HTTP checks on 4000/4001/8000, docs, commit + push.

---

## 2026-09-24 19:39:10 +05:30 (IST) — F2-B completed (actual)

- Layer ID: F2-B. Task status: implementation completed; review pending
  (never self-assigned).
- Results: verify:contract 75/75; validate:schema 24/24 (Ajv 8.20.0, 2020-12 strict); typecheck/lint/build exit 0; test 7/7; live GET http://localhost:4001/api/v1/health → 200 ok + ml_reachable not_checked; 404/400 envelopes live.
- Live processes started by Agent B were stopped; none left running.
- Contract unchanged; ambiguities reported in docs/F2_B_EVIDENCE.md
  (CONTRACT.md §1 still says schema_version "1.0.0"; INTERNAL_ERROR code;
  Python envelope; model/info uninitialised shape).
- Deliberately not implemented: DB, simulation, uploads, interservice calls,
  training, deployment.
- Next action: commit + push, verify remote; next layer F3 pending its prompt.
- Commit references: F2-B hash recorded in the F2-B return report.

---

# 2026-09-24 — P003 F3-A checkpoint

- Assignment: Agent C — Codex, Auditor SQLite foundation; owner Mohan.
- Startup: no applicable AGENTS.md; `main` at F2-B
  `7ce573408d0bec51b7c08900052431df9cd8ed66`, clean and equal to origin after
  fetch. No other repository was edited.
- Implemented: pinned `better-sqlite3` 13.0.3 and types 7.6.13; SQLite v1
  migration, connection config/lifecycle, typed dataset import/tariff/jobs/
  findings/forecast/comparison persistence; temporary persistence tests; setup
  command and documentation. Full details in `P003_F3_A_EVIDENCE.md`.
- Semantics: dataset ID is auditor-owned; simulator run/export IDs remain
  separate; scope-key FKs isolate inventories; export identity is
  `(source, run_id, export_id)` and semantic fingerprint controls idempotency
  vs conflict. Tariffs never modify dataset/readings; forecast energy and
  tariff-derived cost occupy separate fields.
- Checks: contract 75/75; schema 24/24; typecheck, lint, build passed; tests
  8/8; migration CLI succeeded on `:memory:`. Focused test verified clean
  startup/repeat migration, 0.03 kWh reference import, rollback, same IDs in
  separate datasets, foreign-key enforcement, repeat/conflict identity,
  tariff independence and close/reopen persistence.
- No development DB or runtime process was created. Commit
  `571078274730811392ddbd53990d6eb17b0cde09` was pushed without force;
  `origin/main` verified to the same hash. Working tree clean after push.
- Task complete; review pending. Stop after P003.

---

# 2026-09-24 — P006 F5-A checkpoint

- Assignment: Agent C — Codex; auditor import/reference-data routes. Baseline
  `aa53d0c190ec9295354d34cb432a810144c79345`; clean `main` after fetch.
  Writes remain limited to auditor-backend; contract bundle unchanged.
- Added pinned `multer@2.4.0`, `csv-parse@7.0.2`, and
  `@types/multer@2.2.0`. Implemented private temp-file multipart handling,
  streamed standalone CSV reconstruction, canonical JSON reads, schema and
  semantic validation, deduplication/fingerprinting, routes, DB summary/tariff
  queries, integration tests, and runnable HTTP/scale evidence scripts.
- Full checks: contract 75/75; formal schema 24/24; typecheck/lint/build pass;
  tests 10/10. First/duplicate/CSV-equivalent/tariff paths demonstrated against
  the actual server on port 4001 and a disposable SQLite file.
- Scale: final-code generated 31-day export, 133,304,273 bytes; 803,520 device
  intervals plus 223,200 room intervals; HTTP 201; 66 s; summary
  93.74400026784001 kWh. A mid-run sample was 838,115,328 working-set bytes,
  not asserted as peak. Task-owned processes and temporary files were removed.
- Next action: publish final continuity hash/status updates and verify remote
  `main` hash and clean tree/process status.

## 2026-09-24 — P006 F5-A final verification checkpoint

- Final-code verification rerun: `verify:contract` 75/75; `validate:schema`
  24/24; typecheck, lint and build passed; tests 10/10.
- `check:import-http`: first multipart JSON import HTTP 201; equivalent JSON
  and standalone CSV repeats HTTP 200 with the same dataset ID; summary
  0.03 kWh; tariff HTTP 200 at INR 10/kWh; cost INR 0.30.
- `check:import-scale`: generated 133,304,273-byte CSV, 803,520 device plus
  223,200 room intervals; HTTP 201 and 93.74400026784001 kWh summary in
  66 seconds. A mid-run server working-set sample was 838,115,328 bytes;
  sample only, not peak guarantee. Harness RSS after completion 196,096,000.
- Both scripts cleaned their temporary data and owned server processes. Port
  4001 has no listener; `git diff --check` passed. All changed files are in
  `auditor-backend`; contract and sibling repositories are unchanged.
- Next action: commit and push without force, verify remote hash and clean tree.

## 2026-09-24 — P006 F5-A implementation published

- Implementation commit `3154e78493a0b310d58dd1101b5ccc337e64b0fb` pushed to
  `origin/main` without force. `git ls-remote` matched local HEAD; working tree
  was clean, port 4001 had no listener, and task-owned temp resources were
  removed.
- Final continuity hash/status updates were then committed and pushed; final
  remote/local hash verification followed. Review pending; stop after P006.

## 2026-09-24 — P015 F4/M2 started (Agent C — Codex)

- Preserved completed P006 checkpoint above. Starting auditor HEAD was
  `67998d56ec03bf25525f0dc1bf2394c7ae2558bf`, clean `main`; no applicable
  `AGENTS.md` found.
- Read required continuity, P006 evidence, API contract and auditor code.
  Read-only committed Python source is P010
  `36f5832f298379c3a889a32673c409152aa8eaf0`; sibling working tree is clean.
- P010 limits each call to 2,000 device and 2,000 room intervals, runs rule
  analysis while model availability is false, and returns interval-level
  evidence. Next action: implement bounded analysis jobs/client/migrations and
  run isolated committed-service integration.

## 2026-09-24 — P015 F4/M2 completed and published (Agent C — Codex)

- Added validated Python client, real Python health probe, persisted queued /
  running / completed / failed analysis jobs, SQLite migration v2, result
  pagination, current-tariff cost calculations, restart recovery, and a
  single-worker queue with four waiting jobs maximum.
- Added non-overlapping per-device batching with 1,000 owned intervals plus
  required context, bounded request/response bodies, P010-evidence-based
  merging, explicit missing-history handling, and hard caps for findings,
  warnings, and evidence rows. No tariff or unsupported analysis was sent to
  Python.
- Published API examples and real/mocked evidence. Verification passed:
  contract 75/75, schema 24/24, typecheck, lint, 14/14 tests, build, import
  HTTP regression, and isolated real HTTP integration against P010 commit
  `36f5832f298379c3a889a32673c409152aa8eaf0`.
- Auditor implementation and final continuity records were pushed normally
  to `origin/main`; review pending. Exact commit hashes are recorded in the
  final evidence note.
- Exact next action: review pending; stop after P015.

## 2026-09-24 — P020 M3 started (Agent C — Codex)

- Starting auditor HEAD `32d88beabc7d0e1d1a3fb7d26ae74117b4cce6ca` was clean
  on `main`, equal to `origin/main`. No applicable `AGENTS.md` found.
- Read P006/P015 continuity and evidence, auditor APIs and SQLite/jobs/client,
  shared forecast contract, and committed P013 source/evidence at
  `7f71363aa9361e67a0cb2815b98aee79b0708cf9`. Python worktree is unchanged.
- P015 evidence audit confirmed reference/cost, partition/grace, context
  ownership, missing-room gap, policy change and restart checks. Added tests
  for exact 100,000 result caps and fail-closed overflow; pagination is
  separately verified as retrieval only. Details are in the P015 evidence
  addendum; no architectural approval is claimed.
- Started the P020 implementation in `auditor-backend` only. Next: finish
  focused forecast work, run pinned P013 HTTP against scratch SQLite, document
  actual results, run regressions, and publish normally.

## 2026-09-24 — P020 M3 implementation complete (Agent C — Codex)

- Extended the P015 single persisted job queue for forecast jobs; added SQLite
  migration v3, P013 forecast client, complete-hour history builder, forecast
  validation/persistence, API routes and frontend examples. Import/analysis
  APIs and shared contract files are unchanged.
- Exact per-device energy aggregation on Asia/Kolkata hours; gaps, overlaps and
  crossing-hour intervals are excluded and reported. The latest 2,160 slots
  are considered. Origin defaults from imported data end; actual office policy
  at origin is sent with no invented future weather or occupancy.
- P015 evidence gap is closed with explicit tests for the 100,000 finding,
  warning and per-finding evidence caps and `INSUFFICIENT_DATA` fail-closed
  behavior; response pagination is distinguished from computation/storage
  bounds. Full addendum in P015 evidence.
- Final checks: contract 75/75, schema 24/24, tests 27/27, typecheck, lint,
  build and import HTTP pass. P013 real HTTP check against
  `7f71363aa9361e67a0cb2815b98aee79b0708cf9`: 672 observed hours, full 720-point
  November, 10.8 kWh; ₹10 cost 108 within `1e-9`; insufficient-history case
  failed honestly. P013 reported `model_available:false`.
- Exact next action: frontend forecast submit/poll/result display in a separate task; review pending; stop after P020.

## 2026-09-24 — P020 M3 published

- Feature commit `a7129f23873df9481fea249021d6a2599bcfd37d` was pushed normally
  to `origin/main` (no force). Final continuity commit `169ae814cb4e8d09b49606aaa8523193aa7b4b53` was also pushed; the remote matched local `main`.
- No contract, parent, or simulator repository was changed. The P013 source was
  used from pinned commit `7f71363aa9361e67a0cb2815b98aee79b0708cf9`; the
  Python sibling had separate concurrent work, which was left untouched.
- Review remains pending. Exact next frontend action: implement forecast
  submit/poll/result display in `auditor-frontend`; stop after P020.

## 2026-09-24 — P023 A5-backend started (Agent C — Codex)

- Preserved P020 completed/published outcome above. Starting HEAD is
  `df1ecbd08369d71f88de9cf5f26e6d8fd44e8ebd`, clean on `main`; no applicable
  parent or repository `AGENTS.md` found.
- Current route audit: imports and summary exist, but documented room/device/
  timeseries/weekday routes are absent. Summary returns hard-coded `gaps: []`
  without assessment status. Shared contract specifies room/device/timeseries
  route names and 2,000 maximum page size; analytics routes can be additive.
- No siblings, contract files, or parent files will be modified. P020 forecast
  behavior remains read-only for this work.
- Next: design bounded paginated persisted-reading analytics, exact compatible
  bucket and coverage semantics, weekday route; then tests and live HTTP check.

## 2026-09-24 — P023 A5-backend implementation completed (Agent C — Codex)

- Added stable paginated room/device analytics, exact-bucket office/room/device
  timeseries, and Monday–Sunday local calendar analytics. Added current-tariff
  costs, distinct expected/covered duration, synthetic provenance, explicit
  missing/partial/complete states, and source-grid/bucket alignment validation.
- Summary preserves `gaps: []` for compatibility but now reports
  `gap_assessment.status=not_performed` and source metadata. No full dataset gap
  list is constructed. Shared contract unchanged.
- Actual HTTP test with scratch SQLite verifies reference office/light/fridge
  totals 0.03/0.02/0.01 kWh; same-time different-device sums; ?10 cost 0.30;
  zero vs unset; gaps/null; stable page-one/page-two; quantity independence;
  IST local midnight; partial first day; two Mondays vs one Tuesday complete-day
  means; unsupported alignment and crossing interval rejection. Synthetic
  source provenance observed in summary response.
- `npm run check:import-http`: 201 initial, equivalent JSON/CSV 200, 0.03 kWh,
  tariff 10 -> 0.30. `npm run check:analysis-http`: pass against P010, one
  reference finding, 0.01 kWh avoidable, 0.03 kWh imported, 0.30 cost;
  1000/317 partitions compared. `npm run check:forecast-http`: pass against
  P013, 672 history hours, 720 points, 10.8 kWh, cost 108 at tariff 10 and
  honest insufficient-history failure.
- Full checks: contract 75/75; schema 24/24; typecheck, lint, build pass;
  tests 28/28; diff check clean. P015 caps reconfirmed from existing evidence:
  100,000 findings, 100,000 warnings, 100,000 evidence rows per finding;
  exceeding caps fails the job, pagination max 500 is retrieval-only.
- Files: README, ACTIVE_TASK, AUDITOR_API_EXAMPLES, HANDOFF, PROGRESS_LOG,
  new P023 evidence, new analytics module/router, app mount, summary provenance
  and gap-assessment fields, new historical HTTP test. No DB migration or
  dependency change.
- No task-owned processes/temp directories remain; ports 4001 and 8000 are
  clear. Feature commit `d683578106e718a4e1a42f9a29ce796bcb2d2857` and
  continuity commit `dec0c164eace26051a010b4ff2aefe113a0e9650` were pushed
  normally; local and remote `main` matched, working tree clean. During task
  close, auditor-frontend showed concurrent modified continuity docs and
  untracked `app/lib/forecast.ts` plus `app/lib/__tests__/forecast.test.mjs`;
  they were preserved untouched. Other siblings and contract remain unchanged.
  Exact next action: OpenCode integrates the
  documented historical analytics into auditor-frontend; review pending, stop
  after P023.

---

## 2026-09-25 — P026 device analysis integration completed (Agent M-D — FreeBuff)

- Layer ID: P026 — Node integration for Python's P022 `POST /v1/anomalies`
  (`excess-power-mad-v1`) and P024 `POST /v1/drift`
  (`gradual-power-trend-v1`). Developer Mohan; agent **M-D — FreeBuff**;
  exclusive write scope `auditor-backend`. Progress: Mohan assignment 25 /
  approximately 29 planned; approximately 4 further batches.
- **Ownership transfer:** previously assigned to Mohan's Codex agent with no
  completion report. Starting HEAD `f3b8e2c8dac923957d91e1a55591abc7e03fe67c`
  (reported deployed baseline) == `origin/main`, clean tree, and **no P026 work
  existed to resume** (no P026 trace, route, migration or uncommitted edit).
  Nothing was rebuilt or discarded; other repositories and the parent were not
  touched and no other agent was editing this repository.
- Python interfaces read from committed source only: deployed
  `a0a86cc5d96b16082d8a1d1b911de7a7d1b2474d` already contains P022 `b17e54b`
  and P024 `208417e`, so no Python change was needed.
- Added `detector` selection to `POST /api/v1/analysis/jobs` (`vacancy` default
  unchanged; `excess_consumption` / `gradual_trend` with explicit, validated
  `reference_window` + `evaluation_window`), detector presentation plus a
  `detector` identity block on `GET /api/v1/analysis/jobs/:id`, and the new
  `GET /api/v1/detectors` catalogue. Queue, progress batches, failure mapping,
  `JOB_INTERRUPTED` recovery and the findings table are reused unchanged (no
  migration; `job_type='analysis'`, `method='rule'`,
  `method_version=<detector version>`).
- Section selection sends stored readings unchanged when they fit Python's
  2,000 device/2,000 room records per section and otherwise aggregates onto the
  finest fitting contract interval: contiguous, non-partial, fully-on,
  single-policy bins with room context only. Excluded bins are counted by
  reason under `aggregation.excluded_device_bins`; nothing is zero-filled,
  divided by `on_fraction`, multiplied by `quantity` or dropped silently. Room
  context is only sent at a device interval start.
- Excess consumption keeps one fixed reference section per device across
  evaluation batches and may split the evaluation; gradual trend never splits
  (Python cannot stitch support) and reports an oversized evaluation as not
  assessed with a reason. A non-device-scoped referenced policy is a precheck
  failure, so no invalid request is sent. `unsupported_aggregation` is the
  auditor's not-assessed state and is never treated as evaluated-no-findings.
  `model_available: false` blocks neither detector. Detector results are never
  priced, never added to vacancy avoidable-energy totals, and a tariff change
  never reruns a detector.
- Checks: `npm test` **36/36** (28 pre-existing + 8 new in
  `test/detectors.test.ts`), `verify:contract` **75/75**, `validate:schema`
  **24/24**, typecheck/lint/build 0. Real integration
  `npm run check:detector-http` (pinned `a0a86cc` exported with `git archive`
  into temp, existing interpreter, isolated ephemeral loopback port, scratch
  DB): excess consumption 1000 W vs 600 W median, threshold 660 W,
  `energy_above_baseline_kwh` 9.6, 288 flagged intervals, 300 s aggregation;
  `evaluated_no_deviation` and `insufficient_reference` cases; drift
  `sustained_upward_power_trend` +20 W/day (+50 %, 600 W reference level, 8
  reference / 16 evaluation days); `evaluated_no_gradual_trend`,
  `abrupt_level_change` as an observation, `insufficient_history`. Largest
  submitted section 1,440 records (native pass-through), 7 detector requests.
- `.gitattributes` was missing here; the two K002 LF rules were added for the
  hashed contract paths. No verifier/manifest/contract content change and no
  global Git configuration change (`verify:contract` stays 75/75).
- Files: created `src/analysis/aggregate.ts`, `src/analysis/detectors.ts`,
  `test/detectors.test.ts`, `scripts/check-detector-http.mjs`,
  `docs/P026_DEVICE_ANALYSIS_INTEGRATION_EVIDENCE.md`, `.gitattributes`;
  updated `src/analysis/client.ts`, `src/analysis/batches.ts`,
  `src/analysis/jobs.ts`, `src/routes/analysis.ts`, `package.json`, `README.md`,
  `docs/HANDOFF.md`, `docs/ACTIVE_TASK.md`, `docs/AUDITOR_API_EXAMPLES.md`,
  this log. No database, environment, build output or temporary file committed.
- Processes: the isolated Python instance and auditor server used by
  `check:detector-http` were stopped; no task-owned process or temp directory
  remains. Pre-existing and unmodified: `scripts/check-analysis-http.mjs` fails
  on this Windows checkout (zip through GNU tar).
- Review status: pending (no self-assigned approval). Deployment was not
  triggered manually; the push result and any observed deployment outcome are
  recorded in the P026 return report.
- Exact next action: frontend integration in `auditor-frontend` (separate
  assignment) — consume `GET /api/v1/detectors`, submit
  `detector` + `reference_window`/`evaluation_window`, and present status,
  per-device `assessment_source`/`reason`, excluded bins, warnings and drift
  `other_changes` without malfunctions, efficiency loss or savings claims.
  Stop after P026 on the backend side.

## 2026-09-25 — P026-R1 deployment recovery + detector verification (Agent M-D — FreeBuff)

- Assignment P026-R1: determine why the public auditor API returned HTTP 502
  after P026, restore service if within authorized scope, verify the deployed
  detector interface, and write a frontend handoff. **Follow-up to Mohan
  assignment 25 / approximately 29; approximately four further feature batches
  remain. This follow-up does not mark them complete.** Starting HEAD
  `d0fcd092fa39ca17a7efbcdaeffd4e43bd1c2eb1` (P026), clean tree, equal to
  `origin/main`. P026's completed outcome is preserved — no reset, no rebuild.
- **The 502 was not reproduced.** Read-only public checks:
  `GET /auditor/api/v1/health` **200** (`ml_reachable:true`) and
  `GET /auditor/api/v1/detectors` **200** (full three-detector P026 catalogue)
  at 2026-09-25 02:10:01 and 02:10:19 +0530, and again at 2026-09-24
  20:44:43Z (health 0.20 s, detectors 0.17 s). `/auditor/api/v1/imports?page=1&page_size=1`
  **200**; `/auditor` **301** (prefix redirect, not a failure). CORS preflight
  `OPTIONS /auditor/api/v1/analysis/jobs` with
  `Origin: https://enersave-coral.vercel.app` returned **204** with
  `Access-Control-Allow-Origin`/`-Methods`/`-Headers` as documented. A single
  earlier probe in the preceding layer had returned 502; the cause is
  **unknown and not reproduced**, no causal link to P026 was established, and
  **no restart, redeploy, Nginx, PM2 or VPS action was taken** (a healthy
  service must not be restarted). No browser verification is claimed.
- **Deployed revision actually observed:** the deployed service serves
  `GET /api/v1/detectors`, a route that only exists in P026 code, so the P026
  revision is **deployed**, not merely pushed. The exact deployed Git hash
  cannot be read from the public API; the minimal read-only VPS commands
  (`pm2 status`, bounded `pm2 logs`, `ss -ltnp | grep 19002`,
  `git rev-parse HEAD`, `git status --short`) are recorded in the evidence §7.
  VPS access was not exercised and was not needed for recovery.
- **Changes (no application source touched):**
  `test/detectors.test.ts` — new regression test that a failed detector job
  retains its `detector.id`, surfaces `PYTHON_UNAVAILABLE`, leaks no
  stack/Traceback, persists zero findings and survives a DB reopen;
  `scripts/check-detector-http.mjs` — added vacancy default-when-omitted,
  window-validation rejections (`reference_after_evaluation` → 422
  `field: reference_window`; unaligned → 422 matching `/align/`),
  not-assessed (`unsupported_aggregation`, `assessment_source:
  auditor_precheck`, 0 findings) distinct from evaluated-no-findings, and
  no-invented-savings/cost assertions;
  `scripts/check-analysis-http.mjs` — Windows portability fix only
  (`git archive --format=tar -o <file>` plus relative extraction path with
  `cwd`, replacing the zip-through-GNU-tar path that failed with
  `tar: Cannot connect to C: resolve failed`). Requested regression check was
  not blocked; the specific harness was fixed without unrelated refactoring.
- **Checks:** `npm test` **37/37** (36 + 1 new), `verify:contract` **75/75**,
  `validate:schema` **24/24**, typecheck/lint/build 0, `check:detector-http`
  **pass** (pinned Python `a0a86cc`, 7 detector requests, both paths, max 1,440
  device/1,440 room records per section), `check:analysis-http` **pass**
  (previously failing on this Windows checkout). Contract manifest independently
  re-checked: 0 hash mismatches, 0 CRLF.
- Docs: created `docs/P026_R1_DEPLOYMENT_RECOVERY_EVIDENCE.md` (including the
  copyable frontend handoff: exact catalogue response, exact POST bodies for
  vacancy/excess_consumption/gradual_trend, exact GET job-result nesting,
  `result.findings_pagination` location and meaning, overall/per-device status
  and `assessment_source`, exclusions/warnings/`other_changes`, error codes and
  limitations); updated `docs/ACTIVE_TASK.md`, `docs/HANDOFF.md`,
  `docs/AUDITOR_API_EXAMPLES.md`, this log.
- Since no application source, route, migration, contract or configuration
  changed, **no new application release was required or produced**; a push does
  not prove a deployment, and no deployment was triggered manually.
- Processes: only ephemeral loopback Python/Node instances started by the
  harnesses (each cleaned up by the harness). No task-owned process remains; no
  foreign process was stopped; ports 19001–19003 (owned by another local
  process) were never touched; the production database was never written to.
- Review status: pending. Exact next action: frontend integration in
  `auditor-frontend` (separate assignment) using the P026-R1 evidence handoff.
  Stop after P026-R1.

## 2026-09-25 — P028-BACKEND report economics API

- Integrated the prepared `src/reporting/economics.ts` module and added
  `POST /api/v1/reports/preview`. The endpoint reads a consistent SQLite
  snapshot of persisted dataset metadata, completed vacancy job, selected
  finding rows, and current local tariff. It is read-only and adds no schema.
- Stable finding IDs are existing `finding_id` values from analysis results,
  resolved inside the requested job/dataset. The API
  rejects non-vacancy/unpriced evidence, incomplete or mismatched jobs,
  unknown rows, client energy/tariff/evidence/ownership overrides, invalid
  economics and more than 50 unique selected findings. Economics use the pure
  module, keep observed periods unchanged by default, label explicit user
  assumptions, preserve zero versus null, and disclose overlap exclusions.
  Scenario comparison remains unverified due to missing matched external
  input provenance.
- Main worktree started clean at `676e82c253563b376cd0c705d77bf7e5072847f4`.
  Normal merge integrated local branch `mohan/p028-report-math-prep` at
  `3c13fbb51a5ce3addc8964fa171cf634288c5838`; P026-R1 evidence, scripts and
  detector-failure test were kept from main while preparing docs were
  integrated. The prepared worktree remains preserved.
- SQLite check: installed main-worktree `better-sqlite3` opened `:memory:` and
  returned 3.53.4. Actual HTTP route with scratch DB: 0.01 kWh × ₹10 = ₹0.10;
  missing and zero tariff remain distinct; explicit assumptions calculate;
  overlap is not summed/ranked; invalid ownership, unsupported findings and
  caller overrides are rejected; preview does not change fixture readings or
  job count. Test fixture seeds the persisted completed job/finding directly;
  this tests HTTP plus real SQLite, not Python analysis execution.
- Checks: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`
  (59/59), focused `node_modules/.bin/tsx.cmd --test test/reports.test.ts`
  (3/3), and `git diff --check` passed. No production DB, preview request,
  service restart, external tool install, benchmark, or training.
- Evidence: `docs/P028_BACKEND_REPORT_API_EVIDENCE.md`; exact frontend response
  examples: `docs/AUDITOR_API_EXAMPLES.md`. Feature/merge commit
  `c5db138d437280c77ae90c488ac067f8720b446e` is local and `origin/main`
  (confirmed with `git ls-remote`). Git publication is confirmed; deployment
  was not checked and no preview was submitted to production. Review pending.
  Exact next action: M-A integrates this API in the separate frontend task;
  print verification and matched-scenario comparison remain follow-ups.
