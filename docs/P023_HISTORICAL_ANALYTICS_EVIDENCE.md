# P023 A5-backend — historical energy analytics evidence

Status: implementation completed, review pending. Owner: Agent C — Codex.
Scope: `auditor-backend` only. No Python calls, contract edits, sibling edits,
anomaly integration, comparison simulation, or deployment.

## Implemented routes and query contract

| Route | Filters and output | Pagination/sort |
| --- | --- | --- |
| `GET /api/v1/imports/:id/rooms` | `from`, `to`; period-scoped room metadata, observed energy/cost/power and device coverage. | `page=1`, `page_size=50`, max 2,000; `room_id` ascending. |
| `GET /api/v1/imports/:id/devices` | `from`, `to`, optional `room_id`; device metadata, observed energy/cost/power, coverage, rated power. | `page=1`, `page_size=50`, max 2,000; `(room_id,device_id)` ascending. |
| `GET /api/v1/imports/:id/timeseries` | `from`, `to`, optional exclusive `room_id` or `device_id`, `bucket_seconds`; office scope if no ID filter. | `page=1`, `page_size=500`, max 2,000; bucket start ascending. |
| `GET /api/v1/imports/:id/weekday-analytics` | `from`, `to`, optional exclusive `room_id` or `device_id`; Monday–Sunday local calendar groups. | Seven fixed weekday groups, Monday to Sunday. |

All windows are half-open. Contract query names are `from` and `to` (ISO UTC);
the additive aliases `from_utc` and `to_utc` are also accepted. Supplying both
names for one boundary is a validation error. Omitted bounds use export
start/end. Bounds must be valid ISO UTC timestamps aligned to the source grid anchored at export start;
range length is at most 366 days. Timeseries bucket values are 60, 300, 600,
900, 1800, 3600 and 86400 seconds, only when the value is at least and a
multiple of source resolution. Buckets align to the Asia/Kolkata local clock;
daily bucket boundaries are local midnight. Both requested bounds must align
to the bucket. Calendar endpoints
support `Asia/Kolkata` only (fixed offset, no DST handling). Unknown query keys,
IDs, malformed filters, or page sizes over 2,000 return HTTP 422
`VALIDATION_ERROR`; unsupported timezone, range, or bucket alignment returns
HTTP 422 `UNSUPPORTED_INPUT` with an actionable message. Unknown dataset is
404 `NOT_FOUND`.

The full filtered window total and current page total are separate response
fields. Pagination metadata describes the complete filtered count; a page must
not be treated as the full dataset. Timeseries provides
`full_period_observed_energy_kwh`, `full_period_observed_cost_inr`, and
`page_observed_energy_kwh` / `page_observed_cost_inr`. Breakdown provides the
equivalent `full_filtered_*` and `page_*` totals.

## Aggregation and coverage

- Every energy aggregate sums stored per-device `energy_kwh` once. The office
  is the sum of devices; each room is the sum of its devices. Room occupancy or
  other room interval metadata is never an energy input. Cumulative counters
  and device `quantity` are not summed or multiplied.
- Windows and buckets do not prorate source intervals. Intervals crossing a
  requested boundary or bucket boundary return `UNSUPPORTED_INPUT` and ask for
  aligned bounds or a compatible bucket.
- Each scope compares expected duration with the union of persisted source
  interval duration per expected device. Overlaps count once for coverage and
  flag the scope incomplete; each persisted row's energy is still counted
  once. An interval marked partial also prevents a complete classification.
- Complete requires all expected devices to cover the full requested period
  or bucket with no source-partial or overlapping interval. Partial means some
  coverage exists but the requirement is unmet. Missing means no interval
  coverage exists. A fully missing bucket has `energy_kwh: null`, not zero. A
  partial bucket returns the observed energy sum and its `partial` status; it
  is not extrapolated. If every item in a total has unknown energy, that total
  is null. Costs use current tariff on known observed energy only; unset tariff
  is null and configured zero is numeric zero.
- Nominal rated power is reported separately. Observed average power is
  persisted interval-average power weighted over unique covered seconds;
  observed peak is the maximum persisted interval `max_power_w`. Both include
  their coverage status and are not efficiency or equipment-health claims.
- Weekday groups use Asia/Kolkata local calendar dates, never UTC weekday
  labels. A complete day requires the full local day in the requested and
  exported range and complete expected-device interval coverage. The mean is
  the energy mean of complete days only; partial and missing days are excluded.
  Weekdays are calendar labels only: no working-day inference or policy
  evaluation is performed. A source interval crossing local midnight is
  unsupported for weekday attribution.
- Provenance is returned additively as `{ synthetic, synthetic_label }` in
  analytics, and the existing persisted source metadata is returned by summary.
  The summary retains legacy `gaps: []` but adds
  `gap_assessment.status: "not_performed"`; it does not claim that dataset-wide
  gap assessment ran. No gap list is constructed.

## Reference results and actual HTTP verification

