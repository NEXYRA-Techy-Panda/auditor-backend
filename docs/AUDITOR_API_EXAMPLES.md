# Auditor API examples

These examples describe the implemented P006/P015 API. Success payloads use
`{ "data": ..., "meta": { "request_id": "..." } }`; failures use
`{ "error": { "code", "message", ... } }`. IDs and request IDs below are
illustrative. Examples are checked against the actual Express routes and the
P010 service integration at commit
`36f5832f298379c3a889a32673c409152aa8eaf0`.

## Evidence-backed report economics preview (P028-BACKEND)

`POST /api/v1/reports/preview` is an additive read-only application API. It
accepts only a dataset, one completed vacancy analysis job and stable persisted
finding IDs. A finding ID is the database key `<job-id>:<finding-id>` (not a
pagination index). Body size uses the existing 100 KiB JSON limit; at most 50
unique findings are accepted. Pass each finding's existing `finding_id` from
the analysis result directly; the backend resolves it within the selected
job. Caller-supplied energy, evidence, tariff or
ownership fields are rejected.

No investment assumptions: the finding's supported observed-window savings
are priced with the current saved INR/kWh tariff. The route does not annualize
or infer ROI/payback.

```http
POST /api/v1/reports/preview
Content-Type: application/json

{"dataset_id":"ds-1","job_id":"job-1","finding_ids":["vacant_but_on:light-1:2026-09-21T03:30:00Z"]}
```

Explicit user economics: fields are assumptions, not persisted measurements.
Projection days and months must be supplied together, with 30 days per month;
changing from the finding's observed period requires an explicit extrapolation.
Recurring cost amount and period must be supplied together.

```http
POST /api/v1/reports/preview
Content-Type: application/json

{"dataset_id":"ds-1","job_id":"job-1","finding_ids":["vacant_but_on:light-1:2026-09-21T03:30:00Z"],"economics":{"implementation_cost_inr":12000,"recurring_cost_inr":0,"recurring_cost_period_months":1,"supported_gross_recurring_savings_inr_per_month":2000}}
```

The successful response below is the exact shape and known-answer example for a
persisted 0.01 kWh vacancy finding covering one minute, a saved tariff of
₹10/kWh, no investment assumptions, and synthetic fixture provenance. Dynamic
request ID and generation time are illustrative.

```json
{
  "data": {
    "dataset_id": "ds-1",
    "run_id": "run-1",
    "job_id": "job-1",
    "evidence": {
      "source": "persisted_completed_vacancy_findings",
      "synthetic": true,
      "synthetic_label": "reference fixture",
      "coverage": {"start_utc":"2026-09-21T03:30:00Z","end_utc":"2026-09-21T03:32:00Z"},
      "finding_count": 1
    },
    "tariff": {"inr_per_kwh":10,"currency":"INR","provenance":"current_saved_local_tariff"},
    "generated_utc":"2026-09-25T00:00:00.000Z",
    "recommendations":[{
      "recommendation_id":"vacant_but_on:light-1:2026-09-21T03:30:00Z",
      "suggested_action":"Review the lighting schedule",
      "evidence_type":"vacancy_estimate",
      "method":"rule",
      "evidence":{
        "reference":{"dataset_id":"ds-1","run_id":"run-1","job_id":"job-1","finding_id":"vacant_but_on:light-1:2026-09-21T03:30:00Z","device_id":"light-1","room_id":"room-1","start_utc":"2026-09-21T03:30:00Z","end_utc":"2026-09-21T03:31:00Z"},
        "finding_assumptions":["Vacancy beyond grace; standby draw applied"],
        "coverage_limitations":["60-second intervals"],
        "synthetic":true,
        "avoidable_energy_kwh":0.01,
        "source_period_days":0.0006944444444444445,
        "savings_basis":"vacant_but_on:light-1:2026-09-21T03:30:00Z persisted avoidable_energy_kwh",
        "energy_provenance":"measured_and_derived_from_persisted_finding"
      },
      "economics":{
        "status":"available","unavailable_reason":null,"projection_label":"observed_period","projection_assumption":null,
        "projected_energy_reduction_kwh":0.01,"gross_savings_inr":0.1,"recurring_cost_inr":0,
        "net_period_savings_inr":0.1,"implementation_cost_inr":null,"upfront_classification":"unknown",
        "period_roi_percent":null,"simple_payback_months":null,"supported_net_recurring_savings_inr_per_month":null,
        "payback_status":"unknown_cost","currency":"INR","tariff_inr_per_kwh":10,
        "calculation_input":{"supported_energy_reduction_kwh":0.01,"source_period_days":0.0006944444444444445,
          "projection_period_days":0.0006944444444444445,"projection_period_months":0.00002314814814814815,
          "tariff_inr_per_kwh":10,"implementation_cost_inr":null,"recurring_cost_inr":null,
          "recurring_cost_period_months":null,"extrapolation":null,"supported_gross_recurring_savings_inr_per_month":null},
        "assumptions_provenance":"no_user_economics_assumptions"
      },
      "overlap_excluded_from_ranking":false
    }],
    "ranking":{"ranking_basis":"shortest_supported_simple_payback","ranked_ids":[],
      "unranked_ids":["vacant_but_on:light-1:2026-09-21T03:30:00Z"],"overlap_conflicts":[],
      "meaning":"Only comparable recommendations with supported payback and known upfront cost are ranked; this is not a verified outcome."},
    "overlap_conflicts":[],
    "scenario_comparison":{"status":"unverified","reason":"Persisted external-input provenance does not establish matched scenarios"}
  },
  "meta":{"request_id":"<request-id>"}
}
```

