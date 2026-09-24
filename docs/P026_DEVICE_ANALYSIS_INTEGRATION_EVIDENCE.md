# P026 — Device analysis integration (excess consumption + gradual trend)

Assignment: **P026** — Node-backend integration for Python's P022
`POST /v1/anomalies` and P024 `POST /v1/drift`, with persisted public jobs and
results for the auditor frontend.

Progress: **Mohan assignment 25 / approximately 29 planned; approximately 4
further batches.** Owner: **Mohan**. Agent: **M-D — FreeBuff**.
Exclusive write scope: `auditor-backend` only.
Review status: **pending** (never self-assigned).

## 0. Ownership transfer and starting state

- P026 was previously assigned to Mohan's **Codex** agent; no completion report
  was supplied. Recorded transfer: previous owner *Mohan's Codex agent* →
  current owner *Mohan | M-D — FreeBuff*. The assignment ID remains P026.
- Starting state: `main` at
  `f3b8e2c8dac923957d91e1a55591abc7e03fe67c` (reported deployed baseline),
  equal to `origin/main`, **working tree clean**. There was **no P026 work to
  resume**: no P026 checkpoint, evidence file, route, migration or uncommitted
  edit existed (`grep -rIn -e P026 -e anomalies -e drift` found only the
  contract bundle and earlier P015 prose).
- No other Mohan agent was editing the repository during this assignment; the
  other four repositories and the parent folder were not modified.

## 1. Python interfaces used (committed source only)

| Item | Commit | Notes |
| --- | --- | --- |
| energy-ml-service HEAD used | `a0a86cc5d96b16082d8a1d1b911de7a7d1b2474d` | reported deployed Python |
| P022 `excess_consumption` | `b17e54be0f22c9f3441e08bd08400e7cbb138b4f` | ancestor of the above |
| P024 `gradual_trend` | `208417e7744f4483e5eaaf63bfcb59bf729c17ac` | ancestor of the above |

Both routes and both detector versions are present in the deployed commit, so
no Python change was required (`/v1/anomalies` → `excess-power-mad-v1`,
`/v1/drift` → `gradual-power-trend-v1`; request formats
`excess-power-request-v1` and `drift-request-v1`, which share one schema).
`model_available` stays `false`; neither detector needs a trained model, and
`false` never blocks them.

Request shape sent per device: `contract_version: "1.0.1"`, `dataset_id`,
`run_id`, one `rooms[]`, one `devices[]`, the referenced `policies[]` (plus
transitive `office_hours_ref` definitions), optional
`detector: { version }`, and an earlier `reference` plus a later `evaluation`
section, each `{ window, room_intervals, device_intervals }`.

## 2. Public routes

- `POST /api/v1/analysis/jobs` — **backward compatible**. Without `detector`
  (or with `detector: "vacancy"`) the existing vacancy request/behaviour is
  unchanged. With `detector: "excess_consumption" | "gradual_trend"` it accepts
  `reference_window` and `evaluation_window` (`{start_utc,end_utc}`, real UTC
  seconds, ordered, non-overlapping, inside the dataset export range, aligned
  to imported interval boundaries) and answers `202 { job_id, status, detector }`.
- `GET /api/v1/analysis/jobs/:id` — unchanged for vacancy. Detector jobs add a
  top-level `detector` identity block and return the persisted detector result
  with paginated findings (`?page=&page_size=`, max 500) plus `coverage`,
  `detector_coverage`, `devices`, `warnings`, `exclusions`, `aggregation` and
  (drift) `other_changes`. Detector results carry **no** tariff-derived cost.
- `GET /api/v1/detectors` — new catalogue: detector ids, Python method/version,
  technique, required request shape, section bounds, aggregation semantics and
  the status vocabulary.

