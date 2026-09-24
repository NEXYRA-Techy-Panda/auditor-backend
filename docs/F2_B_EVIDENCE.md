# F2_B_EVIDENCE — backend application foundations

Layer F2-B (Agent B; developer Mohan), 2026-09-24. Covers `simulation-backend`,
`auditor-backend` and `energy-ml-service`. The same copy is kept in each of the
three repositories. Commit hashes are reported in the F2-B return report after
push; they are not invented here.

Status: implementation **completed** where the checks below pass. Review
**pending**. F1-R2 (contract 1.0.1) was accepted by the architecture lead
based on supplied evidence. Contract 1.0.1 is the baseline, and `contracts/v1/`
plus `scripts/verify-contract.mjs` were not modified (the manifest hash checks
still pass).

## Starting state

- No `AGENTS.md` (parent or repos). The branches were clean and at the
  expected commits, equal to `origin/main` after fetch:
  sim `f64ee215…`, auditor `8e308654…`, ml `a585d1aa…`.
- Ports 4000/4001/8000 were free at start.

## Runtimes

- Node `v24.21.0`, npm `11.19.0` (engines `>=24.0.0`, `.nvmrc` = 24).
- Python `3.13.15` (64-bit), from
  `C:\Users\vikram\AppData\Local\Programs\Python\Python313\python.exe`, in an
  isolated `energy-ml-service/.venv`; pip `26.2.1`. System PATH untouched.

## Node dependencies (identical in both Node backends, exact pins + package-lock.json)

| Package | Version | Why / compatibility |
|---|---|---|
| express | 5.2.1 | engines node >=18 |
| cors | 2.8.6 | |
| ajv | 8.20.0 | Draft 2020-12 via `ajv/dist/2020` |
| typescript (dev) | 6.0.3 | TS 7.0.2 is `latest`, but typescript-eslint 8.70.1 peer range is `>=4.8.4 <6.1.0` |
| typescript-eslint (dev) | 8.70.1 | engines ^18.18 \|\| ^20.9 \|\| >=21.1 |
| eslint / @eslint/js (dev) | 10.11.0 / 10.0.1 | engines ^20.19 \|\| ^22.13 \|\| >=24 |
| globals (dev) | 17.12.0 | |
| tsx (dev) | 4.23.15 | dev watch + test runner loader (esbuild 0.28.2) |
| @types/express, @types/cors, @types/node (dev) | 5.0.6, 2.8.19, 24.13.6 | @types/node matches the Node 24 runtime |