Successful responses keep every selected recommendation separate. Overlapping
same-device UTC windows appear in `data.overlap_conflicts[]`; their individual
evidence remains visible, but those IDs are unranked and never summed. The
ranking meaning is shortest supported simple payback among comparable entries;
unknown costs/rates and incompatible bases stay in `unranked_ids`.

Failure examples use the standard error envelope. Unknown dataset, job, or
finding is `404 NOT_FOUND`; wrong job/dataset, incomplete job, invalid
assumptions, unsupported detector/finding and request-count limits are `422`
with `VALIDATION_ERROR` or `UNSUPPORTED_INPUT` and a field where applicable.
The existing JSON body bound returns `413 REQUEST_TOO_LARGE`.

```json
{"error":{"code":"UNSUPPORTED_INPUT","message":"Only completed vacancy analysis jobs support avoidable-energy reports","field":"job_id"}}
```

The report distinguishes measured/persisted inputs (dataset/job/finding IDs,
windows, coverage, synthetic provenance and supported vacancy avoidable
energy), derived values (tariff multiplication, economics formulas, overlap and
ranking), and assumptions (explicit cost, recurring rate, projection and
extrapolation inputs). Current tariff is the saved value read at preview time.
Matched-scenario comparison remains unverified because persisted external
input provenance is not established. Full handoff and limitations:
[P028 backend evidence](P028_BACKEND_REPORT_API_EVIDENCE.md).

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

## Summary, gap-assessment state, and synthetic provenance

