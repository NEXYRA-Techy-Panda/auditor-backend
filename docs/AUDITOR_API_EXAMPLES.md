# Auditor API examples

These examples describe the implemented P006/P015 API. Success payloads use
`{ "data": ..., "meta": { "request_id": "..." } }`; failures use
`{ "error": { "code", "message", ... } }`. IDs and request IDs below are
illustrative. Examples are checked against the actual Express routes and the
P010 service integration at commit
`36f5832f298379c3a889a32673c409152aa8eaf0`.

## Import and identity

`POST /api/v1/imports` accepts one multipart file in field `file`.

First import: **201 Created**.

```json
{
  "data": {
    "dataset_id": "auditor-generated-id",
    "run_id": "run-fixture-001",
    "status": "accepted",
    "already_imported": false,
    "report": { "errors": [], "warnings": [], "duplicates_deduped": 0, "additional_errors": false }
  },
  "meta": { "request_id": "<request-id>" }
}
```

Equivalent JSON, CSV, or repeat upload: **200 OK**, same `dataset_id`.

```json
{
  "data": {
    "dataset_id": "auditor-generated-id",
    "run_id": "run-fixture-001",
    "status": "already_imported",
    "already_imported": true,
    "report": { "errors": [], "warnings": [], "duplicates_deduped": 0, "additional_errors": false }
  },
  "meta": { "request_id": "<request-id>" }
}
```

Same source/run/export identity with changed semantic data: **409 Conflict**.

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Export identity conflict: semantic content differs from the stored dataset"
  }
}
```

Validation failure: **422 Unprocessable Entity**. `field` and `row` are
included when known; `details.errors` is capped at 100 and
`additional_errors` reports truncation.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Uploaded dataset failed validation",
    "field": "device_intervals[0].energy_kwh",
    "details": {
      "errors": [{
        "field": "device_intervals[0].energy_kwh",
        "message": "Does not reconcile with average power and duration (1e-9 kWh tolerance)",
        "row": 3
      }],
      "warnings": [], "duplicates_deduped": 0, "additional_errors": false
    }
  }
}
```

Malformed file syntax returns 400. Upload-size, CSV-row, metadata, and
interval-count bounds return 413 `REQUEST_TOO_LARGE`.

## Dataset list and pagination

`GET /api/v1/imports?page=1&page_size=50` returns the page as `data` and
pagination metadata in `meta`. Page size defaults to 50 and is capped at 200.

```json
{
  "data": [{
    "dataset_id": "auditor-generated-id", "run_id": "run-fixture-001",
    "scenario_id": "original", "interval_seconds": 60,
    "imported_utc": "2026-09-24T12:00:00.000Z"
  }],
  "meta": {
    "request_id": "<request-id>",
    "pagination": { "page": 1, "page_size": 50, "total": 1, "total_pages": 1 }
  }
}
```

Invalid page arguments return 422 `VALIDATION_ERROR`.

## Summary, gaps, and synthetic provenance

`GET /api/v1/imports/:id/summary` returns interval energy, tariff-derived
cost, persisted coverage counts and provenance. Current validation only stores
complete imports, so `gaps` is currently an empty array; the API does not yet
emit per-gap objects. Missing required intervals fail import validation rather
than being reported as zero energy.

```json
{
  "data": {
    "dataset_id": "auditor-generated-id",
    "energy_kwh": 0.03,
    "cost_inr": null,
    "tariff_inr_per_kwh": null,
    "synthetic": true,
    "synthetic_label": "F1 known-answer fixture: hand-computed ... Not measured data.",
    "coverage": {
      "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z",
      "device_intervals": 4, "room_intervals": 4
    },
    "gaps": []
  },
  "meta": { "request_id": "<request-id>" }
}
```

The energy is summed from persisted device interval energy; cumulative counters
are not added. A non-synthetic import returns `synthetic: false` and
`synthetic_label: null`.

## Tariff

`PUT /api/v1/imports/:id/tariff` body:

```json
{ "inr_per_kwh": 10 }
```

Success is 200; a finite nonnegative value is required. **Zero is configured**
and distinct from an unset tariff.

```json
{
  "data": { "dataset_id": "auditor-generated-id", "inr_per_kwh": 10 },
  "meta": { "request_id": "<request-id>" }
}
```

