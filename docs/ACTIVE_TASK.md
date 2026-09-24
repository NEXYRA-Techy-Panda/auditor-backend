# ACTIVE_TASK — auditor-backend

## P028-BACKEND — evidence-backed report economics API (2026-09-25)

- Owner: Mohan | Agent M-B — Codex. Implementation and local verification are
  complete; review pending. Added the read-only `POST /api/v1/reports/preview`
  against persisted completed vacancy findings and the current saved INR
  tariff, using the prepared pure economics module. No migration or frontend
  edit. Evidence and frontend response contract:
  [P028 backend evidence](P028_BACKEND_REPORT_API_EVIDENCE.md) and
  [API examples](AUDITOR_API_EXAMPLES.md).
- Main had no uncommitted work. Prepared branch `mohan/p028-report-math-prep`
  was integrated by a normal merge while retaining main's P026-R1 evidence,
  script fixes and detector-failure regression; prepared worktree remains.
- Feature/merge commit: `c5db138d437280c77ae90c488ac067f8720b446e`; it was
  pushed as the `origin/main` head. Documentation closeout commit
  `b5aff642ca21ae294bee0733de8716a28daf7000` was also pushed; `git ls-remote`
  observed that remote hash afterward. These are Git publication observations;
  deployment was not checked.
- Main SQLite loaded in-memory successfully (SQLite 3.53.4). Scratch SQLite and
  loopback HTTP route checks passed; `npm test` 59/59; typecheck, lint, build,
  and `git diff --check` passed. No production database/request or service
  restart. Git publication is complete; deployment was not checked.
- Exact next action: M-A integrates preview forms/sections in the separate
  frontend assignment; then verify print output. Matched-scenario comparison
  stays separate pending persisted external-input provenance.

## Preserved previous assignment / Layer ID

**P026-R1 — deployment recovery and detector integration verification**
(follow-up to assignment 25 / approximately 29; approximately four further
feature batches remain; this follow-up does not mark them complete). Owner:
**Mohan**. Agent: **M-D — FreeBuff**. Exclusive write scope: `auditor-backend`.
Task status: **completed** (diagnosis + verification + harness fix + docs);
review status: **pending**. Public API was healthy and 502 was not reproduced;
cause unknown and not attributed to P026; no VPS/deploy action taken. See
[P026_R1 evidence](P026_R1_DEPLOYMENT_RECOVERY_EVIDENCE.md). The P026 outcome
below is preserved unchanged.

## Previous assignment / Layer ID (completed, preserved)

P026 — device analysis integration (P022 excess consumption + P024 gradual
trend). Owner: **Mohan**. Agent: **M-D — FreeBuff**. Exclusive write scope:
`auditor-backend`.

## Ownership transfer (recorded)

- Previous owner: **Mohan's Codex agent** (P026 was assigned; no completion
  report was supplied).
- Current owner: **Mohan | M-D — FreeBuff**. The assignment ID remains P026.
- Starting state: `main` at `f3b8e2c8dac923957d91e1a55591abc7e03fe67c`
  (reported deployed baseline), equal to `origin/main`, clean tree. **No P026
  work existed to resume** — no checkpoint, evidence, route, migration or
  uncommitted edit in the repository. Nothing was rebuilt or discarded.
- No other Mohan agent edited this repository during the assignment.

## Scope

1. Node integration for `POST /v1/anomalies` (`excess-power-mad-v1`) and
   `POST /v1/drift` (`gradual-power-trend-v1`) at committed Python `a0a86cc`.
2. Public persisted jobs and results for the auditor frontend, reusing the
   existing queue/jobs/findings machinery.
3. Preserve imports, vacancy analysis, forecasting and analytics unchanged.

## Task status (P026)

completed (implementation + tests + real integration + documentation)

## Review status (P026 and P026-R1)

pending (never self-assigned)

## Completed work

1. `src/analysis/aggregate.ts` — deterministic window-anchored aggregation that
   emits only contiguous, non-partial, fully-on, single-policy bins with room
   context and counts every excluded bin by reason.
2. `src/analysis/detectors.ts` — per-device section planning (finest fitting
   contract resolution, native pass-through when the stored resolution fits),
   fixed reference baseline across evaluation batches, bounded sections,
   drift never split, policy-scope precheck, merged coverage/warnings/exclusions
   and honest overall status.
3. `src/analysis/client.ts` — `anomalies()` / `drift()` with envelope, identity,
   window, device and finding-shape validation; bounded bodies.
4. `src/analysis/jobs.ts` — `detector` selection on `POST /api/v1/analysis/jobs`
   with window validation; detector dispatch, progress batches, result and
   finding persistence via the existing columns (no migration).
5. `src/routes/analysis.ts` — detector result presentation (no tariff-derived
   cost) and the new `GET /api/v1/detectors` catalogue.
