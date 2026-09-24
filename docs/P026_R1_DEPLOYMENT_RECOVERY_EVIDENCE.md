# P026-R1 — Deployment recovery and detector integration verification

Assignment: **P026-R1** — post-P026 deployment recovery and detector-interface
verification. Owner: **Mohan**. Agent: **M-D — FreeBuff**. Exclusive write
scope: the main working copy of `auditor-backend` only.

Progress: **follow-up to Mohan assignment 25 / approximately 29; approximately
four further feature batches remain. This follow-up does not mark them
complete.** Review status: **pending** (never self-assigned).

## 0. Starting state

- Branch `main`, clean tree, HEAD `d0fcd092fa39ca17a7efbcdaeffd4e43bd1c2eb1`
  (the P026 feature commit), equal to `origin/main` at start.
- P026's completed outcome is preserved: this is a follow-up layer, **not** a
  re-implementation and **not** a reset. Nothing was rebuilt or discarded.
- Other repositories were treated as read-only: `auditor-frontend` (M-A),
  the separate `auditor-backend` reporting worktree (M-B), `energy-ml-service`
  (M-C) and the simulator repositories.

## 1. Diagnosis — read-only public checks (no change made)

The reported symptom was HTTP **502** on the public auditor API after P026.

| When (IST) | Request | Result |
| --- | --- | --- |
| 2026-09-25 02:10:01 +0530 | `GET /auditor/api/v1/health` | **200**, ~0.25 s, `{"data":{"status":"ok","contract_version":"1.0.1","ml_reachable":true},...}` |
| 2026-09-25 02:10:19 +0530 | `GET /auditor/api/v1/health` (repeat) | **200**, ~0.31 s |
| 2026-09-25 02:10:19 +0530 | `GET /auditor/api/v1/detectors` | **200** — full three-detector catalogue |
| 2026-09-25 02:10:19 +0530 | `GET /auditor/api/v1/imports?page=1&page_size=1` | **200** |
| 2026-09-25 02:10:19 +0530 | `GET /auditor` | **301** (prefix redirect; not a failure) |
| 2026-09-24 20:44:43Z | `GET /auditor/api/v1/health` | **200**, 0.20 s |
| 2026-09-24 20:44:43Z | `GET /auditor/api/v1/detectors` | **200**, 0.17 s |

CORS preflight for the deployed frontend origin
`https://enersave-coral.vercel.app`:

```
OPTIONS /auditor/api/v1/analysis/jobs            -> 204
Access-Control-Allow-Origin:  https://enersave-coral.vercel.app
Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,DELETE,POST
Access-Control-Allow-Headers: content-type
Vary: Origin, Access-Control-Request-Headers
```

### Was the 502 reproduced?

**No.** A single earlier probe in the preceding layer returned 502 on
`/api/v1/health` and `/api/v1/detectors` with `/auditor` still answering 301;
every later probe (the two on 2026-09-25 02:10 and the pair at
2026-09-24 20:44:43Z) returned 200 with a healthy contract response and a live
ML reachability flag.

### Demonstrated cause

**Unknown.** The failure is not reproducible and no causal link to P026 was
established. No restart, redeploy, Nginx, PM2 or VPS action of any kind was
performed by this layer, so no causation is claimed in either direction. The
most likely benign explanations (transient proxy/upstream blip, deployment
overlap) remain unproven and are **not** asserted as fact.

### Recovery actions taken

**None.** The service was healthy at every post-diagnosis probe, and the
instruction is explicit not to restart or redeploy a healthy service.

### Deployed revision — actually observed

The deployed service serves `GET /api/v1/detectors` with the P026 catalogue
(three detectors, `max_section_records: 2000`, `max_findings_per_job: 100000`).
That route only exists in P026 code, so the **P026 revision is deployed**, not
merely pushed. The exact deployed Git hash cannot be read from the public API;
an SSH `git rev-parse HEAD` on the VPS is required to pin it (see §7).

## 2. Public vs local verification

- **Public (read-only):** health 200 with `ml_reachable:true`, detector
  catalogue 200 (identities below), imports route reachable, CORS preflight
  204 for the deployed frontend origin. No dataset was uploaded and no job was
  submitted against the shared production database.
