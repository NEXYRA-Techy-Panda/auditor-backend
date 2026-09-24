# P028-BACKEND — evidence-backed report economics API

Developer Mohan | Agent M-B — Codex | P028-BACKEND | Review pending

## Implementation

Integrated prepared pure module `src/reporting/economics.ts` and added
`POST /api/v1/reports/preview`. The route is additive and read-only. It uses
the existing `datasets`, `analysis_jobs`, `findings`, and
`user_tariff_settings` tables; no migration, report history, telemetry contract
change, frontend source, Python call, analysis rerun, or production request was
added. A synchronous deferred SQLite read transaction snapshots dataset
metadata, job identity/status/method, selected finding JSON and the current
local tariff together.

Request `finding_ids` are the existing stable `finding_id` values returned
inside analysis results, not page positions or storage keys. The backend
resolves each ID within the requested job and dataset. The route accepts at
most 50 unique IDs, requires the dataset/job relationship, a completed
`analysis` job using
`rule` / `vacant-beyond-grace-v1`, and supported vacancy findings with finite
persisted `avoidable_energy_kwh` and `observed.unit === "kWh"`. Client fields
outside `dataset_id`, `job_id`, `finding_ids`, and `economics` are rejected.
The JSON parser applies the existing 100 KiB request limit.

Evidence comes from the imported dataset (run ID, export coverage and synthetic
provenance), persisted job (completion, detector/method version), and selected
finding (device/room, UTC window, assumptions, resolution limit, and supported
avoidable energy). Forecasts, historical rows, excess-consumption and trend
findings cannot be selected as savings evidence. Tariff is read from the
current saved local tariff in INR; unset remains `null`, zero stays `0`.

## Economics and limitations

All calculations call the prepared module. Without supplied economics, each
finding stays on its observed window; values are never annualized. Missing
tariff/energy is unavailable; ROI requires known implementation cost, and
payback requires a separately supplied gross recurring INR/month rate. Optional
economics values are finite/nonnegative, cost periods must be paired, explicit
projection days/months must be paired at 30 days per month, and extrapolation
requires a source-period match plus written assumption. User inputs are labeled
as assumptions. Recurring cost is passed once through the module. Rankings use
its comparability rules; overlapping selected device/time claims remain
individual, are disclosed, and are excluded from ranking rather than summed.
No persisted external-input fingerprint proves matched scenarios, so the
response always marks scenario comparison `unverified`.

## Verification

Main worktree SQLite capability was confirmed with the installed
`better-sqlite3` opening `:memory:` and returning SQLite 3.53.4. This is a
scratch in-memory database; no production DB was opened. A real Express route
was exercised over loopback HTTP against scratch SQLite fixtures. Tests check
the 0.01 kWh × ₹10 = ₹0.10 answer, unavailable ROI/payback, missing and zero
tariff distinction, explicit economics, overlap exclusion, wrong dataset/job,
unsupported finding/job, rejected caller-supplied evidence/price, 50-ID limit,
and unchanged dataset energy and job count after preview. This fixture check
does not invoke a real Python analysis job; it seeds the completed persisted
job/finding rows and then verifies the actual database-backed API route.

Commands and outcomes (Windows main worktree):

```text
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('select sqlite_version() as version').get()); db.close();"
                                                                         PASS, SQLite 3.53.4
node_modules/.bin/tsx.cmd --test test/reports.test.ts                   PASS, 3/3
npm test                                                               PASS, 59/59
npm run typecheck                                                     PASS
npm run lint                                                          PASS
npm run build                                                         PASS
git diff --check                                                      PASS
```

No native toolchain was installed, no dependency was upgraded, and the
prepared worktree's `node_modules` was not copied. No service, production
preview, benchmark, training, or deployment action was run.

## Frontend handoff and next action

`docs/AUDITOR_API_EXAMPLES.md` contains exact no-assumptions and explicit
assumptions requests, a successful response shape, errors, and measured /
derived / assumed provenance. Key nesting is
`data.recommendations[].evidence`, `data.recommendations[].economics`,
`data.ranking.{ranked_ids,unranked_ids,overlap_conflicts}`,
`data.overlap_conflicts[]`, and `data.scenario_comparison`. Finding IDs are
stored `<job-id>:<finding-id>` strings; energy is kWh, monetary values INR,
tariff INR/kWh, periods days/months, ROI percent, payback months.

The merge preserved P026-R1's docs, harness changes, and failed-job regression;
the prepared branch/worktree remains intact. Feature/merge commit
`c5db138d437280c77ae90c488ac067f8720b446e` is both local `main` and the
observed `origin/main` hash (`git ls-remote origin refs/heads/main`). This
confirms Git publication only. No production preview or deployment check was
performed; review remains pending. Exact next action: M-A wires
`POST /api/v1/reports/preview` into the existing
report UI using these examples, then separately verifies print output and
matched-scenario comparison only after external-input provenance exists.

“Backend reporting integration complete only if verified; frontend wiring,
print verification and matched-scenario comparison remain separate.”