`GET /api/v1/imports/:id/summary` returns interval energy, tariff-derived
cost, persisted coverage counts and provenance. The legacy `gaps` field remains
an empty compatibility array, while `gap_assessment.status` explicitly says
`not_performed`; an empty list does not mean an assessment was completed.
Analytics endpoints compute bounded coverage for their requested windows.

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
    "gaps": [],
    "gap_assessment": {
      "status": "not_performed",
      "message": "Per-gap coverage assessment is not performed by the summary endpoint; gaps is retained as an empty compatibility field."
    },
    "source_metadata": { "synthetic": true, "synthetic_label": "...", "run": {}, "export": {} }
  },
  "meta": { "request_id": "<request-id>" }
}
```

The energy is summed from persisted device interval energy; cumulative counters
are not added. A non-synthetic import returns `synthetic: false` and
`synthetic_label: null`.

## Historical energy analytics (P023)

All analytics use stored `device_intervals.energy_kwh`. Office energy is the
sum of device rows; room energy is the sum of its devices. Room interval
metadata, cumulative counters, and device `quantity` are never added or used to
multiply energy. Cost is observed energy times the current flat tariff; unset
tariff returns `null`, and a configured zero rate returns numeric zero.

Routes:

| Path | Query filters | Result |
| --- | --- | --- |
| `GET /api/v1/imports/:id/rooms` | `from_utc`, `to_utc`, `page`, `page_size` | Stable `room_id` order; room metadata, energy/cost, observed average/peak power, per-device expected/covered seconds and coverage status. |
| `GET /api/v1/imports/:id/devices` | `from_utc`, `to_utc`, optional `room_id`, `page`, `page_size` | Stable `(room_id, device_id)` order; real metadata, nominal rated power separately from observed average/peak, energy/cost and coverage. |
| `GET /api/v1/imports/:id/timeseries` | `from_utc`, `to_utc`, optional `room_id` or `device_id`, `bucket_seconds`, `page`, `page_size` | Stable bucket-start order; office scope by default, exact energy/cost and expected/covered duration. |
| `GET /api/v1/imports/:id/weekday-analytics` | `from_utc`, `to_utc`, optional `room_id` or `device_id` | Monday–Sunday calendar groups, observed totals/cost, complete/partial day counts and complete-day mean. |

Contract window parameters are `from` and `to` in ISO UTC, with additive
`from_utc` and `to_utc` aliases; supplying both variants for one boundary is a
validation error. All windows are half-open `[from,to)`, defaulting to the
imported export range. Boundaries must align to the source grid anchored at export start;
window length is at most 366 days. Timeseries buckets are 60, 300, 600, 900,
1800, 3600 or 86400 seconds, and must be at least and divisible by the source
resolution. Buckets align to the Asia/Kolkata local clock; daily buckets use
local midnight. Both window boundaries must align to the selected bucket. A
source interval crossing a requested or bucket
boundary produces HTTP 422 `UNSUPPORTED_INPUT` with an actionable alignment
message; energy is never prorated. Calendar grouping currently supports only
`Asia/Kolkata` (no DST calendar is modeled). Weekday analysis is explicitly
calendar-weekday-only; it does not call weekdays working days or infer office
hours from policy.

Breakdown pages default to 50 rows; timeseries pages default to 500 buckets.
All accept `page` (default 1) and `page_size` (max 2,000). Room/device results
sort by stable IDs and timeseries by `start_utc`. Pagination metadata reports
the full filtered count. `full_filtered_observed_energy_kwh` (or
`full_period_observed_energy_kwh`) spans all matching entities/buckets in the
requested window; `page_observed_energy_kwh` covers only returned rows.

Missing coverage is not zero consumption. A bucket with no observed rows has
`energy_kwh: null`; one with some observed energy but incomplete device
coverage carries that known sum and `coverage.status: "partial"`. Complete
means every expected device covers the full expected duration with no partial
or overlapping interval. Summary `gap_assessment.status: "not_performed"`
means no dataset-wide gap enumeration was run. Per-gap lists are not built.
Analytics and summary include `provenance: { synthetic, synthetic_label }`
and/or source metadata so clients can disclose known synthetic inputs.

Reference dataset values:

- Office total: `0.03 kWh`; `light-a`: `0.02 kWh`; `fridge-b`: `0.01 kWh`.
- Office timeseries for the first minute (two devices at the same timestamp):
  `0.015 kWh`; equal timestamps on different devices remain distinct.
- At `₹10/kWh`, office cost is `₹0.30`; at an unset tariff energy remains known
  while cost is null; at configured zero tariff both rate and cost are `0`.
- Increasing a device's metadata `quantity` does not change stored interval
  energy or any aggregate.

Representative response for a partial office minute followed by a fully
missing minute (abridged):

```json
{
  "data": {
    "scope": { "type": "office" },
    "full_period_observed_energy_kwh": 0.01,
    "full_period_complete": false,
    "page_observed_energy_kwh": 0.01,
    "items": [
      { "start_utc": "2026-09-21T03:30:00.000Z", "energy_kwh": 0.01,
        "coverage": { "status": "partial", "expected_seconds": 120, "covered_seconds": 60 } },
      { "start_utc": "2026-09-21T03:31:00.000Z", "energy_kwh": null,
        "coverage": { "status": "missing", "expected_seconds": 120, "covered_seconds": 0 } }
    ],
    "pagination": { "page": 1, "page_size": 500, "total": 2, "total_pages": 1 }
  }
}
```

If query parameters are invalid or unsupported, routes return HTTP 422 with
`VALIDATION_ERROR` or `UNSUPPORTED_INPUT`; unknown dataset IDs return HTTP 404
`NOT_FOUND`. Unknown query keys and unknown room/device IDs are validation
errors. These analytics do not call Python.

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

## Device detectors (P026)

`GET /api/v1/detectors` lists every detector the analysis command accepts.
`POST /api/v1/analysis/jobs` selects one with an additive `detector` field:
`"vacancy"` (default, unchanged), `"excess_consumption"` (Python P022
`/v1/anomalies`, `excess-power-mad-v1`) or `"gradual_trend"` (Python P024
`/v1/drift`, `gradual-power-trend-v1`).

```json
{
  "dataset_id": "auditor-generated-id",
  "detector": "excess_consumption",
  "reference_window": { "start_utc": "2026-01-01T00:00:00Z", "end_utc": "2026-01-03T00:00:00Z" },
  "evaluation_window": { "start_utc": "2026-01-03T00:00:00Z", "end_utc": "2026-01-05T00:00:00Z" }
}
```

```json
{
  "data": { "job_id": "analysis-job-id", "status": "queued", "detector": "excess_consumption" },
  "meta": { "request_id": "<request-id>" }
}
```

Reply `202`; poll `GET /api/v1/analysis/jobs/:id`. The reference window must end
at or before the evaluation window starts, both must lie inside the dataset
export range and align to imported interval boundaries. `422` names the
window/field that failed, `404` an unknown dataset, `503` a full queue.

Completed detector jobs return the same envelope as a vacancy job plus a
`detector` identity block:

```json
{
  "data": {
    "job_id": "analysis-job-id", "dataset_id": "auditor-generated-id", "status": "completed",
    "method": "rule", "method_version": "excess-power-mad-v1",
    "requested_range": { "start_utc": "2026-01-03T00:00:00Z", "end_utc": "2026-01-05T00:00:00Z" },
    "detector": { "id": "excess_consumption", "label": "Excess-consumption deviation versus an earlier comparable reference",
      "method": "rule", "method_version": "excess-power-mad-v1", "technique": "robust_median_mad",
      "finding_type": "excess_consumption_deviation", "request_format": "excess-power-request-v1" },
    "windows": {
      "reference": { "start_utc": "2026-01-01T00:00:00Z", "end_utc": "2026-01-03T00:00:00Z" },
      "evaluation": { "start_utc": "2026-01-03T00:00:00Z", "end_utc": "2026-01-05T00:00:00Z" }
    },
    "result": {
      "status": "findings_detected", "synthetic": true, "synthetic_label": "synthetic fixture (not real building data)",
      "coverage": { "start_utc": "2026-01-03T00:00:00Z", "end_utc": "2026-01-05T00:00:00Z",
        "devices": 1, "unsupported_devices": 0, "detector_calls": 1, "max_section_records": 2000 },
      "detector_coverage": { "evaluation_device_intervals": 576, "evaluated": 576, "flagged": 288,
        "insufficient_reference": 0, "excluded": {}, "reference_device_intervals": 576,
        "reference_usable": 576, "reference_excluded": {} },
      "devices": [{ "device_id": "light-a", "room_id": "room-a", "device_type": "lighting",
        "status": "deviation_found", "assessment_source": "detector", "comparison": "own fully-on reference",
        "reference": { "usable_intervals": 576, "excluded": {}, "baselines_by_interval_seconds": { "300": { "support": 576, "median_w": 600, "threshold_w": 660 } } },
        "evaluation": { "evaluated": 576, "flagged": 288, "insufficient_reference": 0, "insufficient_reasons": {}, "excluded": {} } }],
      "aggregation": { "stored_interval_seconds": 60, "max_section_records": 2000,
        "resolutions_by_device": { "light-a": 300 },
        "emitted_bins_by_device": { "light-a": 1152 },
        "excluded_device_bins": { "light-a": { "mixed_duty_or_off": 12 } } },
      "warnings": [
        { "code": "NOT_A_DIAGNOSIS", "message": "Findings are statistical excess-consumption deviations ..." },
        { "code": "AGGREGATED_INTERVALS", "message": "Stored readings were aggregated onto requested contract intervals ..." },
        { "code": "NOT_AVOIDABLE_SAVINGS", "message": "energy_above_baseline_kwh is energy above the reference median over flagged intervals, not a guaranteed avoidable amount ..." }],
      "exclusions": [], "totals": { "findings": 1, "other_changes": 0, "exclusions_listed": 0, "exclusions_total": 12 },
      "findings": [{
        "finding_id": "excess_consumption_deviation:light-a:2026-01-04T00:00:00Z",
        "finding_type": "excess_consumption_deviation", "device_id": "light-a", "room_id": "room-a",
        "window_start_utc": "2026-01-04T00:00:00Z", "window_end_utc": "2026-01-05T00:00:00Z", "intervals": 288,
        "observed": { "value": 1000, "unit": "W" }, "expected": { "value": 600, "unit": "W" },
        "threshold_w": 660, "reference_support": 576,
        "deviation": { "watts": 400, "ratio": 1.67 },
        "energy_above_baseline_kwh": 9.6,
        "energy_note": "Energy above the reference median over the flagged intervals; NOT a guaranteed avoidable amount.",
        "method": "rule", "technique": "robust_median_mad", "detector_version": "excess-power-mad-v1",
        "suggested_action": "Check the Lighting A in the open workspace: confirm its schedule/manual state ...",
        "detector_id": "excess_consumption"
      }],
      "findings_pagination": { "page": 1, "page_size": 100, "total": 1 },
      "limitations": ["Detector output is a statistical deviation under the stated comparability rules; it is not a confirmed malfunction and not an efficiency diagnosis."]
    },
    "created_at": "<utc>", "completed_at": "<utc>"
  },
  "meta": { "request_id": "<request-id>" }
}
```

`gradual_trend` jobs return the same shape with
`method_version: "gradual-power-trend-v1"`, findings of type
`sustained_upward_power_trend` (with `trend`, `persistence`, `support` and
`assessed_period`), and an additional `other_changes` list for
`abrupt_level_change`, `upward_change_not_sustained` and
`level_offset_without_trend` observations, which are descriptive and never
findings.

Rules the frontend can rely on:

- `result.status` is one of `findings_detected`,
  `evaluated_no_deviation` / `evaluated_no_gradual_trend`,
  `insufficient_reference` / `insufficient_history`, `unsupported_context`,
  `unsupported_aggregation`, `no_comparable_observations`. **Not assessed is
  never reported as evaluated with no findings.**
- Every device entry carries `assessment_source`: `detector` (Python assessed
  it) or `auditor_precheck` (the auditor could not build a valid request and
  states the reason).
- When the stored resolution fits the 2,000-record section bound the records
  are sent unchanged; otherwise they are aggregated onto a requested contract
  interval and every excluded bin is counted under
  `aggregation.excluded_device_bins` (`missing_device_readings`,
  `partial_or_incomplete_readings`, `duty_unknown`, `mixed_duty_or_off`,
  `policy_change`, `missing_room_context`).
- Detector results are **not** priced: no cost field is added, a tariff change
  never reruns a detector, and `energy_above_baseline_kwh` / trend magnitudes
  are never added to vacancy avoidable-energy totals.
- Python is still called only by this backend; the browser never calls Python.

The `202` detector selection is `"vacancy"` (default), `"excess_consumption"`
or `"gradual_trend"`. The vacancy request is unchanged; the two detectors add
`reference_window` and `evaluation_window` (both required for detectors):

```json
{ "dataset_id": "auditor-generated-id", "detector": "gradual_trend",
  "reference_window":  { "start_utc": "2026-01-01T00:00:00Z", "end_utc": "2026-01-09T00:00:00Z" },
  "evaluation_window": { "start_utc": "2026-01-09T00:00:00Z", "end_utc": "2026-01-25T00:00:00Z" } }
```

Pagination lives at `data.result.findings_pagination` =
`{ page, page_size, total }` (`total` is the full filtered count); request it
with `?page=&page_size=`, maximum page size `500`. Retrieval only.

Failure codes: a request that fails validation is `422 VALIDATION_ERROR` with a
`field` (`reference_window`, `reference_window.start_utc`, `evaluation_window`,
`reference_window` when reference does not end at or before evaluation starts,
`detector` for an unknown detector); an unknown dataset is `404 NOT_FOUND` and a
full queue is `503 CONFLICT`. A detector whose Python call fails returns HTTP
`200` with `status: "failed"`, the `detector` identity block retained, and
`data.error = { code, message }` whose `code` is `PYTHON_UNAVAILABLE`
(unreachable), `PYTHON_TIMEOUT`, `PYTHON_MALFORMED` (bad reply shape),
`REQUEST_TOO_LARGE` / `INSUFFICIENT_DATA` / `UNSUPPORTED_INPUT` /
`UNSUPPORTED_VERSION` / `MODEL_UNAVAILABLE` (upstream rejections delivered as
failed jobs), `JOB_INTERRUPTED` (interrupted at server restart) or `JOB_FAILED`.

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
