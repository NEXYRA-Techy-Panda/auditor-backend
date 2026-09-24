# P020 M3 — auditor forecast integration evidence

Agent C — Codex. Owner: Mohan. Date: 2026-09-24. Review pending.
Exclusive write scope: `auditor-backend`.
Assignment record: `Agent C — Codex | P020 | M3`.

## Starting state and pinned services

- Auditor started clean at expected `main` HEAD
  `32d88beabc7d0e1d1a3fb7d26ae74117b4cce6ca`, equal to `origin/main`.
- The Python source used for real verification is committed P013
  `7f71363aa9361e67a0cb2815b98aee79b0708cf9`. The harness exports only its
  committed `app/` tree to an OS temporary directory and uses the compatible
  existing `energy-ml-service/.venv/Scripts/python.exe`. The sibling working
  tree and environment were not changed.
- No `contracts/v1/` or sibling repository files were edited. Database
  migration v3 is forward-only; migrations v1 and v2 are preserved.

## P015 correctness evidence addendum

The gap audit and direct test evidence are in
[P015_ANALYSIS_INTEGRATION_EVIDENCE.md](P015_ANALYSIS_INTEGRATION_EVIDENCE.md).
In brief: committed P010 HTTP returned one `light-a` finding at **0.01 kWh**
and excluded the always-on refrigerator; ₹10/kWh produced ₹0.10 avoidable and
₹0.30 dataset cost. The 1,005-minute comparison used nonzero 120-second and
300-second grace policies across a policy transition; batch sizes 1,000 and
317 produced identical results and **10.02 kWh** within `1e-9`, with evidence
owned only by interval start so context was not counted twice. Evidence named
both policy versions. Removing room history split the finding at the gap.
Restart tests cover queued/running work. Exact 100,000 finding, warning, and
per-finding evidence caps now have overflow-path tests; failures are
`INSUFFICIENT_DATA` with no partial success. Response pagination (maximum 500
per page) is retrieval-only and separate from those computation/storage caps.
This evidence addendum does not assert architectural approval.

## Public forecast workflow

- `POST /api/v1/forecasts` accepts `{dataset_id, horizon}` and optional
  additive `origin_utc`; it returns 202 with `forecast_id`/`job_id` and
  `status: queued`. The IDs are the same UUID. The work shares P015's one
  persisted queue/worker, not a second queue.
- `GET /api/v1/forecasts/:id` reports queued/running/completed/failed. Completed
  responses contain the contract forecast fields, all hourly points, totals,
  history coverage, warnings, limitations, policy and synthetic provenance.
  Failed responses preserve upstream error codes and safe messages. Example
  requests, pending response, completion response and polling notes are in
  [AUDITOR_API_EXAMPLES.md](AUDITOR_API_EXAMPLES.md).
- Migration v3 tags forecast jobs and extends the existing `forecast_records`
  with horizon/origin, method/baseline, timezone/provenance, points and full
  result JSON. Hourly energy and result persist transactionally with job
  completion and survive database reopen.
- Python uses `hourly-profile-median-v1`, method `statistical_baseline`,
  `model_version: null`; the baseline is accepted while
  `model_available: false`. P013 errors such as `INSUFFICIENT_DATA` stay job
  failures; no zeros are substituted.

## Exact hourly history, origin and calendar

- The auditor queries stored per-device `energy_kwh`, not displayed power or
  rounded UI values. Every local hour must have a complete, non-overlapping
  interval union for every expected device. Each row's energy is added once;
  device `quantity` is not a multiplier, and room metadata/energy is not read.
- Partial source intervals may contribute when their exact union covers the
  complete hour. Any interval crossing a local-hour boundary is omitted rather
  than prorated. Overlaps and missing-device coverage make the entire office
  hour incomplete. Such hours are omitted, never filled with zero. The result
  reports omitted-hour reasons, trailing incomplete hours and the gap from the
  last complete hour to origin; Python warnings are retained and auditor
  warnings add incomplete-hour/gap detail.
- The latest **2,160** Asia/Kolkata hour slots before the origin are considered.
  Default origin is the first local-hour boundary at/after the imported
  dataset's end, not today's date. Optional origin must be a real local-hour
  boundary at/after that dataset end. P013's minimum eligible observed history
  remains 168 / 336 / 672 hours respectively, plus profile support; Python
  enforces eligibility.
- Only `Asia/Kolkata` is supported. Calendar fields come from the
  `office_hours` policy for the imported building with the latest
  `effective_from_utc` not later than origin; a transition exactly at origin
  applies there. The selected policy and actual effective time are sent as
  `future_assumptions.schedule` and recorded. No weather or occupancy forecast
  is invented. P013 permits an optional environment `{avg_temp_c, avg_rh_pct}`
  and requires its model selector, when supplied, to name
  `hourly-profile-median-v1`; schedule/environment are recorded but do not
  influence the statistical profile.
