# PROJECT_CONTEXT — NEXYRA Commercial-Building Energy Simulation & Auditing

> Shared context. This file must stay consistent across all five repositories.
> Last verified (F0): 2026-09-24. No application code exists yet at F0.

## 1. Product purpose

NEXYRA is a commercial-building energy simulation and auditing project with two
user-facing products sharing an MVP1 file-handoff workflow:

- **Simulator**: model a small office (5 rooms, 18 devices/device groups, up to
  20 occupants) over simulated time, render authoritative backend state live,
  and export telemetry as CSV/JSON.
- **Auditor**: ingest an exported Simulator file (upload only in MVP1), validate
  and persist it, run office/room/device analytics plus forecasts, compare
  original vs improved datasets, and produce a printable monthly report.

There is **no live simulator-to-auditor connection in MVP1**. The only bridge is
the user-exported file: Simulator backend → CSV/JSON export → user upload →
Auditor frontend → Auditor backend → Python analysis service.

## 2. Five-repository architecture

All repositories are independent Git repositories, siblings under one parent
workspace folder. No monorepo, no submodules, no sixth parent-level repository.
Each repository has its own deployment pipeline and hosting configuration
(eventually).

| Sibling folder       | Remote                                                          | Stack (planned)                              | Role |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------- | ---- |
| `simulation-frontend/` | `https://github.com/NEXYRA-Techy-Panda/simulation-frontend.git` | Next.js, React, TypeScript, Tailwind, SVG/CSS map | Sends commands, renders authoritative backend state |
| `simulation-backend/`  | `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git`  | Node.js, Express, TypeScript, Socket.IO, SQLite | Owns simulation time, occupancy, schedules, device states, readings, persistence |
| `auditor-frontend/`    | `https://github.com/NEXYRA-Techy-Panda/auditor-frontend.git`    | Next.js, React, TypeScript, Tailwind, charts | Uploads files, displays analysis |
| `auditor-backend/`     | `https://github.com/NEXYRA-Techy-Panda/auditor-backend.git`     | Node.js, Express, TypeScript, SQLite | Validates/persists imports, calls Python, serves analysis/report data |
| `energy-ml-service/`   | `https://github.com/NEXYRA-Techy-Panda/energy-ml-service.git`   | Python, FastAPI, pandas, scikit-learn | Analysis and model inference |

Responsibility boundaries (normative):

- Simulator backend owns simulation time, occupancy, schedules, device states,
  readings and persistence.
- Simulator frontend sends commands and renders authoritative backend state.
- Auditor frontend uploads files and displays analysis.
- Auditor backend validates/persists imports, calls Python and serves
  analysis/report data.
- Python handles analysis and model inference.
- Each Node backend owns a separate SQLite database.
- Neither backend directly opens the other backend's database.
- Browser clients do not access SQLite.
- Auditor frontend does not call Python directly.

MVP1 data flow:

```text
Simulation frontend ↔ simulation backend (Socket.IO + HTTP)
Simulation backend → CSV/JSON export (download)
User uploads export → auditor frontend → auditor backend (HTTP)
Auditor backend ↔ Python analysis service (HTTP, private)
Auditor backend → auditor frontend results (HTTP)
```

## 3. Developer ownership

- **Mohan** initially prepares all five repositories, contracts, database
  foundations and basic connections (F0–F6 foundation).
- After the foundation handoff, **Kishore Kumar** owns
  `simulation-frontend` and `simulation-backend`.
- **Mohan** continues `auditor-frontend`, `auditor-backend` and
  `energy-ml-service`.

For simulator repositories, Mohan establishes the initial foundation before
handing implementation to Kishore. The repository `docs/HANDOFF.md` determines
which foundation layers are actually complete.

## 4. Confirmed MVP1 scope

### 4.1 Simulator

Five rooms and eighteen devices/device groups:

- Open workspace: lighting zones A and B, AC, fan, workstation group.
- Meeting room: lighting group, AC, projector.
- Pantry/dining: lighting group, fan, refrigerator, microwave.
- Reception: lighting group, fan, reception computer.
- Manager's cabin: lighting group, AC, computer.