Unknown dataset: 404 `NOT_FOUND`. Invalid tariff: 422.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "inr_per_kwh must be a finite nonnegative number",
    "field": "inr_per_kwh"
  }
}
```

With an unset tariff, summary `tariff_inr_per_kwh` and `cost_inr` are `null`.
With a configured zero tariff, both are numeric `0`. The reference fixture is
0.03 kWh; a configured ₹10/kWh tariff gives ₹0.30 cost.

## Analysis job lifecycle

`POST /api/v1/analysis/jobs` body:

```json
{ "dataset_id": "auditor-generated-id" }
```

Optional `from_utc` and `to_utc` select a subrange aligned to imported
interval boundaries and contained in the export. When omitted, the full export
range is requested. The endpoint responds promptly with **202 Accepted**.

```json
{
  "data": { "job_id": "analysis-job-id", "status": "queued" },
  "meta": { "request_id": "<request-id>" }
}
```

Poll `GET /api/v1/analysis/jobs/:id`. Queued/running responses include
`progress.completed_batches` and `total_batches`; completed responses contain
the persisted result; failed jobs remain failed and expose a safe error.
Findings are paginated with `?page=1&page_size=100` (maximum page size 500).

```json
{
  "data": {
    "job_id": "analysis-job-id", "dataset_id": "auditor-generated-id",
    "status": "completed", "method": "rule",
    "method_version": "vacant-beyond-grace-v1",
    "requested_range": { "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z" },
    "actual_coverage": { "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z" },
    "progress": { "completed_batches": 2, "total_batches": 2 },
    "result": {
      "dataset_id": "auditor-generated-id", "run_id": "run-fixture-001",
      "synthetic": true, "synthetic_label": "F1 known-answer fixture ...",
      "method": "rule", "method_version": "vacant-beyond-grace-v1", "model_used": false,
      "requested_range": { "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z" },
      "coverage": {
        "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z",
        "device_intervals": 4, "room_intervals": 4, "complete": true
      },
      "warnings": [{ "code": "ANALYSES_NOT_PERFORMED", "message": "Only the deterministic vacant-beyond-grace rule is implemented..." }],
      "excluded_devices": [{ "device_id": "fridge-b", "reason": "always-on exception: vacant operation is by design" }],
      "batches": { "completed": 2, "total": 2, "max_device_intervals": 2000, "max_room_intervals": 2000 },
      "totals": {
        "dataset_energy_kwh": 0.03, "avoidable_energy_kwh": 0.01,
        "unknown_avoidable_findings": 0, "tariff_inr_per_kwh": 10,
        "dataset_cost_inr": 0.3, "avoidable_cost_inr": 0.1
      },
      "findings": [{
        "finding_id": "vacant_but_on:light-a:2026-09-21T03:31:00Z",
        "finding_type": "vacant_but_on", "room_id": "room-a", "device_id": "light-a",
        "window_start_utc": "2026-09-21T03:31:00Z", "window_end_utc": "2026-09-21T03:32:00Z",
        "observed": { "value": 0.01, "unit": "kWh" }, "expected": { "value": 0, "unit": "kWh" },
        "method": "rule", "suggested_action": "Switch off Room A light when vacant after its applicable grace period.",
        "assumptions": "Vacancy is established only from matching room intervals ...",
        "resolution_limit": "60-second intervals; sub-interval occupancy and switching times are not visible.",
        "avoidable_energy_kwh": 0.01, "avoidable_cost_inr": 0.1,
        "evidence": {
          "rule_version": "vacant-beyond-grace-v1", "policy_refs": ["pol-light-a:1"],
          "vacant_on_seconds_beyond_grace": 60,
          "intervals": [{
            "interval_start_utc": "2026-09-21T03:31:00Z", "interval_end_utc": "2026-09-21T03:32:00Z",
            "counted_from_utc": "2026-09-21T03:31:00Z", "vacant_on_seconds": 60,
            "energy_kwh": 0.01, "policy_ref": "pol-light-a:1"
          }]
        }
      }],
      "findings_pagination": { "page": 1, "page_size": 100, "total": 1 }
    },
    "created_at": "<utc>", "completed_at": "<utc>"
  },
  "meta": { "request_id": "<request-id>" }
}
```

The complete result is stored separately from the current tariff. Changing the
tariff only changes returned `dataset_cost_inr` and `avoidable_cost_inr`; it
does not rerun Python or change energy/findings. An unset tariff returns null
costs; a zero tariff returns numeric zero costs.

Python is called only by the auditor backend. It reports `method: "rule"` and
`model_used: false`; `model_available: false` does not block the rules. Python
unavailable, timed out, malformed replies, or rejected requests produce a
persisted failed job, never an empty-success result. Unfinished queued/running
jobs are marked `JOB_INTERRUPTED` during server startup.

Batching owns non-overlapping device intervals and includes at most 3,600
seconds plus one source interval of earlier room/device history. Context is
used for vacancy grace only; returned findings are merged from P010's
interval-level evidence for owned records. Calls send only one device, its
room, and referenced policy definitions; record bounds are 2,000 each. A
history that cannot fit the 3,600-second context within those bounds fails
with `INSUFFICIENT_DATA`, rather than being truncated. Partial imports expose
`coverage.complete: false`; gaps break vacancy continuity.
One job is also capped at 100,000 merged findings; exceeding that bound fails
the job with `INSUFFICIENT_DATA`, without returning a partial result as complete.

## Forecasts (P020)

The contract defines `POST /api/v1/forecasts` with `{ "dataset_id", "horizon" }`.
Because forecast construction and the Python call run as a persisted background
job, this backend returns an additive `202` status reference. The forecast ID
and job ID are the same UUID. Poll `GET /api/v1/forecasts/{forecast_id}` for
`queued`, `running`, `completed`, or `failed`; completed responses include the
contract forecast fields. Existing import and analysis routes are unchanged.

```http
POST /api/v1/forecasts
Content-Type: application/json