- **Local (isolated scratch data only):** full suite green —
  `npm test` **37/37**, `verify:contract` **75/75**, `validate:schema`
  **24/24**, `typecheck`/`lint`/`build` all exit 0. Real integration harnesses
  `npm run check:detector-http` and `npm run check:analysis-http` both pass
  against pinned committed Python on ephemeral loopback ports with scratch
  SQLite databases. No fixed port, PM2 process or production database was
  touched; no foreign process was stopped.

## 3. Changes made in P026-R1

1. **`test/detectors.test.ts`** — new regression test *"a failed detector job
   still reports its detector identity and persists no findings"*: a queued
   detector job whose Python call fails keeps its `detector.id` on the failed
   status response, surfaces `PYTHON_UNAVAILABLE`, leaks no stack/TypeError/
   Traceback, persists zero findings, and survives a database reopen.
2. **`scripts/check-detector-http.mjs`** — extended (no refactor): vacancy
   default-when-omitted coverage, window-validation rejections
   (`reference_after_evaluation` → 422 on `field: reference_window`; unaligned
   window → 422 matching `/align/`), a **not-assessed vs evaluated-no-findings**
   distinction (`unsupported_aggregation` with `assessment_source:
   auditor_precheck`, 0 findings), and **no invented savings/costs** assertions
   (`totals.avoidable_energy_kwh`, `totals.dataset_cost_inr`, finding
   `avoidable_energy_kwh`/`avoidable_cost_inr` all undefined).
3. **`scripts/check-analysis-http.mjs`** (P015) — Windows portability fix only:
   archive with `git archive --format=tar -o <file>` and extract with a
   relative filename and `cwd: tempRoot`, replacing the previous
   `--format=zip` piped through GNU `tar` that failed here with
   `tar: Cannot connect to C: resolve failed` /
   `tar: This does not look like a tar archive`. This specific pre-existing
   harness breakage is now fixed; the check passes.

No application source, route, migration, contract, configuration or deployment
file was changed. **Only these three files changed**, and the only non-test
change is a harness portability fix — so **no new application release was
required or produced by this layer**.

## 4. Frontend handoff (copyable integration section)

This is the authoritative handoff for `auditor-frontend`. All shapes below are
the actual response shapes; no compatibility variants are invented.

### 4.1 Detector catalogue — `GET /api/v1/detectors`

```json
{
  "data": {
    "detectors": [
      { "id": "vacancy", "label": "Vacant-but-on (contract rule)", "method": "rule",
        "method_version": "vacant-beyond-grace-v1", "technique": null,
        "finding_type": "vacant_but_on",
        "request": { "endpoint": "POST /api/v1/analysis/jobs",
          "body": { "dataset_id": "required", "detector": "vacancy (default)",
                    "from_utc": "optional", "to_utc": "optional" } },
        "section_bounds": null,
        "requirements": ["Readings with matching room intervals; the vacancy grace comes from the applied policy version."] },
      { "id": "excess_consumption",
        "label": "Excess-consumption deviation versus an earlier comparable reference",
        "method": "rule", "method_version": "excess-power-mad-v1",
        "technique": "robust_median_mad", "finding_type": "excess_consumption_deviation",
        "request_format": "excess-power-request-v1",
        "request": { "endpoint": "POST /api/v1/analysis/jobs",
          "body": { "dataset_id": "required", "detector": "excess_consumption",
            "reference_window": { "start_utc": "required", "end_utc": "required" },
            "evaluation_window": { "start_utc": "required", "end_utc": "required" } } },
        "section_bounds": { "device_intervals": 2000, "room_intervals": 2000 },
        "single_evaluation_section": false,
        "requirements": [ "Fully-on intervals only (on_fraction == 1); off, mixed-duty, duty-unknown and partial intervals are excluded.",
          "At least 12 comparable reference intervals spanning at least 2 hours.",
          "Comfort-dependent devices (ac, refrigerator) need room temperature and occupancy context." ] },
      { "id": "gradual_trend",
        "label": "Sustained gradual upward power trend under matched observed conditions",
        "method": "rule", "method_version": "gradual-power-trend-v1",
        "technique": "theil_sen_context_normalised_daily", "finding_type": "sustained_upward_power_trend",
        "request_format": "drift-request-v1",
        "request": { "endpoint": "POST /api/v1/analysis/jobs",
          "body": { "dataset_id": "required", "detector": "gradual_trend",
            "reference_window": { "start_utc": "required", "end_utc": "required" },
            "evaluation_window": { "start_utc": "required", "end_utc": "required" } } },
        "section_bounds": { "device_intervals": 2000, "room_intervals": 2000 },
        "single_evaluation_section": true,
        "requirements": [ "Fully-on intervals only, one resolution and one configuration (policy_ref) per device.",
          "Reference: at least 5 supported days spanning at least 7 days.",
          "Evaluation: at least 10 supported days over at least 14 days with 50% calendar-day coverage; a supported day needs 3 comparable observations and 1 hour fully on." ] }
    ],
    "limits": { "max_section_records": 2000, "max_findings_per_job": 100000 },
    "aggregation": {
      "requested_interval_nominals_seconds": [60, 300, 600, 900, 1800, 3600],
      "semantics": "Stored readings are sent unchanged when they fit the section bound. Otherwise they are aggregated onto requested contract intervals; only bins whose readings are contiguous, non-partial, fully on, under one policy version and covered by room context are sent, and every other bin is reported under excluded_device_bins." },
    "notes": [ "result.status distinguishes findings_detected, evaluated_no_deviation / evaluated_no_gradual_trend, insufficient_reference / insufficient_history, unsupported_context, unsupported_aggregation and no_comparable_observations.",
      "Detector findings are deviations, not confirmed malfunctions or efficiency loss, and are never added to vacancy avoidable-energy totals.",
      "Tariff changes never rerun a detector and add no cost to detector results." ]
  },
  "meta": { "request_id": "<request-id>" }
}
```