Queue, bounded concurrency (4 queued/running), progress batches, failure
handling, `JOB_INTERRUPTED` recovery and the findings table are the existing
P015/P020 machinery: detector jobs reuse the `analysis_jobs` table
(`job_type='analysis'`, detector identity in `request_json`, `method='rule'`,
`method_version=<detector version>`), so **no migration was added** and applied
migrations were not edited. Findings are stored with the job-prefixed
`finding_id` exactly as P015 does.

## 3. Reference/evaluation selection, aggregation and batching

- Selection is per device from the auditor's own persisted readings. Reference
  must end at or before the evaluation starts, and neither window is moved
  silently.
- The **finest resolution that fits Python's 2,000 device and 2,000 room
  records per section** is chosen per device from the contract nominals
  (60/300/600/900/1800/3600 s, restricted to multiples of the dataset
  resolution). When the stored resolution fits, **the stored records are sent
  unchanged** (native pass-through — Python then applies all of its own
  comparability rules and reporting). Only when they do not fit is
  deterministic aggregation applied on a grid anchored at the section window
  start.
- Aggregation emits a coarser interval **only** when every stored record that
  composes it is present and contiguous, non-partial, the device was fully on
  (`on_fraction == 1`) for the whole bin, a single policy version applies, and
  the room context covering the same bin is present. `avg_power_w` is the
  duration-weighted mean, `energy_kwh` is recomputed as
  `avg_power_w × interval_seconds / 3 600 000` (Python's 1e-9 kWh consistency
  check and energy preservation), `on_fraction = 1`, `partial = false`, and
  duty/override seconds are summed. Mixed-duty, off, duty-unknown, partial,
  policy-change, missing-reading and missing-room-context bins are **excluded
  and counted by reason** under `aggregation.excluded_device_bins` — never
  zero-filled, divided by `on_fraction`, multiplied by `quantity`, or reported
  as evaluated with no findings.
- Room context is only ever submitted at a device interval start (Python looks
  context up by `(room_id, interval_start_utc)`), so context is never invented.
- Excess consumption: one fixed reference section per device, reused unchanged
  for every evaluation batch (Python never refits from evaluation data).
  Evaluation is split into ≤2,000-record batches when needed; each batch
  reports its own finding windows because Python groups contiguous flagged
  intervals per request.
- Gradual trend: one resolution, one configuration and one call. The
  evaluation section is **never split** (Python cannot stitch temporal
  support); if it cannot fit at the coarsest contract interval, the device is
  reported as not assessed with the reason and a recommendation to shorten the
  window.
- A referenced policy that is not device-scoped is a structural precheck
  failure: the device is reported as not assessed with that reason and no
  Python call is made.
- Reference baselines, thresholds, assumptions and method/version are stored
  and exposed as returned; detector results are excluded from vacancy
  avoidable-energy totals, and no power deviation or trend is priced as a
  saving.

## 4. Status vocabulary

`findings_detected`, `evaluated_no_deviation` (excess consumption),
`evaluated_no_gradual_trend` (trend), `insufficient_reference` /
`insufficient_history`, `unsupported_context`, `no_comparable_observations`,
and the auditor's own `unsupported_aggregation` (precheck/exclusion state that
is never reported as "evaluated"). Per-device entries carry
`assessment_source: "detector" | "auditor_precheck"` plus the detector's own
status, classification, reason, support and exclusion counters.

## 5. Verification actually performed

Automated (`npm test`, node:test via tsx, scratch/in-memory databases only):
**36/36 pass** (28 pre-existing + 8 new in `test/detectors.test.ts`).
New coverage: aggregation tiling and reason accounting; native pass-through at
the stored resolution; finest-fitting resolution selection; identical reference
section across evaluation batches; per-device findings cap overflow failing the
job; detector job persistence across a database reopen; findings pagination;
tariff change not rerunning Python and adding no cost; device-scope precheck;
drift trend vs step vs insufficient history vs stable; insufficient reference
distinct from no findings.

Other checks: `verify:contract` **75/75**, `validate:schema` **24/24**,
`typecheck`, `lint` (0 errors) and `build` all exit 0.

