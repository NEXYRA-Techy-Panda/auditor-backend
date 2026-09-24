# CSV representation — contract v1.0.0 (F1-R1 corrected)

A single CSV file is a complete standalone export: it supports a fresh auditor
database with no paired JSON file and no preloaded simulator inventory. JSON
remains the canonical structured representation; both describe identical content.

## Encoding and framing

- UTF-8 without BOM, LF line endings, one header row, RFC 4180 quoting: fields
  containing commas, quotes, or newlines are wrapped in double quotes with
  internal quotes doubled. A JSON envelope inside a quoted cell therefore
  appears with every `"` doubled (`{""schema_version"":""1.0.1"",…}`).
- Numbers use decimal dots (kWh values up to 12 decimal places, power values
  up to 9 decimal places; trailing zeros not required). Booleans are lowercase `true`/`false`. Null (absent optional
  value, or a blank metadata cell) is an empty unquoted field — never the
  strings `null`, `NaN`, or `-`.

## Exact header (27 columns, this order)

```text
run_id,building_id,scenario_id,interval_start_utc,interval_end_utc,interval_seconds,room_id,room_occupancy_avg,room_occupancy_max,room_occupied_fraction,room_temp_c,room_rh_pct,device_id,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_ref,partial,meta_run
```

There is no `meta_policy` column. Per-row policy applicability travels in the
scalar `policy_ref` (`<policy_id>:<version>`), resolved against the envelope.

## Row grain and repetition

- One row per device interval, ordered by `interval_start_utc`, then `device_id`.
- Room interval summaries (`room_occupancy_avg … room_rh_pct`) repeat on every
  device row of that room and interval. The importer groups by
  `(run_id, room_id, interval_start_utc)` and requires identical room values;
  conflicting repeats are an error.
- Scalar run/building columns (`run_id`, `building_id`, `scenario_id`) repeat
  per row and must agree with the envelope.

## The metadata envelope (first data row only)

- `meta_run` carries a complete metadata envelope **on the first data row
  only** and is **empty on every subsequent row**. This avoids repeating the
  inventory and policy definitions hundreds of thousands of times while keeping
  the file self-contained.
- The envelope is a JSON object with: `schema_version`, `source`, `synthetic`,
  `synthetic_label`, `building` (id, name, timezone), `run` (id, scenario,
  comparison, start), `export` (id, start, exclusive end, nominal interval,
  creation time), the full `rooms[]`, `devices[]`, and `policies[]`
  (immutable versioned definitions) covering the export.
- Envelope errors (all abort the import with no partial write):
  missing envelope (no non-empty `meta_run`), more than one non-empty
  `meta_run`, envelope on any row other than the first, unparseable envelope
  JSON, envelope `schema_version` unsupported, unknown `device_id`/`room_id`/
  `policy_ref` on any row, scalar IDs disagreeing with the envelope.
- An arbitrary CSV slice lacking its metadata envelope is **not** a valid
  standalone export and must be rejected; slices are a presentation concern,
  never an interchange unit.
- No fault labels or expected diagnoses appear in the envelope (see
  CONTRACT.md §7).

## Completeness and coverage

- The file preserves inventory, calendar/policy versions, room + device
  interval readings, and provenance/time range. Policy metadata is never
  dropped; the auditor never assumes preloaded inventory.
- Coverage rule: aligned interval grid with exactly one row per exported device
  per interval. Absent rows are gaps and fail validation. The exporter meets
  this by construction; it never invents zero readings for missing data.
  Partial edge intervals (`partial=true`) are allowed only at the export's
  first/last timestamp per device.

## Prohibitions

- No room/office total rows (totals are computed; indistinguishable total rows
  would corrupt device sums).
- No fault-label columns.
- JSON and CSV represent the same fixture and produce identical totals.
  No general application CSV importer is implemented in F1.