`npm install` reported 0 vulnerabilities. npm 11 did not run esbuild's
postinstall (the package isn't approved under `allowScripts`). esbuild still
works through its `@esbuild/win32-x64` optional package: tsx dev/test ran
correctly. No install scripts were approved.

## Python dependencies (exact pins)

- `requirements.txt` (runtime): fastapi 0.141.1, uvicorn 0.53.0,
  starlette 1.7.0, pydantic 2.13.5 (pydantic_core 2.46.5), pandas 3.0.6,
  numpy 2.5.3, scikit-learn 1.9.1, scipy 1.18.1, joblib 1.6.0,
  threadpoolctl 3.7.0, plus pinned transitive deps.
- `requirements-dev.txt`: `-r requirements.txt`, pytest 9.1.1, httpx 0.28.1
  (+ transitive; colorama marked `sys_platform == "win32"`).
- There is no CUDA, no deep-learning framework and no model training.

## Formal JSON Schema validation (`npm run validate:schema`, both Node repos)

The validator is Ajv 8.20.0, `Ajv2020` (Draft 2020-12), `strict: true`,
`allErrors: true`. The schema has no `format` keyword, so no format plugin is
needed. Source `scripts/validate-schema.mjs` is byte-identical in both repos.
Each negative check mutates an in-memory deep copy and must fail with the
expected keyword at the expected instance path. **Result: 24 passed, 0 failed
(exit 0) in both repos.**

- Positive: declares 2020-12; valid against the meta-schema; compiles in
  strict mode; `reference.json` validates; an in-memory variant with valid
  `device_schedule` + `occupancy` policies validates.
- Rejected, missing required fields: top-level `run`,
  `device_intervals[0].energy_kwh`, `room_intervals[0].occupied_fraction`,
  office_hours `rules.overnight`.
- Rejected, unknown interval fields: an extra device-interval field, an extra
  room-interval field, and device-interval `fault_active`.
- Rejected, invalid fractions: `on_fraction` 1.5 and −0.1, `occupied_fraction`
  1.01, and `occupied_fraction` as a string.
- Rejected, unknown policy-rule fields: all five kinds (office_hours,
  lighting_schedule, always_on, device_schedule, occupancy).
- Rejected, policy-rule `fault_active`: lighting_schedule and always_on.
- Rejected: `schema_version` "1.0.0" (const).
- **No contract defect found.** The schema compiles under Ajv strict mode
  without relaxing any option.
- Not claimed: JSON Schema does not check cross-record arithmetic, foreign keys
  (device→room, policy_ref, office_hours_ref), uniqueness or contiguity. Those
  remain the semantic checks in `verify-contract.mjs`.

## Existing contract verifier

`npm run verify:contract` (Node repos) or `node scripts/verify-contract.mjs`
(ml) → **75 passed, 0 failed** in all three repos. This includes the
manifest hashes of the unmodified contract files.

## Node checks (each backend)

| Script | simulation-backend | auditor-backend |
|---|---|---|
| typecheck (`tsc --noEmit`) | exit 0 | exit 0 |
| lint (`eslint .`) | exit 0 | exit 0 |
| test (`tsx --test`, node:test, real HTTP on an ephemeral port) | 7 pass / 0 fail | 7 pass / 0 fail |
| build (`tsc -p tsconfig.build.json`) | exit 0 | exit 0 |

## Python checks

- `.venv\Scripts\python.exe scripts\check_env.py` → Python 3.13.15 from the
  venv, all imports OK, exit 0.
- `pip check` → "No broken requirements found." (exit 0).
- `python -m pytest -q` → 8 passed (1 warning: Starlette recommends `httpx2`
  over `httpx` for TestClient; it is only a deprecation notice).
- Reproducibility: a fresh venv from `requirements-dev.txt` installed with
  exit 0, `pip check` was clean, and its `pip freeze` was identical to the
  working venv.
- Environment incident: pandas first failed with "DLL load failed while
  importing parsing: An Application Control policy has blocked this file"
  (Windows Smart App Control). Mohan changed the Windows setting. The re-test
  passed (numpy, scipy, scikit-learn and pandas import; a 3-row in-memory
  sanity check ran and nothing was saved). Other Windows machines with Smart
  App Control on may hit the same block.

## Live HTTP verification (real network servers)

Started 2026-09-24 19:35:49 +05:30 (IST), each on its assigned port, bound to 127.0.0.1:

- `node dist/server.js` in simulation-backend → PID 8184, port 4000.
- `node dist/server.js` in auditor-backend → PID 21296, port 4001.
- `.venv\Scripts\python.exe -m app` in energy-ml-service → launcher PID
  15116, which started interpreter PID 9456 on port 8000.

Checked with `curl -i` against `localhost`:

```text
GET http://localhost:4000/api/v1/health  (Origin: http://localhost:3000) → 200
  Access-Control-Allow-Origin: http://localhost:3000
  {"data":{"status":"not_initialized","run_id":null,"sim_time_utc":null,"contract_version":"1.0.1"},"meta":{"request_id":"d5eee364-0864-4adc-bca2-959b123d442a"}}
GET http://localhost:4000/api/v1/nope → 404
  {"error":{"code":"NOT_FOUND","message":"No route for GET /api/v1/nope"}}
POST http://localhost:4000/api/v1/health  body "{bad" → 400
  {"error":{"code":"VALIDATION_ERROR","message":"Request body is not valid JSON"}}

GET http://localhost:4001/api/v1/health  (Origin: http://localhost:3001) → 200
  Access-Control-Allow-Origin: http://localhost:3001
  {"data":{"status":"ok","contract_version":"1.0.1","ml_reachable":"not_checked"},"meta":{"request_id":"d723ad97-8e15-423f-91bd-a7254930bae7"}}
GET http://localhost:4001/api/v1/nope → 404
  {"error":{"code":"NOT_FOUND","message":"No route for GET /api/v1/nope"}}
POST http://localhost:4001/api/v1/health  body "{bad" → 400
  {"error":{"code":"VALIDATION_ERROR","message":"Request body is not valid JSON"}}

GET http://localhost:8000/health → 200
  {"data":{"status":"ok","model_available":false},"meta":{"request_id":"7d23371e-b179-4bdf-b066-76fdb2234a49"}}
GET http://localhost:8000/v1/model/info → 200
  {"data":{"model_available":false,"model_version":null,"baseline_version":null,"contract_version":"1.0.1"},"meta":{"request_id":"4d368267-4a20-487b-b85b-04f6fd52b948"}}
POST http://localhost:8000/v1/analyze → 404
  {"error":{"code":"NOT_FOUND","message":"No route for POST /v1/analyze"}}
GET http://localhost:8000/docs → 404
  {"error":{"code":"NOT_FOUND","message":"No route for GET /docs"}}
```

All four PIDs were then stopped with `Stop-Process`, and afterwards no process
was listening on 4000/4001/8000. **No services are left running.** The 413
`REQUEST_TOO_LARGE` path is covered by the in-process HTTP tests (1 kb limit).

## Contract ambiguities (reported; contract not modified)

1. **`CONTRACT.md` §1** still says `schema_version: "1.0.0"`, while the
   schema `const`, fixtures and manifest say `1.0.1`. This is a documentation
   inconsistency. The validator follows the schema (1.0.0 is rejected).
2. **No error code for unexpected server faults.** The API.md "stable codes"
   list has none for them, so the scaffolds use `INTERNAL_ERROR` (HTTP 500).
3. **Python envelope.** API.md's cross-cutting success envelope is applied to
   Python responses too (`{data, meta:{request_id}}`). The Python table shows
   bare payloads.
4. **`/v1/model/info` uninitialised shape** is unspecified. The scaffold
   returns `model_version: null`, `baseline_version: null`,
   `contract_version: "1.0.1"`, plus an added `model_available: false`, with
   HTTP 200. It returns no `MODEL_UNAVAILABLE` error because that code is for
   analyze/forecast calls.
5. **Request id on errors.** The error envelope has no `meta`, so the request
   id is sent in the `X-Request-Id` header on every response.
6. **Pre-engine simulator health** returns HTTP 200 (the service is
   reachable), with the engine state carried in `data.status`.

## Not verified

- **Graceful shutdown** (SIGINT/SIGTERM → `server.close`, forced close after
  `SHUTDOWN_TIMEOUT_MS`; uvicorn's own handling) was not exercised live.
  Windows `Stop-Process` is a hard terminate. Ctrl+C in an interactive
  terminal exercises that path.

## Deliberately not implemented

No database or migrations, inventory, simulation state, Socket.IO, upload
handlers, analysis jobs, forecasting, `/v1/analyze` or `/v1/forecast`,
interservice calls (auditor→Python), model training, deployment, or
firewall/proxy changes. The frontends were not touched or probed.

## Next layer

F3, pending its assigned prompt.
