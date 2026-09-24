// verify-contract.mjs — dependency-free semantic checks for contract v1.0.0.
// Run from the repository root:  node scripts/verify-contract.mjs
// Uses Node built-ins only (node:fs, node:path, node:crypto). No npm install.
//
// Scope: hand-calculated fixture totals, record identities/references, mirror
// hashes, CSV/JSON parity, forbidden fault-label fields. This is NOT formal
// JSON Schema conformance validation (no schema validator is run here);
// formal validator integration belongs to F2.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1 = join(ROOT, 'contracts', 'v1');
const TOL_KWH = 1e-9;
const TOL_REL_POWER = 0.01;
const FORBIDDEN = [
  'fault_active', 'fault_type', 'fault_window', 'fault_windows',
  'injected_fault', 'expected_diagnosis', 'expected_finding',
  'is_fault', 'fault_label',
];

let failures = 0;
let passes = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passes++; console.log(`PASS  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// Narrowly scoped RFC 4180 reader (fixture-sized inputs only).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ---- load ----
const refPath = join(V1, 'fixtures', 'reference.json');
const expPath = join(V1, 'fixtures', 'reference.csv');
const exptPath = join(V1, 'fixtures', 'expected.json');
const manPath = join(V1, 'manifest.json');
for (const [n, p] of [['reference.json', refPath], ['reference.csv', expPath], ['expected.json', exptPath], ['manifest.json', manPath]]) {
  check(`artifact present: ${n}`, existsSync(p));
}
if (failures) { console.log(`\nRESULT: ${failures} failure(s). Semantic checks only; not formal schema validation.`); process.exit(1); }

const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const exp = JSON.parse(readFileSync(exptPath, 'utf8'));
const man = JSON.parse(readFileSync(manPath, 'utf8'));
const refRaw = readFileSync(refPath, 'utf8');
const csvRaw = readFileSync(expPath, 'utf8');

// ---- versions ----
check('schema_version is 1.0.0', ref.schema_version === '1.0.0', ref.schema_version);
check('expected.json schema_version is 1.0.0', exp.schema_version === '1.0.0');
check('manifest contract_version is 1.0.0', man.contract_version === '1.0.0');
check('source is simulation', ref.source === 'simulation');
check('fixture marked synthetic', ref.synthetic === true && typeof ref.synthetic_label === 'string');

// ---- hand-calculated totals ----
const byDevice = {};
for (const d of ref.device_intervals) {
  byDevice[d.device_id] = byDevice[d.device_id] || { energy: 0, last: null };
  byDevice[d.device_id].energy += d.energy_kwh;
  byDevice[d.device_id].last = d;
}
check('light-a total is 0.02 kWh', approx(byDevice['light-a'].energy, 0.02, TOL_KWH), byDevice['light-a']?.energy);
check('fridge-b total is 0.01 kWh', approx(byDevice['fridge-b'].energy, 0.01, TOL_KWH), byDevice['fridge-b']?.energy);
const office = Object.values(byDevice).reduce((s, v) => s + v.energy, 0);
check('office total is 0.03 kWh', approx(office, 0.03, TOL_KWH), office);
check('final cumulative light-a is 0.02', approx(byDevice['light-a'].last.cumulative_kwh, 0.02, TOL_KWH));
check('final cumulative fridge-b is 0.01', approx(byDevice['fridge-b'].last.cumulative_kwh, 0.01, TOL_KWH));
// Counter reconciliation: cumulative(end_n) - cumulative(end_{n-1}) == energy_n.
for (const [id, v] of Object.entries(byDevice)) {
  const rows = ref.device_intervals.filter((d) => d.device_id === id)
    .sort((a, b) => (a.interval_start_utc < b.interval_start_utc ? -1 : 1));
  let prev = 0;
  rows.forEach((r, i) => {
    check(`counter reconciliation ${id} interval ${i + 1}`, approx(r.cumulative_kwh - prev, r.energy_kwh, 1e-6), `${r.cumulative_kwh} - ${prev} != ${r.energy_kwh}`);
    prev = r.cumulative_kwh;
  });
}
// Reaggregation to one 120 s bucket preserves 0.03 kWh.
check('120 s reaggregation preserves 0.03 kWh', approx(office, exp.reaggregation_120s_kwh.office, TOL_KWH));
// Tariff: 0.03 kWh * Rs 10 = Rs 0.30.
check('tariff cost is Rs 0.30', approx(office * exp.tariff.inr_per_kwh, exp.tariff.office_cost_inr, TOL_KWH));
// expected.json totals mirror recomputation.
check('expected totals match recomputation',
  approx(exp.totals_kwh['light-a'], 0.02, TOL_KWH) &&
  approx(exp.totals_kwh['fridge-b'], 0.01, TOL_KWH) &&
  approx(exp.totals_kwh.office, 0.03, TOL_KWH));

// ---- identities and references ----
const roomIds = new Set(ref.rooms.map((r) => r.room_id));
const devIds = new Set(ref.devices.map((d) => d.device_id));
const polKeys = new Set(ref.policies.map((p) => `${p.policy_id}:${p.version}`));
check('device rooms exist', ref.devices.every((d) => roomIds.has(d.room_id)));
check('interval rooms/devices exist',
  ref.device_intervals.every((d) => devIds.has(d.device_id) && roomIds.has(d.room_id)) &&
  ref.room_intervals.every((r) => roomIds.has(r.room_id)));
check('policy refs resolve', ref.device_intervals.every((d) => polKeys.has(d.policy_ref)), ref.device_intervals.map((d) => d.policy_ref).join(','));
const dKeys = ref.device_intervals.map((d) => `${d.run_id}|${d.device_id}|${d.interval_start_utc}`);
const rKeys = ref.room_intervals.map((r) => `${r.run_id}|${r.room_id}|${r.interval_start_utc}`);
check('device interval keys unique', new Set(dKeys).size === dKeys.length);
check('room interval keys unique', new Set(rKeys).size === rKeys.length);
check('single run_id throughout', new Set([...ref.device_intervals, ...ref.room_intervals].map((r) => r.run_id)).size === 1);
// Half-open contiguity per device.
for (const id of devIds) {
  const rows = ref.device_intervals.filter((d) => d.device_id === id)
    .sort((a, b) => (a.interval_start_utc < b.interval_start_utc ? -1 : 1));
  const contiguous = rows.every((r, i) => i === 0 || rows[i - 1].interval_end_utc === r.interval_start_utc);
  check(`intervals contiguous for ${id}`, contiguous);
}
// Energy formula spot-check: energy_kwh == avg_power_w * seconds / 3600000.
check('energy formula holds on all device intervals',
  ref.device_intervals.every((d) => approx(d.energy_kwh, (d.avg_power_w * d.interval_seconds) / 3600000, 1e-6)));
// V/I/pf spot-check within 1% (exact equality not required).
check('V*I*pf within 1% of avg power',
  ref.device_intervals.every((d) => {
    if (d.avg_voltage_v == null || d.avg_current_a == null) return true;
    const p = d.avg_voltage_v * d.avg_current_a * d.power_factor;
    return Math.abs(p - d.avg_power_w) / d.avg_power_w <= TOL_REL_POWER;
  }));

// ---- manifest hashes ----
check('manifest lists files', Array.isArray(man.files) && man.files.length >= 8, man.files?.length);
check('manifest excludes itself', !man.files.some((f) => f.path.endsWith('manifest.json')));
for (const f of man.files) {
  const p = join(ROOT, f.path);
  check(`hash match: ${f.path}`, existsSync(p) && sha256(p) === f.sha256,
    existsSync(p) ? `got ${sha256(p).slice(0, 12)}… want ${String(f.sha256).slice(0, 12)}…` : 'missing');
}

// ---- CSV parity ----
const EXPECTED_HEADER = 'run_id,building_id,scenario_id,interval_start_utc,interval_end_utc,interval_seconds,room_id,room_occupancy_avg,room_occupancy_max,room_occupied_fraction,room_temp_c,room_rh_pct,device_id,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_ref,partial,meta_run,meta_policy';
const rows = parseCsv(csvRaw);
check('CSV header exact', rows[0].join(',') === EXPECTED_HEADER, rows[0].join(','));
check('CSV has 4 data rows', rows.length === 5, `got ${rows.length - 1}`);
const H = rows[0];
const col = (r, n) => r[H.indexOf(n)];
const num = (r, n) => Number(col(r, n));
let parity = true;
const metas = new Set();
for (const r of rows.slice(1)) {
  const key = `${col(r, 'interval_start_utc')}|${col(r, 'device_id')}`;
  const j = ref.device_intervals.find((d) => `${d.interval_start_utc}|${d.device_id}` === key);
  if (!j) { parity = false; console.log(`FAIL  CSV row has no JSON match: ${key}`); failures++; continue; }
  const room = ref.room_intervals.find((x) => x.room_id === j.room_id && x.interval_start_utc === j.interval_start_utc);
  const fields = ['avg_power_w', 'max_power_w', 'energy_kwh', 'cumulative_kwh', 'avg_voltage_v', 'avg_current_a', 'power_factor', 'on_fraction', 'override_seconds', 'vacant_on_seconds', 'offschedule_on_seconds'];
  for (const f of fields) {
    if (!approx(num(r, f), j[f], TOL_KWH)) { parity = false; console.log(`FAIL  CSV/JSON mismatch ${key} ${f}: csv=${num(r, f)} json=${j[f]}`); failures++; }
  }
  for (const [cn, jn] of [['room_occupancy_avg', 'occupancy_avg'], ['room_occupancy_max', 'occupancy_max'], ['room_occupied_fraction', 'occupied_fraction'], ['room_temp_c', 'avg_temp_c'], ['room_rh_pct', 'avg_rh_pct']]) {
    if (!approx(num(r, cn), room[jn], TOL_KWH)) { parity = false; console.log(`FAIL  CSV/JSON room mismatch ${key} ${cn}`); failures++; }
  }
  if (col(r, 'policy_ref') !== j.policy_ref || col(r, 'partial') !== String(j.partial)) { parity = false; console.log(`FAIL  CSV/JSON ref mismatch ${key}`); failures++; }
  metas.add(col(r, 'meta_run'));
  try {
    const mp = JSON.parse(col(r, 'meta_policy'));
    if (mp.device !== j.policy_ref) { parity = false; console.log(`FAIL  meta_policy device mismatch ${key}`); failures++; }
  } catch { parity = false; console.log(`FAIL  meta_policy not JSON: ${key}`); failures++; }
}
if (parity) { passes++; console.log('PASS  CSV/JSON row parity (keyed, tolerance 1e-9)'); }
check('meta_run identical on all rows', metas.size === 1, `${metas.size} variants`);
try {
  const mr = JSON.parse([...metas][0]);
  check('meta_run matches JSON export identity',
    mr.run_id === ref.run.run_id && mr.export_id === ref.export.export_id &&
    mr.schema_version === '1.0.0' && mr.source === 'simulation');
} catch { check('meta_run matches JSON export identity', false, 'unparseable'); }

// ---- forbidden fields ----
const blob = `${refRaw}\n${csvRaw}`;
const found = FORBIDDEN.filter((f) => blob.includes(f));
check('no fault-label fields in exported fixtures', found.length === 0, found.join(','));
check('findings live only in expected.json',
  !refRaw.includes('avoidable_energy_kwh') && !refRaw.includes('"findings"') && Array.isArray(exp.findings));
check('expected.json marked evaluation-only', typeof exp.note === 'string' && /never an auditor input/i.test(exp.note));

console.log(`\nRESULT: ${passes} passed, ${failures} failed.`);
console.log('NOTE: dependency-free semantic checks only — not formal JSON Schema validation (F2).');
process.exit(failures ? 1 : 0);
