# P006 F5-A — Auditor file import and reference-data evidence

Date: 2026-09-24. Agent C — Codex. Owner: Mohan. Implementation complete;
review pending.

## Scope and baseline

Only `auditor-backend` was changed. Baseline was accepted P003 commit
`aa53d0c190ec9295354d34cb432a810144c79345`, clean on `main` and equal to
`origin/main` after fetch. No applicable AGENTS.md was found. Contract 1.0.1,
`contracts/v1/`, the formal schema, CSV documentation and contract verifier
were left unchanged. Health still responds with `ml_reachable: not_checked`.

## HTTP API

Every successful response uses `{ "data": ..., "meta": { "request_id": ... } }`.

### `POST /api/v1/imports`

Send one multipart file under field `file`, named `.csv` or `.json`.

First import:

```json
HTTP 201
{
  "data": {
    "dataset_id": "<auditor-generated-id>",
    "run_id": "run-fixture-001",
    "status": "accepted",
    "already_imported": false,
    "report": { "errors": [], "warnings": [], "duplicates_deduped": 0, "additional_errors": false }
  },
  "meta": { "request_id": "<request-id>" }
}
```

Equivalent repeat (including equivalent CSV/JSON): HTTP 200, same
`dataset_id`, `status: "already_imported"`, `already_imported: true`. The
`report` reports identical duplicates removed from this upload.

Semantic conflict for an existing `(source, run_id, export_id)` identity:

```json
HTTP 409
{ "error": { "code": "CONFLICT", "message": "Export identity conflict: semantic content differs from the stored dataset" } }
```

Validation errors use HTTP 400 for malformed transport/file syntax and 422 for
schema or semantic invalidity. Example:

```json
HTTP 422
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Uploaded dataset failed validation",
    "field": "device_intervals[0].energy_kwh",
    "details": {
      "errors": [{ "field": "device_intervals[0].energy_kwh", "message": "Does not reconcile with average power and duration (1e-9 kWh tolerance)" }],
      "warnings": [], "duplicates_deduped": 0, "additional_errors": false
    }
  }
}
```

Where CSV source records are known, both the first error and its detail include
the CSV record row. Reports are capped at 100 errors and expose
`additional_errors` when semantic validation found more than that.
Unsupported schema versions use HTTP 422 and `UNSUPPORTED_VERSION`. Upload/file
limits use HTTP 413 and `REQUEST_TOO_LARGE`.

### `GET /api/v1/imports`

Returns an array of `{ dataset_id, run_id, scenario_id, interval_seconds,
imported_utc }` under `data`.

### `GET /api/v1/imports/:id/summary`

Returns persisted interval energy, nullable tariff-derived cost and rate,
coverage timestamps/counts and `gaps`. With no tariff, `cost_inr` and
`tariff_inr_per_kwh` are `null`; no implicit price is supplied. Example after
setting ₹10/kWh on the reference export:

```json
{
  "data": {
    "dataset_id": "<id>", "energy_kwh": 0.03, "cost_inr": 0.3,
    "tariff_inr_per_kwh": 10,
    "coverage": {
      "start_utc": "2026-09-21T03:30:00Z", "end_utc": "2026-09-21T03:32:00Z",
      "device_intervals": 4, "room_intervals": 4
    },
    "gaps": []
  },
  "meta": { "request_id": "<request-id>" }
}
```

The energy total is `SUM(device_intervals.energy_kwh)`, never cumulative
counters. A tariff only changes the stored local tariff setting.

### `PUT /api/v1/imports/:id/tariff`

JSON body `{ "inr_per_kwh": 10 }`; finite and nonnegative only. Current
single-installation user key is `local`. Success: HTTP 200 with
`{ "dataset_id": "<id>", "inr_per_kwh": 10 }`. Missing dataset: 404. Invalid
rate: 422. It leaves dataset ID, readings, and fingerprint unchanged.

## Limits and file handling

- `UPLOAD_MAX_BYTES`: default 512 MiB; configurable from 1 byte to 1 GiB.
- Exactly one multipart file in field `file`; no multipart text fields.
- Maximum 900,000 CSV data rows. The 31-day one-minute 18-device case has
  803,520 rows.
- Maximum 1,100,000 JSON device intervals and 250,000 room intervals. The
  matching 31-day five-room case has 223,200 room intervals.
- Metadata envelope is at most 8 MiB; CSV parser record bound is 16 MiB.
- CSV parser is exact-pinned `csv-parse` 7.0.2 and runs on Node streams. It
  handles RFC 4180 quoting, LF/CRLF and optional UTF-8 BOM. UTF-8 is validated
  with a fatal decoder. CSV rows are converted directly into bounded
  normalized records; the complete CSV text and a complete parsed-row copy
  are not retained.
- Exact-pinned `multer` 2.4.0 uses disk storage in a generated directory under
  the OS temp directory. It does not use the supplied filename as a path.
  Handled success and error paths remove the entire request directory.
- Canonical JSON is byte-bounded, UTF-8/BOM checked, parsed once and interval
  bounded before normalization/storage.

