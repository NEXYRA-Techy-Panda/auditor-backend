# NEXYRA Shared Data & Interface Contract — v1.0.0

Status: **designed, review pending**. Schema version `1.0.0` names the document
revision, not an approval. Receiving this file does not prove application
compatibility — implementations must be verified against it.

- Canonical location: `simulation-backend/contracts/v1/` (this copy).
- Mirrors: `contracts/v1/` in `simulation-frontend`, `auditor-frontend`,
  `auditor-backend`, `energy-ml-service` (byte-identical; see `manifest.json`).
- Each repository must work without a sibling directory present at runtime: no
  symlinks, no cross-repository runtime imports, no shared database files.
- Later changes require an explicit version/change entry and coordinated mirror
  updates. A newer file alone proves nothing about the code reading it.
- Companion files: `dataset.schema.json` (envelope shape),
  `CSV_COLUMNS.md` (CSV representation), `API.md` (service + Socket.IO
  interfaces), `fixtures/` (known answers), `manifest.json` (hashes).

## 1. Identity, time and provenance

- `schema_version`: `"1.0.0"`. Importers reject documents whose major version
  they do not support (`1.x` accepted only when explicitly implemented).
- `building_id`: stable per site, e.g. `nexyra-demo-office`.
- `run_id`: unique per simulation run. **A reset creates a new run** (new
  `run_id`); cumulative counters are run-relative.
- `export_id`: unique per export file within a run.
- Auditor import identity: the auditor assigns its own `dataset_id` per
  accepted upload. `run_id` identifies the simulator run; `dataset_id`
  identifies the auditor's stored copy. Never conflate them.
- Stable `room_id` / `device_id` values (§2). IDs may repeat across separate
  runs or datasets — never deduplicate across unrelated datasets solely by
  device ID.
- `source`: `"simulation"` for simulator-generated data.
- `synthetic`: boolean. `true` marks hand-made or scenario-generated data not
  measured from a live process; `synthetic_label` states what it is.
  Synthetic results and simulated savings are always explicitly labelled.
- Building timezone: `Asia/Kolkata` (only value in v1).
- `run_start_utc`, `export_start_utc`, and exclusive `export_end_utc`;
  nominal `interval_seconds` (allowed nominals: 60, 300, 600, 900, 1800, 3600).
- `scenario_id`: `"original"` or `"improved"`; `comparison_id` links the two
  exports of one comparison.
- Timestamps are UTC ISO 8601 with `Z` (`YYYY-MM-DDTHH:MM:SSZ`).
- Intervals are half-open: `[interval_start_utc, interval_end_utc)`. Each
  interval record carries `interval_seconds`.
- Calendar reports and schedules are interpreted in the building timezone;
  storage is UTC.
- Only complete intervals are exported, except explicitly marked partial edge
  intervals (`partial: true`, allowed only at export edges).
- A simulation pause does not itself advance simulated time.
- **Missing data is not zero**: absent intervals/rows are gaps, never zero
  consumption. Exporters never invent zero readings for missing data.

### Uniqueness and duplicates

- Device interval key: `(run_id, device_id, interval_start_utc)`.
- Room interval key: `(run_id, room_id, interval_start_utc)`.
- Identical duplicate records (all fields equal): deduplicate silently, count
  them in the import report.
- Conflicting duplicates (same key, differing fields): validation **error**,
  no partial import.

## 2. Inventory and configuration

### 2.1 MVP1 inventory (stable IDs)

Five rooms:

| room_id | name | capacity |
|---|---|---|
| `room-open-workspace` | Open workspace | 12 |
| `room-meeting` | Meeting room | 6 |
| `room-pantry` | Pantry/dining | 4 |
| `room-reception` | Reception | 2 |
| `room-manager-cabin` | Manager's cabin | 2 |

Eighteen devices/device groups:

| device_id | name | room_id | device_type |
|---|---|---|---|
| `dev-open-light-a` | Lighting zone A | room-open-workspace | lighting |
| `dev-open-light-b` | Lighting zone B | room-open-workspace | lighting |
| `dev-open-ac` | AC | room-open-workspace | ac |
| `dev-open-fan` | Fan | room-open-workspace | fan |
| `dev-open-workstations` | Workstation group | room-open-workspace | workstation_group |
| `dev-meeting-light` | Lighting group | room-meeting | lighting |
| `dev-meeting-ac` | AC | room-meeting | ac |
| `dev-meeting-projector` | Projector | room-meeting | projector |
| `dev-pantry-light` | Lighting group | room-pantry | lighting |
| `dev-pantry-fan` | Fan | room-pantry | fan |
| `dev-pantry-fridge` | Refrigerator | room-pantry | refrigerator |
| `dev-pantry-microwave` | Microwave | room-pantry | microwave |
| `dev-reception-light` | Lighting group | room-reception | lighting |
| `dev-reception-fan` | Fan | room-reception | fan |
| `dev-reception-pc` | Reception computer | room-reception | computer |
| `dev-manager-light` | Lighting group | room-manager-cabin | lighting |
| `dev-manager-ac` | AC | room-manager-cabin | ac |
| `dev-manager-pc` | Computer | room-manager-cabin | computer |

