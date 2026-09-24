# WORKSPACE_MAP — NEXYRA local layout & conventions

> Shared mapping. Keep consistent across all five repositories.
> F0 verified: 2026-09-24 on Windows 11, parent `K:\NEXYRA` (see evidence report
> for absolute paths; committed docs use portable relative paths only).
> Clone locations may differ on Kishore's laptop — sibling folder names below
> are the contract, not absolute paths.

## 1. Repository URLs and sibling folders

Parent folder contains five independent Git repositories (no monorepo,
no submodules, no parent-level repo):

| Sibling folder       | Git remote (origin, HTTPS)                                      | Branch at F0 | HEAD at F0 |
| -------------------- | --------------------------------------------------------------- | ------------ | ---------- |
| `../simulation-frontend/` | `https://github.com/NEXYRA-Techy-Panda/simulation-frontend.git` | `main` | No commits yet |
| `../simulation-backend/`  | `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git`  | `main` | No commits yet |
| `../auditor-frontend/`    | `https://github.com/NEXYRA-Techy-Panda/auditor-frontend.git`    | `main` | No commits yet |
| `../auditor-backend/`     | `https://github.com/NEXYRA-Techy-Panda/auditor-backend.git`     | `main` | No commits yet |
| `../energy-ml-service/`   | `https://github.com/NEXYRA-Techy-Panda/energy-ml-service.git`   | `main` | No commits yet |

SSH equivalents (`git@github.com:NEXYRA-Techy-Panda/<repo>.git`) are accepted
as the same repository. At F0 all five remotes are empty (clone warns
"You appear to have cloned an empty repository"; `git ls-remote --heads`
returns empty; `git log` reports "does not have any commits yet").

Expected parent layout:

```text
<parent>/                  # e.g. K:\NEXYRA on Mohan's machine; path differs per machine
  simulation-frontend/    # independent repo
  simulation-backend/     # independent repo
  auditor-frontend/       # independent repo
  auditor-backend/        # independent repo
  energy-ml-service/      # independent repo
```

## 2. Repository roles and owners

| Repository | Role | Foundation owner | Long-term owner |
| ---------- | ---- | ---------------- | --------------- |
| `simulation-frontend` | Next.js simulator UI: commands + authoritative-state rendering (SVG/CSS map, clocks) | Mohan (F0–F6 foundation) | Kishore Kumar (after handoff) |
| `simulation-backend` | Node/Express/Socket.IO simulation authority + SQLite persistence | Mohan (F0–F6 foundation) | Kishore Kumar (after handoff) |
| `auditor-frontend` | Next.js auditor UI: upload + charts + report view | Mohan | Mohan |
| `auditor-backend` | Node/Express import validation/persistence + Python calls + analysis APIs | Mohan | Mohan |
| `energy-ml-service` | Python/FastAPI analysis + inference | Mohan | Mohan |

## 3. Planned local ports (proposed, not yet bound)

| Service | Port | Status at F0 |
| ------- | ---- | ------------ |
| simulation-frontend | 3000 | Proposed; no listener observed at F0 |
| simulation-backend | 4000 | Proposed; no listener observed at F0 |
| auditor-frontend | 3001 | Proposed; no listener observed at F0 |
| auditor-backend | 4001 | Proposed; no listener observed at F0 |
| energy-ml-service | 8000 | Proposed; no listener observed at F0 |

Port check at F0: `netstat -ano | Select-String ':3000 |:3001 |:4000 |:4001 |:8000 '`
returned no matches. Do not terminate unrelated processes. If a port is taken
on a developer machine, document the override locally; do not change the
proposed defaults without a contract note.

## 4. Tooling decisions (F0)

### Installed (measured at F0 on Mohan's machine)

- Git: `2.55.0.windows.5`
- Node.js: `v24.21.0` (`C:\Program Files\nodejs\node.exe`)
- npm: `11.19.0`, registry `https://registry.npmjs.org/`
- Python: **not installed** (WindowsApps shims only; `--version` routes to
  Microsoft Store stub). `pip`, `pip3`, `py` not recognised.
- OS/shell: Windows 11 Home Single Language, Build 26200, x64;
  Windows PowerShell 5.1 (`5.1.26100.9444`).

### Recommended (proposal for empty repos)

- Four JS/TS repos: `npm` (ships with Node; no yarn/pnpm unless a repo already
  uses it — none does at F0 because repos are empty).
- `energy-ml-service`: Python `venv` + `pip` + versioned `requirements.txt`
  (finalise exact pins in F2; do not install at F0).
- Node.js: `>=20.9` required (Next.js 15 minimum `18.18.0`; Next.js 16 minimum
  `20.9.0`). Installed `24.21.0` satisfies the minimum.
- Python: `3.12.x` recommended for new FastAPI + pandas + scikit-learn work in
  2026 (scikit-learn requires `>=3.11`; community guidance favours 3.12/3.13).
  Must be installed before F2.

### Compatibility status labels

- **Installed**: measured above.
- **Recommended**: npm workspaces as above; Node `>=20.9`; Python `3.12`.
- **Compatibility verified**: minimum-version gate only — installed Node 24
  satisfies Next.js 15/16 minimums per official docs (checked 2026-09-24);
  `netstat` shows no port conflicts; `git ls-remote --heads` confirms empty
  remotes. No scaffold has been generated, so build-level compatibility is
  **not yet verified**.
- **Not yet verified**: `npm install` / `next build` on Node 24; Python
  `venv` + `pip install -r requirements.txt` + `uvicorn` import; inter-service
  HTTP/Socket.IO paths; SQLite file creation. These belong to F2–F4.

Unresolved questions:

1. Confirm Python `3.12.x` patch + Windows installer source (python.org vs
   Store) before F2.
2. Confirm Node long-term pin for CI (e.g. `22 LTS` vs installed `24`) before F2.
   Recommend adding `.nvmrc` / `engines` in F2, not F0.

## 5. Service connection relationships (planned, not implemented)

- Simulator frontend → simulator backend URL (HTTP + Socket.IO).
  Env-style name (F4 to implement): e.g. `NEXT_PUBLIC_SIMULATION_BACKEND_URL`.
- Auditor frontend → auditor backend URL (HTTP).
  Env-style name (F4 to implement): e.g. `NEXT_PUBLIC_AUDITOR_BACKEND_URL`.
- Auditor backend → private Python-service URL (HTTP, server-side only).
  Env-style name (F4 to implement): e.g. `ML_SERVICE_URL` / `ENERGY_ML_SERVICE_URL`.
- Backend allowed frontend origins (CORS): simulation-backend allows
  simulation-frontend origin; auditor-backend allows auditor-frontend origin.
- SQLite files: separate per Node backend, privately owned; neither backend
  opens the other's file; browsers never open SQLite; auditor frontend never
  calls Python directly.

No working environment files (`.env`) are created at F0. Names above are
proposals only; F4 finalises them. Do not add secrets, local DBs, or private
datasets.

## 6. Workspace instruction notes

- Applicable instructions at F0: no `AGENTS.md` found at parent or in any
  repository (repos empty, only `.git/` present). Re-check before each layer.
- Parent is **not** inside a Git working tree (`git rev-parse --show-toplevel`
  fails with "not a git repository"). Parent must stay a plain folder.
- Preserve all user work; F0 repos were empty so there was nothing to preserve.
- Clone locations may differ on Kishore's laptop: use the sibling folder names
  (`../<repo>/`) in code/docs, never the absolute `K:\NEXYRA` path, except in
  the F0 evidence report.
