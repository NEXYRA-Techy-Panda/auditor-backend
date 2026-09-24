# auditor-backend

Auditor API for the NEXYRA commercial-building energy simulation and auditing
project.

- **Role**: Node.js + Express + TypeScript + SQLite service for import
  validation/persistence, analytics, tariff handling, forecasts (via Python),
  comparison, and report data. Calls `energy-ml-service` server-side.
- **Owner**: Mohan.
- **Local port**: `4001`. Python service: `http://localhost:8000`.

## Status (P006 F5-A, 2026-09-24)

CSV and canonical JSON imports now validate and persist through the auditor's
private SQLite database. `GET /api/v1/health` still reports
`ml_reachable: "not_checked"`. Analysis, forecast, comparison, reports, and
Python calls are not part of this layer. Evidence: [P006 F5-A](docs/P006_F5_A_EVIDENCE.md).

## Setup and commands (Windows PowerShell or Linux shell; Node >= 24, npm)

```sh
npm ci                     # install exact versions from package-lock.json
npm run dev                # tsx watch src/server.ts  -> http://localhost:4001
npm run build              # tsc -> dist/
npm start                  # node dist/server.js (run build first)
npm run typecheck
npm run lint
npm test                   # node:test via tsx (real HTTP on an ephemeral port)
npm run verify:contract    # dependency-free contract checks (read-only bundle)
npm run validate:schema    # formal JSON Schema 2020-12 validation (Ajv)
npm run check:import-scale # generated 31-day CSV over HTTP on port 4001
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

Health check: `curl http://localhost:4001/api/v1/health`.

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

## Configuration

Copy `.env.example` to `.env` for local overrides (`.env` is git-ignored;
real environment variables take precedence). Variables: `PORT` (4001),
`HOST` (127.0.0.1), `FRONTEND_ORIGIN` (http://localhost:3001; the only CORS origin — CORS
is not authentication), `ML_SERVICE_URL` (http://localhost:8000; origin only — configured, not contacted until F4), `JSON_BODY_LIMIT` (100kb; larger JSON
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