## CSV reconstruction and validation

CSV is standalone. Header names/order must equal the 27-column contract. The
first data row carries one complete quoted JSON envelope in `meta_run`;
subsequent cells must be empty. Scalar run/building/scenario fields must agree
with the envelope. Inventory and policy definitions come only from that
envelope. Device intervals are built from scalar columns; repeated room
interval data is keyed by `(run_id, room_id, interval_start_utc)` and must be
identical. There is no paired JSON, seed inventory, or runtime fixture read.

Ajv Draft 2020-12 structural validation is followed by semantic validation for
real calendar-valid UTC timestamps, export/run ranges, exact metadata and
interval references, policy applicability/effective time, duplicate conflicts,
duration/boundary equality, overlaps/gaps/coverage, device-room consistency,
room occupancy versus capacity, measurement/schema bounds, max versus average,
duration/fraction bounds, interval energy formula, counter reconciliation and
forbidden fault-label fields. Identical duplicate records are removed and
reported before persistence/fingerprinting; missing rows are never fabricated
as zero. Every rejected upload is validated before `storeDataset()` is
called.

## Semantic fingerprint

SHA-256 is computed from deterministic JSON serialization streamed into the
hash (there is no full canonical JSON copy of the month-size dataset). Object
keys are sorted recursively. Nested arrays are sorted by canonical element
content; top-level inventory, policy, room-interval and device-interval arrays
are first deduplicated and sorted by stable IDs/interval keys.

Excluded from the fingerprint:

- Export identity fields: root `source`, `run.run_id`, each interval's
  `run_id`, and `export.export_id` (database identity remains
  `(source, run_id, export_id)`).
- Incidental annotations/timing: root `created_note` and
  `export.created_utc`.
- File/transport facts: CSV versus JSON, file SHA-256, BOM, line endings,
  quoting, whitespace and JSON object-key order.
- User tariff settings.

Included: schema version, scenario and comparison IDs, run start, export
coverage/resolution, building and timezone, synthetic flag/label, all room and
device metadata, complete policies, and every deduplicated interval value.
Thus changes to readings, inventory, policies, or coverage change the digest;
array/key reordering and equivalent CSV/JSON transport do not.

## Verification

| Command/check | Result |
|---|---|
| `npm run verify:contract` | 75 passed, 0 failed |
| `npm run validate:schema` | 24 passed, 0 failed (Ajv 8.20.0, Draft 2020-12 strict) |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 10 passed, 0 failed |
| `npm run build` | Passed |
| `npm run check:import-http` | Actual server on 127.0.0.1:4001; first import 201, JSON repeat 200, CSV equivalent repeat 200, listing one row, summary 0.03 kWh, tariff update HTTP 200, cost ₹0.30; temporary DB removed |
| `npm run check:import-scale` | Actual server on 127.0.0.1:4001; 201; 133,304,273-byte generated CSV; 803,520 device intervals and 223,200 room intervals; upload plus validation/storage/summary 66 s; summary 93.74400026784001 kWh |

The final-code month-size check was generated to an OS temporary file and was
not committed. A mid-run server working-set sample was 838,115,328 bytes
(approximately 799 MiB); this is an observed sample, not a peak memory
guarantee. Harness RSS after completion was 196,096,000 bytes. The script
stops only its child server and removes its temporary file and database. Both
real-server checks exited successfully; process/temp cleanup and port status
were checked after completion.

Focused integration checks additionally verified JSON multipart import,
standalone CSV import, CSV/JSON identity parity, reordered arrays/object keys,
identity fields excluded from fingerprint, exact duplicate deduplication,
conflict 409, missing/multiple/malformed CSV metadata errors, room conflicts,
unknown device/policy references, invalid calendar timestamp, energy mismatch,
forbidden fault label, unsupported version, malformed JSON, multiple-file and
byte-limit rejection, no persisted table changes after rejected imports,
tariff independence and interval-based summary.

## Setup and next action

```sh
npm ci
npm run db:migrate
npm run dev
npm run verify:contract
npm run validate:schema
npm run typecheck
npm run lint
npm test
npm run build
npm run check:import-http   # needs free port 4001; disposable temp DB
npm run check:import-scale  # needs free port 4001; build first; 66 s observed
```

`DATABASE_PATH` and `DATABASE_BUSY_TIMEOUT_MS` configure SQLite.
`UPLOAD_MAX_BYTES` configures file size up to 1 GiB. P006 adds no Python calls,
analysis, forecast, report, or frontend functionality. Next action after
publication: pass the API and fingerprint/validation decisions to the next
assigned auditor integration task. Review remains pending.

## Commit and remote

Implementation commit `3154e78493a0b310d58dd1101b5ccc337e64b0fb` was pushed
to `origin/main` without force. Immediately after push, `git ls-remote
origin refs/heads/main` and local `git rev-parse HEAD` both returned that hash;
the tree was clean, port 4001 had no listener, and task-owned temporary
resources were removed. Review remains pending.
