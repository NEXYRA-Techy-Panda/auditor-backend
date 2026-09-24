# CSV representation — contract v1.0.0

## Encoding and framing

- UTF-8 without BOM, LF line endings, one header row, RFC 4180 quoting: fields
  containing commas, quotes, or newlines are wrapped in double quotes with
  internal quotes doubled. Numbers use decimal dots. Booleans are lowercase
  `true`/`false`. Null (absent optional value) is an empty unquoted field —
  never the strings `null`, `NaN`, or `-`.

## Exact header (28 columns, this order)

```text
run_id,building_id,scenario_id,interval_start_utc,interval_end_utc,interval_seconds,room_id,room_occupancy_avg,room_occupancy_max,room_occupied_fraction,room_temp_c,room_rh_pct,device_id,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_ref,partial,meta_run,meta_policy
```

## Row grain and repetition

- One row per device interval, ordered by `interval_start_utc`, then `device_id`.
- Room interval summaries (`room_occupancy_avg … room_rh_pct`) repeat on every
  device row of that room and interval. The importer groups by
  `(run_id, room_id, interval_start_utc)` and requires byte-identical room
  values; conflicting repeats are an error.
- Scalar run/building columns (`run_id`, `building_id`, `scenario_id`) repeat
  per row and must agree with `meta_run`.

## JSON-valued metadata columns

Two explicitly defined columns; no others may carry JSON:

- `meta_run`: export identity and provenance —
  `building_id`, `run_id`, `export_id`, `schema_version`, `source`,
  `synthetic`, `timezone`, `export_start_utc`, `export_end_utc`.
  Must parse to the same object on every row; drift is a conflicting-metadata
  error.
- `meta_policy`: effective policy references for the row —
  `device` (`<policy_id>:<version>` for the device) and `office_hours`
  (`<policy_id>:<version>`). Each `device` ref must resolve to a policy in the
  export (the full policy set travels in JSON; for CSV-only handling the
  auditor keeps the paired JSON export or previously imported policy versions —
  a CSV row referencing an unknown policy version is an error).

Both are CSV-escaped (quoted, internal quotes doubled).

## Completeness

A complete export preserves inventory (device set derivable from rows plus the
paired JSON envelope), calendar/policy versions (`meta_policy` refs),
room + device interval readings, and provenance/time range (`meta_run`).
Policy metadata is never dropped; the auditor must not assume the simulator's
fixed inventory is preloaded.

## Coverage rule

CSV requires an aligned interval grid and exactly one row per exported device
per interval. Absent rows are gaps and fail validation. The exporter meets this
by construction; it never invents zero readings for missing data. Partial edge
intervals (`partial=true`) are allowed only at the export's first/last
timestamp per device.

## Prohibitions

- No room/office total rows (totals are computed, and indistinguishable total
  rows would corrupt device sums).
- No fault-label columns (see CONTRACT.md §7).
- JSON and CSV represent the same fixture and must produce identical totals.
  No general application CSV importer is implemented in F1.