6. Tests `test/detectors.test.ts` (8 new; 36/36 total) and the real integration
   check `scripts/check-detector-http.mjs` (`npm run check:detector-http`).
7. `.gitattributes` LF rules for the hashed contract paths (was missing).
8. Documentation: `P026_DEVICE_ANALYSIS_INTEGRATION_EVIDENCE.md`,
   `AUDITOR_API_EXAMPLES.md`, `HANDOFF.md`, `README.md`, this file and
   `PROGRESS_LOG.md`.

## Previous task outcome (preserved)

- **P023 (A5-backend historical energy analytics, Codex): completed, review
  pending.** `/rooms`, `/devices`, `/timeseries`, `/weekday-analytics` with
  coverage/provenance/pagination; evidence
  `P023_HISTORICAL_ANALYTICS_EVIDENCE.md`; commits `d683578`, `dec0c16`.
- **P020 (forecast integration, Codex): completed, review pending.**
- P026 must not change P023/P020/P015 behaviour; their regression tests pass
  unchanged in this assignment (36/36 includes all previous suites).

## P026-R1 verification performed and actual results

- Public read-only (2026-09-25 02:10 +0530 and 2026-09-24 20:44:43Z): health
  **200** with `ml_reachable:true`, `/api/v1/detectors` **200** (P026 catalogue),
  imports **200**, `/auditor` **301**, CORS preflight for
  `https://enersave-coral.vercel.app` **204**. **502 was not reproduced.**
- `npm test`: **37 passed, 0 failed** (36 + 1 new failed-detector-job test).
- `verify:contract` **75/75**; `validate:schema` **24/24**; typecheck/lint/build
  clean; `check:detector-http` pass; `check:analysis-http` **now passes**
  (Windows tar fix).
- No application source, route, migration, contract or config changed, so no new
  application release was required.

## P026 verification performed and actual results (preserved)

- `npm test`: **36 passed, 0 failed** (28 pre-existing + 8 new).
- `npm run verify:contract`: **75/75**; `npm run validate:schema`: **24/24**.
- `npm run typecheck` / `npm run lint` (0 errors) / `npm run build`: clean.
- `npm run check:detector-http`: pass against pinned Python `a0a86cc` on an
  isolated ephemeral loopback port with a scratch database (7 detector
  requests, both detector paths, max 1,440 records per section).

## Incomplete edits and uncommitted changes

None outstanding once the committed task work is pushed. Browser-witnessed
frontend checks remain pending (not part of this assignment).

## Blockers or unknowns

- Frontend adapter work for the new detector statuses is a separate assignment
  (unchanged by P026-R1; the copyable handoff is in the P026-R1 evidence).
- Detector accuracy evidence in Python remains synthetic; the numbers recorded
  here are structural integration results.
- P026-R1 resolved the pre-existing Windows harness failure:
  `scripts/check-analysis-http.mjs` now uses `git archive --format=tar` with a
  relative extraction path and passes.
- Root cause of the earlier public 502 remains **unknown** (not reproduced).
  Server-side log/revision confirmation requires scoped VPS access, which was
  not exercised; the exact read-only commands are listed in the P026-R1
  evidence §7.

## Exact next action

Frontend integration (separate assignment): consume `GET /api/v1/detectors` for
detector selection, then `POST /api/v1/analysis/jobs` with
`detector` + `reference_window`/`evaluation_window`, and render `result.status`,
`result.devices[].status`/`reason`/`assessment_source`,
`result.aggregation.excluded_device_bins`, warnings and (drift)
`other_changes` — never as malfunctions, efficiency loss or savings. The
copyable handoff (exact catalogue response, POST bodies, GET nesting, pagination,
status vocabulary, error codes) is in
[P026_R1 evidence](P026_R1_DEPLOYMENT_RECOVERY_EVIDENCE.md) §4. Stop after
P026-R1 on the backend side; review remains pending.

## Related-repository dependencies

- energy-ml-service `a0a86cc5d96b16082d8a1d1b911de7a7d1b2474d`
  (P022 `b17e54b`, P024 `208417e`) — read-only; not modified.
- Contract 1.0.1 mirrored, read-only; `verify:contract` remains 75/75.
- Unchanged repositories: auditor-frontend, simulation-frontend,
  simulation-backend and the parent folder.

## Deployment constraints (reference)

- Public auditor base `https://git-pipeline.metatronhost.in/auditor`; Nginx
  strips `/auditor` before `/api/v1/...`. Fixed local listener
  `127.0.0.1:19002` (`PORT` ignored); private Python `127.0.0.1:19003`.
- Production database
  `/home/mohan/.config/htop/mohan/HACKATHON/auditor-backend/data/auditor.sqlite`
  — never used for tests; no migration changes; no Nginx/PM2/webhook edits.
- A push may trigger deployment; the push result and any observed deployment
  outcome are recorded in the P026 return report only if actually observed.
