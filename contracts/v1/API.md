# Service interfaces — contract v1.0.0

Design only. No routes are implemented in F1. All payloads use the field names
and units of CONTRACT.md. Timestamps are UTC `...Z`; durations in seconds;
energy in kWh; money in INR with an explicit tariff.

## Cross-cutting conventions

- Bases: simulator `http://localhost:4000/api/v1`, auditor
  `http://localhost:4001/api/v1`, python `http://localhost:8000/v1`
  (hosts/ports from configuration; see below).
- Success envelope: `{ "data": <payload>, "meta": { "request_id": "<id>" } }`.
- Error envelope with HTTP status: confirmed
  `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "field": "devices[3].avg_power_w", "row": 12 } }`.
  `field`/`row` are present for import/validation failures. Stable codes:
  `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `UNSUPPORTED_VERSION`,
  `MODEL_UNAVAILABLE`, `INSUFFICIENT_DATA`, `JOB_FAILED`.
- Pagination for readings: `?page=1&page_size=500` (`page_size` default 500,
  max 2000); response `{ "data": [...], "page": { "page": 1, "page_size": 500,
  "total": 8640 } }`. Bounded ranges (`from`, `to`) required on time-series
  routes. A whole month of raw records is never returned to a browser in one
  response, and charts never call Python per chart.
- Jobs for expensive work: `POST .../jobs` → `202 { "data": { "job_id",
  "status": "queued" } }`; `GET .../jobs/:id` →
  `{ "data": { "job_id", "status": "queued|running|succeeded|failed",
  "result_ref": "..." } }`. Public auditor job lifecycle is separate from
  internal Python execution; no distributed queue is designed for this stage.
- Configuration: service URLs come from configuration
  (`NEXT_PUBLIC_SIMULATION_BACKEND_URL`, `NEXT_PUBLIC_AUDITOR_BACKEND_URL`,
  `ML_SERVICE_URL`). CORS allows the paired frontend origin — CORS is not
  authentication. Mutable public endpoints need backend access controls before
  hosting; secret credentials never go in browser-public variables. Detailed
  access-control implementation belongs to later layers.

## Simulator backend (authoritative)

| Method & route | Purpose | Key payload / response |
|---|---|---|
| `GET /health` | Liveness + clock | `{ "status": "ok", "run_id", "sim_time_utc", "contract_version": "1.0.0" }` |
| `GET /inventory` | Rooms, devices, policies | `{ "rooms": [...], "devices": [...], "policies": [...] }` (contract shapes) |
| `GET /state` | Current snapshot | `{ "run_id", "seq", "sim_time_utc", "rooms": [{ "room_id", "occupancy" }], "devices": [{ "device_id", "on", "power_w" }] }` |
| `POST /control/start` | Start/resume | `{ "speed": 60 }` → `{ "run_id", "seq", "sim_time_utc" }` |
| `POST /control/pause` | Freeze simulated time | → `{ "run_id", "seq", "sim_time_utc" }` (pause advances no time) |
| `POST /control/resume` | Resume | `{ "speed": 60 }` → snapshot as above |
| `POST /control/reset` | New run | → `{ "run_id": "<new>", "seq": 0, "sim_time_utc" }` |
| `POST /control/speed` | Set speed | `{ "speed": 1\|2\|10\|60\|100\|1000 }` → `{ "speed" }` |
| `POST /occupancy` | Total/manual occupancy | `{ "mode": "manual\|scheduled", "total": 14 }` → `{ "allocation": [{ "room_id", "count" }] }` |
| `POST /calendar` | Working days/hours | `{ "working_days": [1,2,3,4,5], "open_local": "09:00", "close_local": "18:00" }` → new policy version refs |
| `POST /devices/:id` | Device control | `{ "on": true }` or `{ "override_seconds": 600 }` → `{ "device_id", "on", "seq" }` |
| `POST /environment` | Room climate | `{ "room_id", "temp_c": 26.5, "rh_pct": 55 }` → `{ "room_id", "seq" }` |
| `POST /history/jobs` | Batch history build | `{ "from": "<utc>", "to": "<utc>", "interval_seconds": 60 }` → `{ "job_id" }` |
| `GET /history/jobs/:id` | Job status | `{ "job_id", "status", "result_ref" }` |
| `GET /export?format=csv\|json&from&to&interval_seconds` | File export | Self-contained file download conforming to this contract (CSV carries its metadata envelope on the first data row) |
| `GET /snapshot?seq=` | Recovery snapshot | Full `GET /state` payload at latest seq |
| `GET /history?from&to&room_id?` | Gap-fill readings | Paginated contract-shaped intervals |

## Auditor backend

| Method & route | Purpose | Key payload / response |
|---|---|---|
| `GET /health` | Liveness | `{ "status": "ok", "contract_version": "1.0.0", "ml_reachable": true }` |
| `POST /imports` | Upload CSV/JSON (multipart `file`) | → `{ "dataset_id", "run_id", "status": "accepted\|rejected", "report": { "errors": [], "warnings": [], "duplicates_deduped": 0 } }` |
| `GET /imports` | Dataset listing | `[{ "dataset_id", "run_id", "scenario_id", "interval_seconds", "imported_utc" }]` |
| `GET /imports/:id/summary` | Office/period totals | `{ "dataset_id", "energy_kwh", "cost_inr", "tariff_inr_per_kwh", "gaps": [] }` |
| `GET /imports/:id/rooms` | Per-room aggregates | Paginated `[{ "room_id", "energy_kwh", "occupancy_avg" }]` |
| `GET /imports/:id/devices` | Per-device aggregates | Paginated `[{ "device_id", "energy_kwh", "vacant_on_seconds" }]` |
| `GET /imports/:id/timeseries?room_id?&device_id?&from&to` | Readings | Paginated contract-shaped intervals |
| `PUT /imports/:id/tariff` | Editable flat tariff | `{ "inr_per_kwh": 10.0 }` → `{ "dataset_id", "inr_per_kwh": 10.0 }` (identity unchanged, no retraining) |
| `POST /analysis/jobs` | Start analysis | `{ "dataset_id" }` → `{ "job_id" }` |
| `GET /analysis/jobs/:id` | Status/results ref | `{ "job_id", "status", "result": { "findings": [...], "totals": {...} } }` on success |
| `POST /forecasts` | Forecast | `{ "dataset_id", "horizon": "next_24h\|next_7d\|next_calendar_month" }` → `{ "forecast_id", "horizon", "origin_utc", "model_version", "points": [...], "uncertainty": "unavailable" }` |
| `POST /comparisons` | Original/improved | `{ "base_dataset_id", "improved_dataset_id" }` → `{ "base_energy_kwh", "improved_energy_kwh", "simulated_savings_kwh": ..., "period_compatible": true }` |
| `GET /reports/monthly?dataset_id&month=YYYY-MM` | Printable report data | `{ "month", "energy_kwh", "cost_inr", "by_room": [...], "findings": [...], "forecast": {...} }` (`month` is a local calendar month) |

## Python service (called only by auditor backend)

| Method & route | Purpose | Key payload / response |
|---|---|---|
| `GET /health` | Liveness | `{ "status": "ok", "model_available": true }` |
| `GET /model/info` | Model/version metadata | `{ "model_version": "baseline-v1", "baseline_version": "mean-profile-v1", "contract_version": "1.0.0" }` |
| `POST /v1/analyze` | Findings for a dataset window | `{ "contract_version": "1.0.0", "dataset_id", "run_id", "horizon": {...}, "intervals_ref": "<auditor-held>" }` → `{ "findings": [<finding shape>], "warnings": [] }`; errors `MODEL_UNAVAILABLE`, `INSUFFICIENT_DATA` |
| `POST /v1/forecast` | Forecast | `{ "contract_version": "1.0.0", "dataset_id", "horizon": "next_24h\|next_7d\|next_calendar_month", "origin_utc": "...", "assumed_schedule_ref": "pol-hours:1" }` → `{ "horizon", "origin_utc", "model_version", "points": [{ "start_utc": "...", "energy_kwh": 1.25 }], "uncertainty": "unavailable" }` |

Finding shape: `{ "finding_id", "finding_type", "room_id", "device_id",
"window_start_utc", "window_end_utc", "observed": { "value", "unit" },
"expected": { "value", "unit" }, "method": "rule|model",
"suggested_action", "avoidable_energy_kwh"?, "assumptions",
"resolution_limit" }`. No confidence percentages on rule findings.

## Socket.IO (simulator frontend ↔ backend only)

- Namespace `/` (default). Every event carries `run_id`; `seq` is a per-run
  monotonically increasing server sequence that resets to 0 on a new `run_id`.
- `state.update` (server → client): `{ "run_id", "seq", "sim_time_utc",
  "rooms": [...], "devices": [...] }` — same shape as `GET /state`.
- `command` (client → server): `{ "cmd_id": "<uuid>", "type":
  "device.set|speed.set|occupancy.set|...", "payload": {...} }`.
- `command.ack` (server → client): `{ "cmd_id", "ok": true, "seq",
  "sim_time_utc" }` (or `"ok": false, "error": {...}`).
- `replay.request` (client → server): `{ "run_id", "from_seq": 412 }`.
- `replay.response` (server → client): `{ "run_id", "events": [<state.update>
  payloads since from_seq] }`, or `snapshot.required: { "run_id",
  "reason": "gap|run_changed|buffer_overflow" }`.
- On `snapshot.required` the client calls `GET /snapshot` then
  `GET /history?from&to` to backfill. The frontend never runs an authoritative
  simulation clock; it renders the latest server-sequenced state.
- No auditor live ingestion exists in MVP1.