- `next_calendar_month` preserves the full following local month. It is not a
  rolling 30-day horizon; the real check covered November 2026 local time,
  `[2026-10-31T18:30:00Z, 2026-11-30T18:30:00Z)` (720 hourly points).

## Energy, tariff and provenance

Forecasted hourly energy and total are persisted as returned after validation.
Tariff changes do not change those values or rerun Python. `GET` computes
`forecast_cost_inr` using the current rate: unset tariff returns `null`, zero
returns numeric zero. Cost is presented as forecast cost, never avoidable cost
or savings. The imported dataset's `synthetic` and `synthetic_label` are copied
additively; missing provenance is not inferred to mean measured data.

## Focused tests

`npm test`: **27 passed, 0 failed** at final verification. Forecast tests cover:

- Exact per-device hourly sums, no group quantity multiplication, missing
  device coverage, exact partial unions, crossing-hour rejection, overlaps,
  and the 2,160-slot retention bound.
- Historical origin defaulting independently of wall-clock date; policy
  effective time at origin wins over a numerically higher older version.
- All three horizons and complete next-month boundaries with deterministic
  synthetic data; Python response horizon/timestamp/order/unique-point,
  nonnegative finite energy, support and total consistency validation.
- Trailing incomplete history and gap reporting; real Python insufficient
  history; upstream service failure classification and message preservation.
- Unsupported timezone and invalid horizon are rejected before a job is queued.
- Job/forecast record persistence across SQLite reopen, current null/zero/
  positive tariff reads, tariff changes without a second Python call, and
  synthetic provenance.

Other passing commands: `npm run verify:contract` (**75/75**),
`npm run validate:schema` (**24/24**), `npm run typecheck`, `npm run lint`,
`npm run build`, and `npm run check:import-http` (first JSON upload 201,
equivalent JSON/CSV repeat 200, energy 0.03 kWh, ₹10 tariff cost ₹0.30).
No P006 full-month upload benchmark was rerun.

## Real P013 HTTP integration

Command: `npm run check:forecast-http` (runs build, then starts committed P013
and the actual auditor HTTP app on separately selected ephemeral loopback
ports with scratch SQLite). The harness imports its generated, labelled
synthetic 28-day hourly dataset through the auditor multipart HTTP route. It
also imports the short contract reference fixture for the insufficient-history
case. Only task-owned processes/files are cleaned up.

Actual result from P013 commit `7f71363aa9361e67a0cb2815b98aee79b0708cf9`:

- `/health` reported `model_available: false`; a 672-hour observed history
  completed `next_calendar_month` with **720 points**, full local November
  boundaries above, and **10.799999999999999 kWh** (the exact synthetic
  expected total is 10.8 kWh).
- The selected office-hours policy was version 2, effective exactly at origin;
  its real schedule was sent. The result retained `baseline_version:
  hourly-profile-median-v1`, `method: statistical_baseline`, `model_version:
  null`, and synthetic provenance.
- Unset tariff returned null cost. After setting ₹10/kWh the same persisted
  forecast returned **₹107.99999999999999** (108 within `1e-9`); Python request
  count stayed at 1.
- The two-minute reference dataset produced a persisted failed job with Python
  `INSUFFICIENT_DATA`: next calendar month needs at least 672 observed hours,
  got 0 complete hours. No forecast result was stored.
- Exactly two real Python forecast requests were made (one success, one
  insufficient-data). The P013 source archive, scratch database and owned
  service processes were cleaned up.

## Limitations and frontend handoff

This is P013's synthetic-profile baseline, not a trained model. It produces no
prediction interval and makes no building-specific accuracy claim; trends,
holidays, weather, occupancy and future schedule details do not influence the
profile. Only Asia/Kolkata is supported. Browser/UI wiring is a separate task.

Frontend implementation instructions: call `POST /api/v1/forecasts` after a
dataset is available; retain `forecast_id`; poll `GET /api/v1/forecasts/:id`
until terminal state; render failed codes/messages; label this as a statistical
baseline; display hourly kWh, horizon total, uncertainty unavailable, warnings,
limitations and synthetic provenance. Render `forecast_cost_inr` separately
from energy and refresh it from the same GET after tariff edits; never label it
as savings. Contract examples and the additive 202 polling clarification are
in [AUDITOR_API_EXAMPLES.md](AUDITOR_API_EXAMPLES.md).

Feature implementation commit `a7129f23873df9481fea249021d6a2599bcfd37d` was
pushed normally to `origin/main` without force. `git ls-remote` matched local
`main` at verification; the final continuity-only documentation commit is
recorded below after push. No task-owned process, temporary source copy or
scratch database remains. Ports 4001 and 8000 have no listener. Review remains
pending. Exact next frontend action: implement the above forecast
submit/poll/result display in `auditor-frontend` as a separate task.