Features:

- Up to 20 occupants.
- Automatic room allocation when total occupancy changes.
- Manual and scheduled occupancy modes.
- Working days and office opening/closing hours.
- Simple scheduled redistribution between rooms.
- Dots representing occupants.
- Lighting/device schedules.
- Vacancy grace periods.
- Always-on exceptions.
- Manual overrides.
- Room temperature/humidity controls.
- Simplified environmental behaviour.
- Analogue and digital clocks showing the same backend simulation time.
- Speeds: 1×, 2×, 10×, 60×, 100×, 1000×.
- Initial internal step: ten simulated seconds.
- Permanent measurement aggregation: one simulated minute.
- Calendar-month/custom-range batch history generation.
- Export intervals: 1, 5, 10, 15, 30 and 60 minutes.
- CSV/JSON export.
- Socket.IO reconnection through sequence handling, recent replay where
  available, and snapshot/history fallback.
- Selected fault controls, with detailed scenarios finalised later.
- Matched original/improved scenario generation.

### 4.2 Auditor

- CSV/JSON upload only.
- Validation, preview, deduplication and persistence.
- Office/room/device analytics.
- Weekday and schedule analysis.
- Editable flat electricity tariff in ₹/kWh.
- Independent waste/anomaly findings.
- Next-day, next-week and next-calendar-month forecasts.
- Original/improved dataset comparison.
- Printable monthly report.

### 4.3 Engineering invariants (normative for all layers)

- Power is W or kW; energy is kWh.
- Energy integrates over simulated elapsed time.
- Voltage/current are not cumulative consumption.
- Device voltages are not summed into office voltage.
- Device, room and office energy totals reconcile.
- Store UTC timestamps; interpret building calendars in Asia/Kolkata.
- Reset creates a new simulation run.
- Missing readings are not zero consumption.
- Aggregation preserves energy.
- Injected-fault labels never enter auditor inputs or normal telemetry exports.
- Fault-control commands may go to the simulator backend.
- Original/improved scenarios reuse the same occupancy/environment timeline.
- Synthetic results and simulated savings are explicitly labelled.
- Model evaluation preserves time order.
- Model selection depends on measured validation results.

### 4.4 Deferred features (do NOT implement in MVP1)

- Auditor live mode.
- Job-based autonomous occupant behaviour.
- Realistic thermal/electrical physics.
- Elaborate animations.
- Among Us-style doodle occupants: MVP3.
- Real sensor/BMS integration.
- Advanced tariffs.
- Product pricing discussion.

## 5. Foundation sequence

- **F0: repository setup and mapping.** Clone/layout, tool/port conventions,
  shared context, per-repo handoff, onboarding prompts. No scaffolding,
  no dependencies, no schemas, no features.
- **F1: shared contract.** Telemetry/API contract (deferred finalisation at F0;
  implemented in F1).
- **F2: application scaffolds.** Per-repo framework scaffolds only.
- **F3: database migrations and seeds.** SQLite foundations per Node backend.
- **F4: basic connections.** Frontend↔backend, auditor backend↔Python health paths.
- **F5: reference-data integration.** Rooms/devices/schedules reference data.
- **F6: verified handoff.** End-to-end foundation verification for owner transfer.

F0 excludes everything in F1–F6. See `docs/HANDOFF.md` for per-repository state.

## 6. Conventions (F0 proposal, not yet implemented)

- Package manager: `npm` for the four JS/TS repositories.
- Python service: `venv` + `pip` + versioned `requirements.txt`.
- Local ports (proposed): simulation-frontend `3000`, simulation-backend `4000`,
  auditor-frontend `3001`, auditor-backend `4001`, energy-ml-service `8000`.
- SQLite: one file per Node backend, owned privately (paths finalised in F3).
- Config relationships: simulator frontend → simulator backend URL; auditor
  frontend → auditor backend URL; auditor backend → private Python-service URL;
  backends allow their paired frontend origins. No working env files at F0.

See `docs/WORKSPACE_MAP.md` for full mapping, tooling evidence, and status
labels (Installed / Recommended / Compatibility verified / Not yet verified).