The focused `test/historical.test.ts` uses a scratch in-memory SQLite database
and a local ephemeral-port Express server. It exercises actual requests against
the new routes:

- Reference persisted data returns office `0.03 kWh`, light `0.02 kWh`, and
  refrigerator `0.01 kWh`. A first-minute timeseries bucket sums simultaneous
  light/refrigerator rows to `0.015 kWh`; timestamps on different devices are
  kept distinct.
- Current tariff unset returns null cost; at ₹10/kWh office cost is ₹0.30;
  configured zero returns numeric zero for both tariff and cost.
- Changing a stored device's quantity to 7 leaves its `0.01 kWh` energy
  unchanged. The device response reports nominal 600 W separately from
  observed average and interval peak power.
- Removing refrigerator coverage from one minute gives the office bucket
  `energy_kwh: 0.01`, `status: partial`, expected 120 device-seconds and 60
  covered device-seconds. Removing all source rows from the next minute gives
  null energy and `status: missing`.
- Room and device results reconcile with that same observed office total.
  Page size 1 returns rooms once in stable order; timeseries page 2 is the
  missing bucket and its page energy total is null.
- A daily bucket aligned to Asia/Kolkata midnight reports only 240 observed
  device-seconds out of 172,800 expected for a two-device day. A UTC Sunday
  19:00Z observation groups into local Monday. A partial first day has no
  complete-day average. A persisted `partial=true` row also prevents a bucket
  from being marked complete even when duration is fully covered.
- A one-hour bucket starts at `18:30Z` (local midnight) and reports the two
  reference minutes as `0.03 kWh`, 240 of 7,200 expected device-seconds, and
  `partial`; this checks local hourly bucket alignment.
- A synthetic 8-day dataset has two fully covered Mondays and one Tuesday.
  Monday observed total is 43.2 kWh, two complete days, mean 21.6 kWh; Tuesday
  observed total and one-day mean are 21.6 kWh. This checks unequal weekday
  occurrence counts.
- A misaligned window returns HTTP 422 `UNSUPPORTED_INPUT`. Synthetic label
  and source metadata persist into API output. When all persisted rows are
  removed, summary energy and cost are null even with a configured tariff. The
  test tears down its server and closes the scratch database.

Examples for OpenCode/frontend consumption, including exact route query keys
and abbreviated JSON, are in [AUDITOR_API_EXAMPLES.md](AUDITOR_API_EXAMPLES.md).
The shared `contracts/v1` directory and verifier were not modified.

## P015 result cap behavior carried forward

Existing analysis jobs cap merged findings at 100,000, merged warnings at
100,000, and evidence intervals at 100,000 per finding. Exceeding a computation
cap fails the job with `INSUFFICIENT_DATA`; it does not publish a partial
successful result. Result pagination (`page`, `page_size`, maximum 500) is
retrieval-only and does not truncate computation or persistence. Python
request batches are separately bounded to at most 2,000 device and 2,000 room
intervals. This is taken from P015 implementation/evidence; the P015 boundary
tests were not repeated for P023.

## Verification record

Commands run after implementation:

- `npm run verify:contract` — 75/75.
- `npm run validate:schema` — 24/24.
- `npm run typecheck`, `npm run lint`, `npm run build` — pass.
- `npm test` — 28/28 (includes existing import, analysis, forecast tests and
  the new real-HTTP historical analytics test).
- `npm run check:import-http` — HTTP 201 initial upload; equivalent JSON and
  CSV retries HTTP 200; summary `0.03 kWh`; tariff HTTP 200; summary cost
  `₹0.30`; summary also showed `gap_assessment: not_performed` and source
  provenance.
- `npm run check:analysis-http` — pass against committed Python P010
  `36f5832f298379c3a889a32673c409152aa8eaf0`; one reference finding,
  `0.01 kWh` avoidable energy, `0.03 kWh` dataset energy, `₹0.30` cost, batch
  sizes 1,000 and 317 comparable, 22 Python requests.
- `npm run check:forecast-http` — pass against committed Python P013
  `7f71363aa9361e67a0cb2815b98aee79b0708cf9`; 672 history hours, 720 November
  points, `10.8 kWh`, repriced to `₹108` at ₹10/kWh, and honest insufficient
  history failure. Two real Python forecast requests.
- Final `npm run verify:contract` — 75/75; `npm run validate:schema` — 24/24;
  `npm run typecheck`, `npm run lint`, `npm run build` — pass; `npm test` —
  28/28; `git diff --check` — clean. No large month-upload benchmark was run.

Feature commit `d683578106e718a4e1a42f9a29ce796bcb2d2857` was pushed normally
to `origin/main`; local and remote `main` matched at publication. Final
continuity updates are committed and pushed separately.

Review remains pending. Next frontend action: OpenCode consumes these documented
routes to add office timeseries, room/device breakdown and calendar-weekday
views, displaying coverage/provenance and using full-period versus page totals
explicitly.