### 4.2 Exact POST bodies — `POST /api/v1/analysis/jobs`

Vacancy (unchanged; `detector` omitted or `"vacancy"`):

```json
{ "dataset_id": "auditor-generated-id" }
```
```json
{ "dataset_id": "auditor-generated-id", "detector": "vacancy",
  "from_utc": "2026-01-03T00:00:00Z", "to_utc": "2026-01-05T00:00:00Z" }
```

Excess consumption:

```json
{ "dataset_id": "auditor-generated-id", "detector": "excess_consumption",
  "reference_window":  { "start_utc": "2026-01-01T00:00:00Z", "end_utc": "2026-01-03T00:00:00Z" },
  "evaluation_window": { "start_utc": "2026-01-03T00:00:00Z", "end_utc": "2026-01-05T00:00:00Z" } }
```

Gradual trend:

```json
{ "dataset_id": "auditor-generated-id", "detector": "gradual_trend",
  "reference_window":  { "start_utc": "2026-01-01T00:00:00Z", "end_utc": "2026-01-09T00:00:00Z" },
  "evaluation_window": { "start_utc": "2026-01-09T00:00:00Z", "end_utc": "2026-01-25T00:00:00Z" } }
```

Accepted → `202`:

```json
{ "data": { "job_id": "analysis-job-id", "status": "queued", "detector": "excess_consumption" },
  "meta": { "request_id": "<request-id>" } }
```

Reference must end at or before evaluation starts; both windows must be real
UTC seconds, ordered, inside the dataset export range and aligned to imported
interval boundaries. The `detector` field is required (and the windows are
required) for the two detectors; vacancy keeps its previous request unchanged.

### 4.3 Exact GET job-result nesting — `GET /api/v1/analysis/jobs/:id`

Whole document is `{ data, meta }`. Inside `data`:

- `job_id`, `dataset_id`, `status` (`queued` | `running` | `completed` |
  `failed`), `method`, `method_version`.
- `requested_range`.
- `detector` — the identity block for detector jobs (`id`, `label`, `method`,
  `method_version`, `technique`, `finding_type`, `request_format`). **Absent
  for vacancy jobs.** A failed detector job still carries this block.
- `windows: { reference, evaluation }` — detector jobs only.
- `result` — completed jobs only. For detector jobs it contains:
  - `result.status`, `result.synthetic`, `result.synthetic_label`
  - `result.coverage` — `{ start_utc, end_utc, devices, unsupported_devices,
    detector_calls, max_section_records }`
  - `result.detector_coverage` — `{ evaluation_device_intervals, evaluated,
    flagged, insufficient_reference, excluded, reference_device_intervals,
    reference_usable, reference_excluded }`
  - `result.devices[]` — per device: `device_id`, `room_id`, `device_type`,
    `status`, `assessment_source`, plus `reference` / `evaluation` detail
  - `result.aggregation` — `{ stored_interval_seconds, max_section_records,
    resolutions_by_device, emitted_bins_by_device, excluded_device_bins }`
  - `result.warnings[]`, `result.exclusions[]`, `result.totals`
  - `result.findings[]`
  - `result.findings_pagination`
  - `result.limitations[]`
  - `result.other_changes[]` — **gradual_trend only**