### 2.2 Device metadata fields

`device_id`, `name`, `room_id`, `device_type`, `quantity` (group size, e.g.
workstations), `nominal_power_w`, `standby_power_w`, `power_factor` assumption,
`always_on` exception flag, `control` (`manual`/`scheduled`/`always_on`),
`controls` (applicable commands, e.g. `["switch"]`), schedule/policy
reference. Nominal/standby powers below are **proposed editable demo defaults
(assumptions)**, not measured ratings:

- Lighting zone/group: 72 W, pf 0.9. Workstation group: 8 × 120 W = 960 W,
  pf 0.9. AC: 1500 W, pf 0.95. Fan: 75 W, pf 0.8. Projector: 300 W on /
  5 W standby, pf 0.9. Refrigerator: 150 W, pf 1.0, always-on exception.
  Microwave: 1200 W / 3 W standby, pf 1.0. Computers: 150 W / 5 W standby,
  pf 0.9.

These examples double as future seed specifications, not database seeds.

### 2.3 Imports are not limited to this inventory

The schema permits smaller valid fixtures (see `fixtures/`) and other
inventories. An import must NOT be required to contain exactly five rooms or
18 devices.

### 2.4 Working days, hours, schedules

- Weekdays use ISO numbering: Monday = 1 … Sunday = 7. Default working days:
  `[1, 2, 3, 4, 5]`.
- Office hours are local (`Asia/Kolkata`), default `09:00`–`18:00`, start
  inclusive, end exclusive.
- Overnight windows are represented with `close_local <= open_local`
  (e.g. `22:00`–`06:00`) plus `"overnight": true`.
- Vacancy grace period is configured in **simulated seconds** (default 300 s).
- Manual overrides force a device state for a bounded duration; override time
  is metered in `override_seconds` and the pre-override schedule resumes after.
- Always-on exceptions (refrigerator) ignore vacancy and schedules; their
  vacant operation raises no finding.
- Configuration over a run is represented with **immutable policy versions**:
  `{policy_id, version, applies_to, kind, effective_from_utc, rules}`.
  Interval records reference them via `policy_ref: "<policy_id>:<version>"`.
  Never export only the final schedule when it would misrepresent earlier
  readings; a mid-run change mints a new version (or an equivalent
  effective-time representation carrying the same information).

## 3. Measurement contract

### 3.1 Device interval fields

- `avg_power_w`: interval-average real power (W).
- `max_power_w`: interval maximum (W).
- `energy_kwh`: interval energy (kWh).
- `cumulative_kwh`: cumulative energy **at interval end** (kWh), run-relative.
- `avg_voltage_v`, `avg_current_a`: reported only when measured/modelled;
  otherwise omitted (null behaviour: absent, not zero).
- `power_factor`: assumption in force for the interval.
- `on_fraction`: fraction of the interval the device was on (0–1).
- `override_seconds`, `vacant_on_seconds`, `offschedule_on_seconds`: measured
  operating summaries in seconds.
- `policy_ref`, `partial`.

### 3.2 Room interval fields

- `occupancy_avg` (fractional allowed), `occupancy_max` (integer),
  `occupied_fraction` (0–1), `avg_temp_c`, `avg_rh_pct`.
- Occupancy average can be fractional; instantaneous/max counts are integers.

### 3.3 Operating summaries are not fault labels

`vacant_on_seconds` and `offschedule_on_seconds` are measured summaries, not
injected fault labels. They may overlap (vacant time outside schedule); their
overlap must **not** be blindly added as separate waste. Coarse aggregation
cannot reconstruct every subinterval or grace event — findings must respect
available resolution.

### 3.4 Formulas

- Single-phase instantaneous (simplified): `P = V × I × power_factor`.
- Interval energy: `energy_kwh = avg_power_w × interval_seconds / 3600000`.
- Do NOT require `avg_voltage × avg_current × pf == avg_power` when conditions
  varied inside the interval; allow 1% relative deviation.

### 3.5 Aggregation (finer → coarser)

- Energy: sum. Power: duration-weighted average; peaks: maxima.
- Fractions (`on_fraction`, `occupied_fraction`): duration-weighted average.
- `cumulative_kwh`: final counter wins.
- Operating durations (`override/vacant/offschedule_seconds`): sum.
- Occupancy across rooms: deduplicate repeated room values first (CSV repeats
  room summaries per device row), then duration-weight.
- Aggregation preserves energy: reaggregated totals match within tolerance.
- Counters are run-relative and **need not start at zero** in a partial export.
  Reconciliation: `cumulative(end_n) − cumulative(end_{n−1}) == energy_n`
  within tolerance; the first interval of a partial export is exempt.

### 3.6 Tolerance and rounding

