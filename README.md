# auditor-backend

Auditor API for the NEXYRA commercial-building energy simulation and auditing
project.

- **Role**: Node.js + Express + TypeScript + SQLite service for import
  validation/persistence, analytics, tariff handling, forecasts (via Python),
  comparison, and report data. Calls `energy-ml-service` server-side.
- **Owner**: Mohan.
- **Local port (proposed)**: `4001`. Python service: `http://localhost:8000`.
- **State at F0 (2026-09-24)**: empty repository — documentation only, no code.
  See `docs/HANDOFF.md` for verified state.

Docs:

- [Project context](docs/PROJECT_CONTEXT.md)
- [Workspace map](docs/WORKSPACE_MAP.md)
- [Handoff](docs/HANDOFF.md)
- [Agent start prompt](docs/AGENT_START_PROMPT.md)
- [Active task](docs/ACTIVE_TASK.md)
- [Progress log](docs/PROGRESS_LOG.md)
- [F1 evidence](docs/F1_EVIDENCE.md)
- [Data contract v1](contracts/v1/CONTRACT.md)
- [Service interfaces](contracts/v1/API.md)
