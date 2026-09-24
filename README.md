# auditor-backend

Auditor API for the NEXYRA commercial-building energy simulation and auditing
project.

- **Role**: Node.js + Express + TypeScript + SQLite service for import
  validation/persistence, analytics, tariff handling, forecasts (via Python),
  comparison, and report data. Calls `energy-ml-service` server-side.
- **Owner**: Mohan.
- **Local port**: `4001`. Python service: `http://localhost:8000`.

## Status (F2-B, 2026-09-24)

Application scaffold implemented; review pending. Only `GET /api/v1/health`
exists. It reports `ml_reachable: "not_checked"`; Python is not contacted until F4. Not implemented: database/migrations, imports/uploads, analysis jobs, forecasts, comparisons, reports, calls to energy-ml-service (later layers). Evidence: [F2-B evidence](docs/F2_B_EVIDENCE.md).

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
```

Health check: `curl http://localhost:4001/api/v1/health`.

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