- Consistency checks: absolute tolerance `1e-6` kWh for energy sums;
  1% relative for power-derived checks.
- Rounding policy: round only at presentation/export (≤ 6 dp for kWh,
  ≤ 3 dp for W). Never round internal accumulators step by step.

## 4. Canonical JSON export

Self-contained envelope (see `dataset.schema.json`):

```text
schema_version, source, synthetic, synthetic_label?,
building, run, export, rooms[], devices[], policies[],
room_intervals[], device_intervals[]
```

- Room/office energy totals are calculated by the reader; never mixed into
  the device-reading collection.
- The envelope carries enough inventory + policy versions to analyse schedules
  without the simulator.
- UI layout details and injected-fault labels are excluded.
- Unknown fields: rejected in interval/room/device/policy records
  (`additionalProperties: false`) — arbitrary extensions must not become a
  route for exporting fault labels.
- Allowed provenance: `source: "simulation"`, `scenario_id`/`comparison_id`,
  `synthetic` + label. Forbidden analysis inputs: `fault_active`, `fault_type`,
  `fault_window(s)`, `injected_fault`, `expected_diagnosis` (see §7).

## 5. CSV representation

Specified in `CSV_COLUMNS.md`. Summary of decisions:

- UTF-8, header row, RFC 4180 quoting, decimal dots, booleans `true`/`false`,
  null = empty unquoted field.
- One row per device interval; room summaries + metadata repeated per row;
  importer deduplicates room values by `(run_id, room_id, interval_start_utc)`.
- Two JSON-valued metadata columns: `meta_run` (export identity/provenance),
  `meta_policy` (effective policy refs), CSV-escaped; importer checks
  `meta_run` consistency across rows.
- Coverage rule: aligned interval grid with one row per exported device per
  interval; absent rows are gaps (errors), never synthesised as zeros.
- No room/office total rows. JSON and CSV represent the same fixture and must
  produce the same results. No general application CSV importer in F1.

## 6. Import behaviour

1. Structural parse (UTF-8, header/JSON shape). 2. `schema_version` support
   check (reject unsupported major). 3. Cross-record references (device→room,
   `policy_ref`→policy, interval `run_id` consistency). 4. Interval
   ordering/overlap/contiguity per device. 5. Unit and range checks
   (schema bounds, `max ≥ avg`, fractions in [0,1], durations ≤ interval).
   6. Energy/counter reconciliation (§3.5). 7. Conflicting metadata detection
   (`meta_run` drift, mismatched inventory). 8. Duplicate handling (§1).
   9. Coverage/gap report. Errors abort the import with **no partial database
   write**; warnings (identical duplicates deduped, standby anomalies) are
   reported alongside acceptance.
- File hashes identify exact repeat uploads only — semantic duplicate detection
  across CSV and JSON uses `run_id`/`export_id` + content checks.
- Repeated upload of an accepted export: acknowledged as already-imported
  (same `dataset_id`), not duplicated.
- Changing the tariff never changes dataset identity and never triggers model
  retraining.

## 7. Forbidden fields (never in exports or auditor inputs)

`fault_active`, `fault_type`, `fault_window`, `fault_windows`,
`injected_fault`, `expected_diagnosis`, `expected_finding`, `is_fault`,
`fault_label`. `scripts/verify-contract.mjs` fails fixtures containing them.
Fault-control commands to the simulator backend are out of scope for this
contract version.

## 8. Python result semantics

Findings carry: `finding_id`, `finding_type`, affected `room_id`/`device_id`,
time window, `observed` + `expected` values with units, `method`
(`rule`/`model`), `suggested_action`, `avoidable_energy_kwh`/`avoidable_cost_inr`
when supported, `assumptions`, `resolution_limit`. No invented confidence
percentages for rule-based findings.
Forecasts distinguish observations from projections and record assumed future
schedule/environment, `horizon` (`next_24h`/`next_7d`/`next_calendar_month`),
forecast origin, model/baseline version, and uncertainty (or `unavailable`).
`next_calendar_month` means the local calendar month after the month containing
the forecast origin (00:00 first day inclusive → 00:00 first day of the
following month exclusive) — not "next 30 days".
Comparisons identify both `dataset_id`s, matched input provenance, period
compatibility, and original/improved energy; savings are marked simulated.
Prices come from explicit user tariff settings, never hidden model assumptions.

## 9. Known-answer fixture

Two rooms, two devices, two one-minute intervals (Monday 2026-09-21 09:00–09:02
IST = 03:30–03:32Z). Room A 600 W light (occupied interval 1, vacant interval 2,
zero grace fixture-only); Room B 300 W refrigerator, vacant throughout,
always-on exception. Expected: light 0.01 kWh/min → 0.02 total; fridge
0.005/min → 0.01 total; office 0.03 total; ₹10/kWh → ₹0.30; two-minute
reaggregation preserves 0.03 kWh. Answers live only in `fixtures/expected.json`
(evaluation material, never an auditor input). Arithmetic is documented there,
independent of application code.
