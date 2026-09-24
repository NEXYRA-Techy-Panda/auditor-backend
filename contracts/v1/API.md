# Service interfaces — contract v1.0.1

Design only. No routes are implemented in F1. All payloads use the field names
and units of CONTRACT.md. Timestamps are UTC `...Z`; durations in seconds;
energy in kWh; money in INR with an explicit tariff.

Version note: 1.0.1 replaces the unaccepted 1.0.0 prototype. Full effective
paths are listed below — there is no `/v1/v1/...` route anywhere.

## Cross-cutting conventions

- Effective bases (hosts/ports from configuration; paths below already include
  the prefix): simulator `http://localhost:4000` + `/api/v1/...`, auditor
  `http://localhost:4001` + `/api/v1/...`, python `http://localhost:8000` +
  `/health` or `/v1/...`.
- Success envelope: `{ "data": <payload>, "meta": { "request_id": "<id>" } }`.
- Error envelope with HTTP status:
  `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "field": "devices[3].avg_power_w", "row": 12 } }`.
  `field`/`row` are present for import/validation failures. Stable codes:
  `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `UNSUPPORTED_VERSION`,
  `MODEL_UNAVAILABLE`, `INSUFFICIENT_DATA`, `REQUEST_TOO_LARGE`, `JOB_FAILED`.
- Pagination for readings: `?page=1&page_size=500` (`page_size` default 500,
  max 2000); response `{ "data": [...], "page": { "page": 1, "page_size": 500,
  "total": 8640 } }`. Bounded ranges (`from`, `to`) required on time-series
  routes. A whole month of raw records is never returned to a browser in one
  response, and charts never call Python per chart.
- Jobs for expensive work: `POST .../jobs` → `202 { "data": { "job_id",
  "status": "queued" } }`; `GET .../jobs/:id` →
  `{ "data": { "job_id", "status": "queued|running|succeeded|failed",
  "result_ref": "..." } }`. The public auditor job lifecycle is owned by Node
  and separate from internal Python execution; no distributed queue is designed
  for this stage.
- Configuration: service URLs come from configuration
  (`NEXT_PUBLIC_SIMULATION_BACKEND_URL`, `NEXT_PUBLIC_AUDITOR_BACKEND_URL`,
  `ML_SERVICE_URL`). CORS allows the paired frontend origin — CORS is not
  authentication. Mutable public endpoints need backend access controls before
  hosting; secret credentials never go in browser-public variables. Detailed
  access-control implementation belongs to later layers.

## Scaffold-stage health (no false success indicators)

- Python may be healthy with no model loaded:
  `GET /health` → `{ "status": "ok", "model_available": false }`.
  Analysis/forecast calls then return `MODEL_UNAVAILABLE`.
- Simulator health must not fabricate a run before the engine exists:
  `GET /api/v1/health` (uninitialised) →
  `{ "status": "not_initialized", "run_id": null, "sim_time_utc": null,
  "contract_version": "1.0.1" }`. Once initialised: `{ "status": "ok",
  "run_id": "<id>", "sim_time_utc": "<utc>", "contract_version": "1.0.1" }`.
- Auditor health must not claim Python reachability before checking:
  `GET /api/v1/health` →
  `{ "status": "ok", "contract_version": "1.0.1",
  "ml_reachable": "not_checked" }`, becoming `true`/`false` only after an
  actual `/health` probe of the Python service.

## Simulator backend (authoritative)

| Method & full path | Purpose | Key payload / response |
|---|---|---|
| `GET /api/v1/health` | Liveness + clock | Initialised: `{ "status": "ok", "run_id", "sim_time_utc", "contract_version": "1.0.1" }`; pre-engine: `not_initialized` shape above |
| `GET /api/v1/inventory` | Rooms, devices, policies | `{ "rooms": [...], "devices": [...], "policies": [...] }` (contract shapes) |
| `GET /api/v1/state` | Current snapshot | `{ "run_id", "seq", "sim_time_utc", "rooms": [{ "room_id", "occupancy" }], "devices": [{ "device_id", "on", "power_w" }] }` |
| `POST /api/v1/control/start` | Start/resume | `{ "speed": 60 }` → `{ "run_id", "seq", "sim_time_utc" }` |
| `POST /api/v1/control/pause` | Freeze simulated time | → `{ "run_id", "seq", "sim_time_utc" }` (pause advances no time) |
| `POST /api/v1/control/resume` | Resume | `{ "speed": 60 }` → snapshot as above |
| `POST /api/v1/control/reset` | New run | → `{ "run_id": "<new>", "seq": 0, "sim_time_utc" }` |
| `POST /api/v1/control/speed` | Set speed | `{ "speed": 1\|2\|10\|60\|100\|1000 }` → `{ "speed" }` |
| `POST /api/v1/occupancy` | Total/manual occupancy | `{ "mode": "manual\|scheduled", "total": 14 }` → `{ "allocation": [{ "room_id", "count" }] }` |
| `POST /api/v1/calendar` | Working days/hours | `{ "working_days": [1,2,3,4,5], "open_local": "09:00", "close_local": "18:00" }` → new policy version refs |
| `POST /api/v1/devices/:id` | Set manual override | `{ "manual_state": "on" }` → `{ "device_id", "override": { "active": true, "on": true }, "seq": 118 }`. Persists until cleared. |
| `POST /api/v1/devices/:id` | Clear override | `{ "clear_override": true }` → `{ "device_id", "override": null, "seq": 119 }`. Control returns to policy. |
| `POST /api/v1/environment` | Room climate | `{ "room_id", "temp_c": 26.5, "rh_pct": 55 }` → `{ "room_id", "seq" }` |
| `POST /api/v1/history/jobs` | Batch history build | `{ "from": "<utc>", "to": "<utc>", "interval_seconds": 60 }` → `{ "job_id" }` |
| `GET /api/v1/history/jobs/:id` | Job status | `{ "job_id", "status", "result_ref" }` |
| `GET /api/v1/export?format=csv\|json&from&to&interval_seconds` | File export | Self-contained file download (CSV carries its metadata envelope on the first data row) |
| `GET /api/v1/snapshot?seq=` | Recovery snapshot | Full `GET /api/v1/state` payload at latest seq |
| `GET /api/v1/history?from&to&room_id?` | Gap-fill readings | Paginated contract-shaped intervals |

Override semantics (binding): a set manual state persists until an explicit
clear; there is no automatic expiration in v1. `override_seconds` meters actual
overridden time per interval; it is not a command timeout.

## Auditor backend

| Method & full path | Purpose | Key payload / response |
|---|---|---|
| `GET /api/v1/health` | Liveness | `{ "status": "ok", "contract_version": "1.0.1", "ml_reachable": "not_checked"\|true\|false }` |
| `POST /api/v1/imports` | Upload CSV/JSON (multipart `file`) | → `{ "dataset_id", "run_id", "status": "accepted\|rejected", "report": { "errors": [], "warnings": [], "duplicates_deduped": 0 } }` |
| `GET /api/v1/imports` | Dataset listing | `[{ "dataset_id", "run_id", "scenario_id", "interval_seconds", "imported_utc" }]` |
| `GET /api/v1/imports/:id/summary` | Office/period totals | `{ "dataset_id", "energy_kwh", "cost_inr", "tariff_inr_per_kwh", "gaps": [] }` |
| `GET /api/v1/imports/:id/rooms` | Per-room aggregates | Paginated `[{ "room_id", "energy_kwh", "occupancy_avg" }]` |
| `GET /api/v1/imports/:id/devices` | Per-device aggregates | Paginated `[{ "device_id", "energy_kwh", "vacant_on_seconds" }]` |
| `GET /api/v1/imports/:id/timeseries?room_id?&device_id?&from&to` | Readings | Paginated contract-shaped intervals |
| `PUT /api/v1/imports/:id/tariff` | Editable flat tariff | `{ "inr_per_kwh": 10.0 }` → `{ "dataset_id", "inr_per_kwh": 10.0 }` (identity unchanged, no retraining) |
| `POST /api/v1/analysis/jobs` | Start analysis | `{ "dataset_id" }` → `{ "job_id" }` |
| `GET /api/v1/analysis/jobs/:id` | Status/results ref | `{ "job_id", "status", "result": { "findings": [...], "totals": {...} } }` on success |
| `POST /api/v1/forecasts` | Forecast | `{ "dataset_id", "horizon": "next_24h\|next_7d\|next_calendar_month" }` → `{ "forecast_id", "horizon", "origin_utc", "model_version", "points": [...], "uncertainty": "unavailable" }` |
| `POST /api/v1/comparisons` | Original/improved | `{ "base_dataset_id", "improved_dataset_id" }` → `{ "base_energy_kwh", "improved_energy_kwh", "simulated_savings_kwh": ..., "period_compatible": true }` |
| `GET /api/v1/reports/monthly?dataset_id&month=YYYY-MM` | Printable report data | `{ "month", "energy_kwh", "cost_inr", "by_room": [...], "findings": [...], "forecast": {...} }` (`month` is a local calendar month) |

## Python service (called only by auditor backend)

Auditor Node owns imported data and reads its own database. It prepares a
bounded JSON request carrying the values Python needs; Python receives data
directly in the request and never touches Node's database, filesystem, or
in-memory references. No callback download route or shared storage exists in
MVP1. Bounds: analysis requests carry at most 2,000 device intervals and 2,000
room intervals; forecast history carries at most 2,160 hourly points (90 days).
Oversize requests fail fast with `REQUEST_TOO_LARGE` (HTTP 413) naming the
exceeded bound — the caller narrows the window instead. Large-dataset handling
must preserve ordering and temporal context; arbitrary independent chunks are
insufficient for drift or grace-period analysis.

| Method & full path | Purpose | Key payload / response |
|---|---|---|
| `GET /health` | Liveness | `{ "status": "ok", "model_available": true\|false }` |
| `GET /v1/model/info` | Model/version metadata | `{ "model_version": "baseline-v1", "baseline_version": "mean-profile-v1", "contract_version": "1.0.1" }` |
| `POST /v1/analyze` | Findings for a dataset window | Example A below; errors `MODEL_UNAVAILABLE`, `INSUFFICIENT_DATA`, `REQUEST_TOO_LARGE` |
| `POST /v1/forecast` | Forecast | Example B below; same error set |

### Example A — analysis request (inline bounded data)

```json
{
  "contract_version": "1.0.1",
  "dataset_id": "ds-2026-09-21-a",
  "run_id": "run-fixture-001",
  "window": { "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z" },
  "rooms": [{ "room_id": "room-a", "name": "Room A", "capacity": 4 }],
  "devices": [{ "device_id": "light-a", "name": "Room A light", "room_id": "room-a", "device_type": "lighting", "always_on": false }],
  "policies": [{ "policy_id": "pol-light-a", "version": 1, "kind": "lighting_schedule", "rules": { "on_during_hours": true, "vacancy_grace_seconds": 0 } }],
  "room_intervals": [{ "room_id": "room-a", "interval_start_utc": "2026-09-21T03:30:00Z", "interval_end_utc": "2026-09-21T03:31:00Z", "interval_seconds": 60, "occupancy_avg": 1.0, "occupancy_max": 1, "occupied_fraction": 1.0 }],
  "device_intervals": [{ "device_id": "light-a", "room_id": "room-a", "interval_start_utc": "2026-09-21T03:30:00Z", "interval_end_utc": "2026-09-21T03:31:00Z", "interval_seconds": 60, "avg_power_w": 600.0, "energy_kwh": 0.01, "vacant_on_seconds": 0, "offschedule_on_seconds": 0, "policy_ref": "pol-light-a:1" }],
  "options": { "tariff_inr_per_kwh": 10.0 }
}
```

Response: `{ "findings": [<finding shape>], "warnings": [] }`. Finding shape:
`{ "finding_id", "finding_type", "room_id", "device_id", "window_start_utc",
"window_end_utc", "observed": { "value", "unit" }, "expected": { "value",
"unit" }, "method": "rule|model", "suggested_action",
"avoidable_energy_kwh"?, "assumptions", "resolution_limit" }`.
No confidence percentages on rule findings.

### Example B — forecast request (hourly history + assumptions)

```json
{
  "contract_version": "1.0.1",
  "dataset_id": "ds-2026-09-21-a",
  "origin_utc": "2026-09-22T00:00:00Z",
  "horizon": "next_7d",
  "history_hourly_kwh": [
    { "start_utc": "2026-09-21T00:00:00Z", "energy_kwh": 1.25 },
    { "start_utc": "2026-09-21T01:00:00Z", "energy_kwh": 0.98 }
  ],
  "calendar": { "timezone": "Asia/Kolkata", "working_days_iso": [1, 2, 3, 4, 5], "open_local": "09:00", "close_local": "18:00" },
  "future_assumptions": {
    "schedule": { "policy_id": "pol-light-a", "version": 1, "kind": "lighting_schedule", "rules": { "on_during_hours": true, "vacancy_grace_seconds": 300 } },
    "environment": { "avg_temp_c": 27.5, "avg_rh_pct": 55.0 }
  },
  "model": { "version": "baseline-v1" }
}
```

A policy ID without its definition is not sufficient — the schedule definition
travels inline as shown. Response: `{ "horizon", "origin_utc",
"model_version", "points": [{ "start_utc": "...", "energy_kwh": 1.25 }],
"uncertainty": "unavailable" }`.

## Socket.IO (simulator frontend ↔ backend only)

- Namespace `/` (default). Every event carries `run_id`; `seq` is a per-run
  monotonically increasing server sequence that resets to 0 on a new `run_id`.
- `state.update` (server → client): `{ "run_id", "seq", "sim_time_utc",
  "rooms": [...], "devices": [...] }` — same shape as `GET /api/v1/state`.
- `command` (client → server): `{ "cmd_id": "<uuid>", "type":
  "device.set|speed.set|occupancy.set|...", "payload": {...} }`. A device
  manual-set command carries `{ "device_id": "dev-open-ac",
  "manual_state": "on" }` (persists until cleared); clearing carries
  `{ "device_id": "dev-open-ac", "clear_override": true }`.
- `command.ack` (server → client): `{ "cmd_id", "ok": true, "seq",
  "sim_time_utc" }` (or `"ok": false, "error": {...}`).
- `replay.request` (client → server): `{ "run_id", "from_seq": 412 }`.
- `replay.response` (server → client): `{ "run_id", "events": [<state.update>
  payloads since from_seq] }`, or `snapshot.required: { "run_id",
  "reason": "gap|run_changed|buffer_overflow" }`.
- On `snapshot.required` the client calls `GET /api/v1/snapshot` then
  `GET /api/v1/history?from&to` to backfill. The frontend never runs an
  authoritative simulation clock; it renders the latest server-sequenced state.
- No auditor live ingestion exists in MVP1.
