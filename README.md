# auditor-backend

Auditor API for the NEXYRA commercial-building energy simulation and auditing
project.

- **Role**: Node.js + Express + TypeScript + SQLite service for import
  validation/persistence, analytics, tariff handling, forecasts (via Python),
  comparison, and report data. Calls `energy-ml-service` server-side.
- **Owner**: Mohan.
- **Fixed port**: `19002`. Private Python service: `http://127.0.0.1:19003`.

## Status (P023 A5-backend, 2026-09-24)

CSV and canonical JSON imports validate and persist through the auditor's
private SQLite database. Persisted datasets can now be analyzed through
bounded jobs calling Python's deterministic P010 rules. In production,
`GET /api/v1/health` probes the configured Python `/health`; reachability does
not imply a trained model. The P013 statistical hourly-profile baseline is
available through persisted forecast jobs at `POST /api/v1/forecasts` and
`GET /api/v1/forecasts/:id`; it runs while `model_available` is false. Evidence:
[P006 import](docs/P006_F5_A_EVIDENCE.md) and
[P015 analysis](docs/P015_ANALYSIS_INTEGRATION_EVIDENCE.md) and
[P020 forecast](docs/P020_FORECAST_INTEGRATION_EVIDENCE.md).
Historical room/device breakdowns, exact-bucket office timeseries, and
calendar-weekday analysis use persisted device interval energy only. See
[P023 historical analytics](docs/P023_HISTORICAL_ANALYTICS_EVIDENCE.md).

## Setup and commands (Windows PowerShell or Linux shell; Node >= 24, npm)

```sh
npm ci                     # install exact versions from package-lock.json
npm run dev                # tsx watch src/server.ts  -> http://localhost:19002
npm run build              # tsc -> dist/
npm start                  # node dist/server.js (run build first)
npm run typecheck
npm run lint
npm test                   # node:test via tsx (real HTTP on an ephemeral port)
npm run verify:contract    # dependency-free contract checks (read-only bundle)
npm run validate:schema    # formal JSON Schema 2020-12 validation (Ajv)
npm run check:import-scale # generated 31-day CSV over HTTP on port 19002
npm run check:analysis-http # isolated P010 snapshot + auditor scratch DB
npm run check:forecast-http # isolated P013 snapshot + generated history + scratch DB
```

The database path defaults to `./data/auditor.sqlite` and can be overridden
with `DATABASE_PATH`. `DATABASE_BUSY_TIMEOUT_MS` defaults to `5000`.
Migrations are versioned in `src/db/migrations.ts` and run automatically when
the app opens the database. To migrate without starting HTTP:

```sh
npm run db:migrate
```

The migration command uses the same database configuration as the server.
It never resets existing data. Local database files, WAL and shared-memory
sidecars are ignored by Git. The auditor database is private and independent
from the simulator database.

Health check: `curl http://localhost:19002/api/v1/health`.

## Import API

- `POST /api/v1/imports` — multipart field `file`, one `.csv` or `.json` file.
  First import returns HTTP 201 with `status: "accepted"` and
  `already_imported: false`. An equivalent upload returns HTTP 200 with
  `status: "already_imported"`, `already_imported: true`, and the same
  `dataset_id`. Validation errors use the contract error envelope and include
  `details.errors` plus the first `field`/`row` when known.
- `GET /api/v1/imports` — lists imported datasets.
- `GET /api/v1/imports/:id/summary` — persisted interval energy, coverage and
  optional tariff-derived cost.
- `PUT /api/v1/imports/:id/tariff` — body `{ "inr_per_kwh": 10 }`; rate must
  be finite and nonnegative. The local installation uses one `local` tariff.

## Historical analytics

- `GET /api/v1/imports/:id/rooms` and `/devices` return period-scoped
  aggregates with stable ID ordering, coverage, observed average/peak power,
  nominal device rated power, optional tariff cost, provenance, and pagination.
- `GET /api/v1/imports/:id/timeseries` returns office energy by default;
  `room_id` or `device_id` filters to that scope. Supported exact buckets are
  60, 300, 600, 900, 1800, 3600 and 86400 seconds where divisible by source
  resolution. It includes bucket coverage, full filtered period totals, and
  page totals.
- `GET /api/v1/imports/:id/weekday-analytics` returns Monday–Sunday calendar
  groups in Asia/Kolkata, complete/partial-day counts, and mean energy per
  complete day. It does not classify workdays from policy.
- Analytics accept optional half-open `from` and `to` in ISO UTC (also accept
  additive aliases `from_utc` and `to_utc`); defaults are
  the imported period. Request boundaries must align to source intervals.
  Bucket alignment must also match the chosen resolution. Crossing intervals
  are rejected because exact energy cannot be prorated. One request is limited
  to 366 days. These calendar routes currently support Asia/Kolkata only.