{"dataset_id":"<dataset-id>","horizon":"next_calendar_month"}
```

Optional `origin_utc` selects an explicit Asia/Kolkata local-hour boundary
that is at or after the imported dataset end. When omitted, it defaults to the
first such boundary at or after the dataset's available end; it never uses the
server's current date. Horizons are `next_24h`, `next_7d`, and
`next_calendar_month`.

```json
{
  "data": {
    "forecast_id": "<uuid>", "job_id": "<uuid>", "status": "queued",
    "horizon": "next_calendar_month", "origin_utc": "2026-10-19T03:30:00Z",
    "synthetic": true,
    "synthetic_label": "Generated deterministic hourly fixture; not measured."
  },
  "meta": { "request_id": "<request-id>" }
}
```

```http
GET /api/v1/forecasts/<uuid>
```

Completed response (the `points` array contains every hourly point through the
exclusive horizon end):

```json
{
  "data": {
    "forecast_id": "<uuid>", "job_id": "<uuid>", "dataset_id": "<dataset-id>",
    "status": "completed", "horizon": "next_calendar_month",
    "origin_utc": "2026-10-19T03:30:00Z",
    "method": "statistical_baseline", "baseline_version": "hourly-profile-median-v1",
    "model_version": null, "timezone": "Asia/Kolkata",
    "horizon_start_utc": "2026-10-31T18:30:00Z",
    "horizon_end_utc": "2026-11-30T18:30:00Z",
    "points": [
      {"start_utc":"2026-10-31T18:30:00Z","energy_kwh":0.015,"basis":"weekday_hour","support":4},
      {"start_utc":"2026-10-31T19:30:00Z","energy_kwh":0.015,"basis":"weekday_hour","support":4}
    ],
    "total_energy_kwh": 10.8, "uncertainty": "unavailable",
    "forecast_cost_inr": null, "tariff_inr_per_kwh": null,
    "history_coverage": {
      "observed_hours": 672, "maximum_history_hours": 2160,
      "candidate_hours": 672, "observed_complete_hours": 672,
      "incomplete_hours": 0, "trailing_incomplete_hours": 0,
      "incomplete_hours_by_reason": {}, "gap_before_origin_hours": 0
    },
    "office_hours_policy": {"policy_id":"pol-hours","version":2,"effective_from_utc":"2026-10-19T03:30:00Z"},
    "synthetic": true, "synthetic_label": "Generated deterministic hourly fixture; not measured.",
    "warnings": [{"code":"INPUTS_NOT_USED","message":"..."}],
    "limitations": ["Statistical profile baseline, not a trained model; no accuracy claim is made for this building."]
  },
  "meta": { "request_id": "<request-id>" }
}
```

Errors after queue acceptance are returned as `status: "failed"` with the
Python/backend error code and safe message. For example, too little history
returns `INSUFFICIENT_DATA`; no all-zero forecast is substituted. Unknown
datasets and invalid horizons/origins fail before acceptance. Unsupported
building timezones return `UNSUPPORTED_INPUT`.

The auditor uses `Asia/Kolkata` and the office-hours policy effective at the
origin (latest `effective_from_utc` not later than the origin). It sends that
real policy as `future_assumptions.schedule`; no environment/weather or
occupancy assumptions are invented. P013 accepts an optional schedule policy
and optional environment `{ "avg_temp_c": -30..60, "avg_rh_pct": 0..100 }`;
both are recorded but do not affect its baseline. It also accepts optional
`model.version`, which must be `hourly-profile-median-v1`. The backend sends
that version explicitly and accepts the baseline while `model_available` is
false. Python requires 168, 336, or 672 observed hours for the respective
horizons plus supported weekday/day-class/hour profiles.

History uses stored per-device `energy_kwh`. Each hour is included only when
every expected device has exact, non-overlapping coverage of the entire local
hour. Device energy is summed once; `quantity` and room metadata do not
multiply it. Partial source intervals can join an hour only when their exact
union covers it. Crossing-hour intervals are omitted and reported because
their energy cannot be assigned exactly. Missing or overlapping coverage
omits the office hour; history is never zero-filled or prorated. The latest
2,160 candidate hours are considered. `history_coverage` reports omitted
hours, reasons, trailing incomplete hours, and the gap to origin. Python's own
`MISSING_HOURS`, `STALE_HISTORY`, and `GAP_BEFORE_HORIZON` warnings are retained.
The next calendar month remains the complete local month after the month
containing the origin, not a rolling 30-day interval.

Forecast energy remains immutable. `forecast_cost_inr` is calculated on each
read using the current flat tariff: unset tariff gives `null`, zero tariff
gives `0`. Tariff edits never call Python again. This is forecast cost, not
avoidable cost or savings. Synthetic provenance is copied from the imported
dataset; absent provenance is not labeled measured. No trained model,
prediction interval, or building-specific accuracy claim is returned.