- `error` — **failed jobs only** (`{ code, message }`, see §4.5).
- `created_at`, `completed_at`.

The full worked completed-job example (excess consumption) is in
[AUDITOR_API_EXAMPLES.md](AUDITOR_API_EXAMPLES.md#device-detectors-p026), §4.6.

### 4.4 Findings pagination

- **Location:** `data.result.findings_pagination` = `{ page, page_size, total }`.
  `total` is the full filtered count, not the page count.
- **Meaning:** retrieval-only. Query with `?page=&page_size=` on
  `GET /api/v1/analysis/jobs/:id`; maximum page size is **500**.
- Detector results carry **no cost fields** — do not render savings or costs.

### 4.5 Overall and per-device status

- `result.status` ∈ `findings_detected`, `evaluated_no_deviation`,
  `evaluated_no_gradual_trend`, `insufficient_reference`,
  `insufficient_history`, `unsupported_context`, `unsupported_aggregation`,
  `no_comparable_observations`.
- Per-device `result.devices[].status` and `.reason`; each device also carries
  `assessment_source` ∈ `detector` (Python assessed it) | `auditor_precheck`
  (the auditor could not build a valid request and states the reason).
- **Not assessed is never presented as evaluated with no findings.**
  `unsupported_aggregation` is the auditor's own state and must be rendered
  distinctly from `evaluated_no_deviation` / `evaluated_no_gradual_trend`.
- Exclusions are reported per aggregation under
  `aggregation.excluded_device_bins[device][reason]` with reasons
  `missing_device_readings`, `partial_or_incomplete_readings`, `duty_unknown`,
  `mixed_duty_or_off`, `policy_change`, `missing_room_context`; also surfaced in
  `result.exclusions` / `result.totals.exclusions_total`.
- Warnings live in `result.warnings[]` (e.g. `NOT_A_DIAGNOSIS`,
  `AGGREGATED_INTERVALS`, `NOT_AVOIDABLE_SAVINGS`, and the
  `ANALYSES_NOT_PERFORMED` / `INSUFFICIENT_VACANCY_CONTEXT` /
  `NO_ROOM_INTERVAL` family for vacancy-shaped runs).
- Drift `other_changes[]` carries `abrupt_level_change`,
  `upward_change_not_sustained`, `level_offset_without_trend` — **descriptive
  observations, never findings, never malfunctions.**
- Present all detector output as statistical deviations under stated
  comparability rules — never as confirmed malfunction, efficiency loss or
  guaranteed savings.

### 4.6 Error codes

| Condition | HTTP | Body |
| --- | --- | --- |
| Malformed / non-object body | 400 | `VALIDATION_ERROR`, message |
| Invalid window (shape, non-UTC, unordered, outside export range, unaligned) | 422 | `VALIDATION_ERROR` + `field` (`reference_window`, `reference_window.start_utc`, `evaluation_window`, …) |
| Reference after evaluation | 422 | `VALIDATION_ERROR`, `field: reference_window` |
| Unknown detector | 422 | `VALIDATION_ERROR`, `field: detector` |
| Unknown dataset | 404 | `NOT_FOUND` |
| Queue full (4 queued/running) | 503 | `CONFLICT` |
| Python unavailable | 200 + failed job | `data.error.code: PYTHON_UNAVAILABLE` |
| Python timeout | 200 + failed job | `data.error.code: PYTHON_TIMEOUT` |
| Python malformed reply | 200 + failed job | `data.error.code: PYTHON_MALFORMED` |
| Oversized / upstream rejection | 200 + failed job | `REQUEST_TOO_LARGE`, `INSUFFICIENT_DATA`, `UNSUPPORTED_INPUT`, `UNSUPPORTED_VERSION`, `MODEL_UNAVAILABLE` |
| Interrupted at restart | 200 + failed job | `JOB_INTERRUPTED` |
| Other failure | 200 + failed job | `JOB_FAILED` |

A failed job returns HTTP 200 with `status: "failed"` and
`data.error = { code, message }`; the detector identity (`data.detector`) is
retained on the failed document.

### 4.7 Remaining limitations after recovery

- Python detector accuracy is synthetic-fixture based; the numbers are
  structural integration results, not real-building accuracy.
- A split excess-consumption evaluation can report one finding per batch;
  findings are not merged across requests. Gradual trend is never split.
- Cycling devices may yield few or no fully-on comparable bins and are reported
  as not assessed / `no_comparable_observations` / `insufficient_*`.
- Long windows need coarser requested intervals or fewer devices; the API
  returns the reason and recommends a shorter window.
- Detector results are never priced, and tariff changes never rerun a detector.
- The browser must never call Python directly; only this backend does.
- Browser-witnessed checks of the new statuses remain unverified.

## 5. Verification results (P026-R1)

- `npm test`: **37 passed, 0 failed** (36 + 1 new failure-path test).
- `npm run verify:contract`: **75/75**; `npm run validate:schema`: **24/24**.
- `npm run typecheck` / `npm run lint` (0 errors) / `npm run build`: clean.
- `npm run check:detector-http`: **pass**. Pinned Python
  `a0a86cc5d96b16082d8a1d1b911de7a7d1b2474d`, 7 detector requests, both paths,
  max 1,440 device / 1,440 room records per section; vacancy default works with
  `result.detector` absent; both window-validation rejections 422; not-assessed
  distinct from evaluated-no-findings; no savings/cost fields.
- `npm run check:analysis-http`: **pass** (previously failing on this Windows
  checkout; fixed by the `--format=tar` change above).

## 6. Portability fix scope

`scripts/check-analysis-http.mjs` was the only harness changed beyond the
detector harness, and only to replace `git archive --format=zip | tar` with a
binary-safe `git archive --format=tar -o <file>` plus extraction using a
relative filename and `cwd`. No unrelated test refactoring was introduced.
`.gitattributes` LF rules for the hashed contract paths remain in place
(manifest: 0 hash mismatches, 0 CRLF).

## 7. Remaining diagnostic path (VPS access not exercised)

Public observation proves the deployed service is healthy and running P026, but
the exact deployed Git hash and any historical log evidence of the earlier 502
require server-side read-only inspection, which this layer did **not** perform
(no usable dedicated SSH host alias for the documented `mohan` runtime user was
verified, and speculative access was not attempted). If a future layer is
granted scoped access, the minimal read-only commands are:

```bash
pm2 status                                    # is nexyra-auditor-backend online/restarting?
pm2 logs nexyra-auditor-backend --lines 200   # bounded recent log window
ss -ltnp | grep 19002                         # listener actually bound
git -C /home/mohan/.config/htop/mohan/HACKATHON/auditor-backend rev-parse HEAD
git -C /home/mohan/.config/htop/mohan/HACKATHON/auditor-backend status --short
```

Do not dump `.env`, credential or token files. Do not restart all PM2 apps, do
not run `pm2 kill`, and do not touch GIT-Pipeline or system Node.

## 8. Git and revision record

- Local implementation HEAD (before this layer's commit):
  `d0fcd092fa39ca17a7efbcdaeffd4e43bd1c2eb1`.
- Remote `refs/heads/main` at start:
  `d0fcd092fa39ca17a7efbcdaeffd4e43bd1c2eb1` (matched local).
- Deployed revision: **observed to include P026** (public `/api/v1/detectors`
  catalogue). Exact hash **not** observed — requires the VPS `rev-parse` above.
- Public verification time: 2026-09-25 02:10:01 / 02:10:19 +0530 and
  2026-09-24 20:44:43Z.
- A successful push does not prove a successful deployment. This layer's
  changes are tests plus one harness fix and documentation; **no new
  application release was needed**, so no deployment was triggered manually.

## 9. Files changed (task-owned)

- Created: `docs/P026_R1_DEPLOYMENT_RECOVERY_EVIDENCE.md`.
- Updated: `test/detectors.test.ts`, `scripts/check-detector-http.mjs`,
  `scripts/check-analysis-http.mjs`, `docs/ACTIVE_TASK.md`, `docs/HANDOFF.md`,
  `docs/PROGRESS_LOG.md`, `docs/AUDITOR_API_EXAMPLES.md`.
- Unchanged: application source, routes, migrations 001–003, `contracts/**`,
  `scripts/verify-contract.mjs`, `data/`, environment files, sibling repos.
- No database, upload, log, build output or temporary export was committed.