- Analytics pagination defaults to 50 breakdown rows or 500 buckets and is
  capped at 2,000. Stable ordering is by room/device ID or bucket timestamp;
  every response reports pagination and distinguishes full filtered-period
  totals from current-page totals. Missing buckets have null energy; partial
  buckets show known observed energy and an explicit partial status.
- The summary keeps the legacy `gaps: []` field but sets
  `gap_assessment.status: "not_performed"`; it does not imply that gaps were
  assessed. Synthetic/source metadata is passed through in summary and
  analytics responses.

Limits: 512 MiB upload by default (`UPLOAD_MAX_BYTES`, configurable up to
1 GiB), one file and no multipart form fields, 900,000 CSV data records, 1.1
million JSON device intervals, 250,000 room intervals and an 8 MiB metadata
envelope. These include the 803,520 device rows and 223,200 room intervals for
31 days at one-minute resolution with 18 devices and 5 rooms. CSV is parsed as
a stream to a generated file under the OS temporary directory; input filenames
are never used as paths, and temporary files are removed after each request.

Fingerprint is SHA-256 over deterministic JSON serialization of validated,
deduplicated semantic content. Object keys and all arrays are canonicalized;
inventory/policy/interval arrays are ordered by stable IDs and interval keys.
Excluded fields: source/run/export identity (`source`, every `run_id`,
`export_id`), export creation time (`export.created_utc`), `created_note`, and
CSV/JSON format, byte encoding, whitespace, quoting and object-key order.
Included: schema version, scenario and comparison, run start, export coverage
and resolution, building/timezone, synthetic provenance, inventory, policies,
and every deduplicated reading. Tariffs are outside dataset content.

## Analysis jobs

- `POST /api/v1/analysis/jobs` accepts `{ "dataset_id": "..." }`; optional
  `from_utc` / `to_utc` request an interval-aligned subrange. It returns 202
  with a queued job ID. Poll `GET /api/v1/analysis/jobs/:id` for lifecycle,
  progress, and paginated results (`page`, `page_size`).
- The worker is single-concurrency with at most four queued jobs. Jobs and
  findings persist in SQLite. On startup, queued/running jobs from a previous
  process become `failed` with `JOB_INTERRUPTED`.
- The server calls the private configured `ML_SERVICE_URL` using
  `ML_TIMEOUT_MS` (default 10 seconds). P010 rule analysis runs while
  `model_available` is false and returns `method: "rule"`, `model_used: false`.
- Each Python call has one device, its room and referenced policies; owned
  reporting intervals do not overlap. Earlier context is limited to 3,600
  seconds plus one interval. P010 interval evidence is merged only for owned
  intervals; missing room history breaks vacancy continuity. Requests that
  cannot fit the required context within Python's 2,000-record limits fail
  with `INSUFFICIENT_DATA` rather than being truncated.
- A job is capped at 100,000 merged findings; exceeding the result bound
  fails the job instead of presenting partial findings as a completed result.
- Dataset consumption and estimated avoidable energy remain separate. The
  latest tariff is applied only when results are read; tariff edits do not
  rerun analysis. See [frontend API examples](docs/AUDITOR_API_EXAMPLES.md).

## Configuration

Copy `.env.example` to `.env` for local overrides (`.env` is git-ignored;
real environment variables take precedence). The HTTP listener port is fixed
in source at `19002`; `PORT` is intentionally ignored. Other variables:
`HOST` (127.0.0.1), `FRONTEND_ORIGIN` (http://localhost:3001; the only CORS origin — CORS
is not authentication), `ML_SERVICE_URL` (http://localhost:19003; origin only), `ML_TIMEOUT_MS` (10000), `JSON_BODY_LIMIT` (100kb; larger JSON
bodies get 413 `REQUEST_TOO_LARGE`), `SHUTDOWN_TIMEOUT_MS` (10000).
Local development scaffold only — not approval to expose endpoints publicly.

Docs:

- [Project context](docs/PROJECT_CONTEXT.md)
- [Workspace map](docs/WORKSPACE_MAP.md)
- [Handoff](docs/HANDOFF.md)
- [Agent start prompt](docs/AGENT_START_PROMPT.md)
- [Active task](docs/ACTIVE_TASK.md)
- [Progress log](docs/PROGRESS_LOG.md)
- [F1 evidence](docs/F1_EVIDENCE.md)
- [F2-B evidence](docs/F2_B_EVIDENCE.md)
- [Data contract v1](contracts/v1/CONTRACT.md)
- [Service interfaces](contracts/v1/API.md)
- [Auditor API examples](docs/AUDITOR_API_EXAMPLES.md)
- [P015 analysis integration evidence](docs/P015_ANALYSIS_INTEGRATION_EVIDENCE.md)