Real integration — `node scripts/check-detector-http.mjs` (pinned committed
Python `a0a86cc` exported with `git archive` into a temp directory, started with
the repository's existing interpreter on an **ephemeral loopback port**;
scratch SQLite database; no fixed port, deployment, PM2 or production database
touched):

- 7 detector requests, both `/v1/anomalies` and `/v1/drift`; largest section
  observed **1,440 device and 1,440 room records** (native pass-through case),
  all ≤ 2,000; every submitted interval asserted fully-on, non-partial and
  energy-consistent.
- Excess consumption, known device increase: `status: findings_detected`, one
  `excess_consumption_deviation`, observed **1000 W** vs reference median
  **600 W**, threshold **660 W**, `energy_above_baseline_kwh` **9.6**, flagged
  intervals **288**, aggregation resolution **300 s** (minute readings).
- Same dataset with unchanged evaluation power: `evaluated_no_deviation`, 0
  findings. Ten-minute reference: `insufficient_reference`, 0 findings.
- Gradual trend, linear 600 → 900 W ramp: `findings_detected`,
  `sustained_upward_power_trend`, **20 W/day**, **+50 %** over the period,
  reference level **600 W**, 8 reference days, 16 evaluation days.
- Flat data: `evaluated_no_gradual_trend`, 0 findings. Level step inside the
  evaluation: 0 findings with one `abrupt_level_change` observation in
  `other_changes`. Eight-day evaluation: `insufficient_history`, 0 findings.

## 6. Portability

`auditor-backend/.gitattributes` was **absent**; the two targeted rules
(`contracts/v1/** text eol=lf`, `scripts/verify-contract.mjs text eol=lf`) were
added, matching the K002 rules already committed in the simulator
repositories. No verifier change, no manifest/contract content change and no
global Git configuration change; `verify:contract` remains 75/75.

## 7. Limitations and remaining work

- Python's own detector accuracy is synthetic-fixture based; the numbers above
  are structural integration results, **not** real-building accuracy.
- A split evaluation can report one finding per batch; findings are not merged
  across requests.
- Cycling devices may have few or no fully-on comparable bins at any fitting
  resolution; they are reported as not assessed (`unsupported_aggregation`) or
  by Python as `no_comparable_observations` / `insufficient_*`, never as
  evaluated-no-findings.
- Per-section bounds mean long windows need coarser requested intervals or
  fewer devices; the API returns the reason and recommends a shorter window.
- Browser-witnessed checks (hourly/daily charts, exclusions tables, narrow
  screens, keyboard flow) remain **unverified**; `unsupported_aggregation` and
  detector statuses are new for the frontend adapter.
- Pre-existing, unrelated: `scripts/check-analysis-http.mjs` (P015) fails on
  this Windows checkout because it pipes a `git archive --format=zip` through
  GNU `tar` (`tar: This does not look like a tar archive`). It was **not
  modified**; the new P026 check uses `--format=tar` with a relative path.
- No deployment was triggered or observed by this assignment's own commands;
  the push outcome (if any) is recorded in the return report only if observed.

## 8. Files changed (task-owned)

- Created: `src/analysis/aggregate.ts`, `src/analysis/detectors.ts`,
  `test/detectors.test.ts`, `scripts/check-detector-http.mjs`,
  `docs/P026_DEVICE_ANALYSIS_INTEGRATION_EVIDENCE.md`, `.gitattributes`.
- Updated: `src/analysis/client.ts`, `src/analysis/batches.ts` (exported
  interval mappers + shared client accessor), `src/analysis/jobs.ts`,
  `src/routes/analysis.ts`, `package.json`, `README.md`, `docs/HANDOFF.md`,
  `docs/ACTIVE_TASK.md`, `docs/PROGRESS_LOG.md`, `docs/AUDITOR_API_EXAMPLES.md`.
- Unchanged: `contracts/**` (content), `scripts/verify-contract.mjs`,
  migrations 001–003, `data/`, environment files.
