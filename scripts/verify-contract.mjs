// verify-contract.mjs — dependency-free semantic checks for contract v1.0.1.
// Run from the repository root:  node scripts/verify-contract.mjs
// Uses Node built-ins only (node:fs, node:path, node:crypto). No npm install.
//
// Scope: hand-calculated fixture totals, record identities/references, mirror
// hashes, CSV-alone reconstruction with full semantic parity against
// reference.json, negative envelope/reference checks, export-precision and
// rounding-budget checks, forbidden fault-label scan. This is NOT formal JSON
// Schema conformance validation (no schema validator is run here); formal
// validator integration belongs to F2. This is a contract-fixture utility,
// not a production importer.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1 = join(ROOT, 'contracts', 'v1');
// Tolerances (CONTRACT.md §3.6): per-value 1e-9 kWh, totals scale with the
// number of contributing intervals, V·I·pf triple is relative 1e-9,
// CSV/JSON same-value comparison is 1e-12.
const TOL_VALUE = 1e-9;
const TOL_TOTAL = (n) => n * 1e-9;
const TOL_TRIPLE_REL = 1e-9;
const TOL_PARITY = 1e-12;
const FORBIDDEN = [
  'fault_active', 'fault_type', 'fault_window', 'fault_windows',
  'injected_fault', 'expected_diagnosis', 'expected_finding',
  'is_fault', 'fault_label',
];
const EXPECTED_HEADER = 'run_id,building_id,scenario_id,interval_start_utc,interval_end_utc,interval_seconds,room_id,room_occupancy_avg,room_occupancy_max,room_occupied_fraction,room_temp_c,room_rh_pct,device_id,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_ref,partial,meta_run';

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
const escCell = (v) => {
  v = String(v);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
const fail = (code, message) => { throw { code, message }; };

// Reconstruct the canonical dataset from CSV text ALONE. The oracle
// (reference.json) is never consulted here; comparison happens afterwards.
function reconstructFromCsv(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length || rows[0].join(',') !== EXPECTED_HEADER) fail('HEADER', 'header mismatch');
  const H = rows[0];
  const col = (r, n) => r[H.indexOf(n)];
  const data = rows.slice(1);
  if (!data.length) fail('NO_ROWS', 'no data rows');
  const envIdx = data.map((r, i) => (col(r, 'meta_run').trim() !== '' ? i : -1)).filter((i) => i >= 0);
  if (!envIdx.length) fail('MISSING_ENVELOPE', 'no metadata envelope');
  if (envIdx.length > 1) fail('MULTIPLE_ENVELOPES', `${envIdx.length} envelopes`);
  if (envIdx[0] !== 0) fail('ENVELOPE_NOT_FIRST', `envelope on data row ${envIdx[0] + 1}`);
  let env;
  try { env = JSON.parse(col(data[0], 'meta_run')); }
  catch { fail('ENVELOPE_UNPARSEABLE', 'meta_run is not JSON'); }
  if (env.schema_version !== '1.0.1') fail('UNSUPPORTED_VERSION', String(env.schema_version));
  for (const k of ['building', 'run', 'export', 'rooms', 'devices', 'policies']) {
    if (env[k] == null) fail('ENVELOPE_INCOMPLETE', `missing ${k}`);
  }
  const roomById = new Map(env.rooms.map((r) => [r.room_id, r]));
  const devById = new Map(env.devices.map((d) => [d.device_id, d]));
  const polByKey = new Map(env.policies.map((p) => [`${p.policy_id}:${p.version}`, p]));
  const num = (r, n) => {
    const v = Number(col(r, n));
    if (!Number.isFinite(v)) fail('BAD_NUMBER', `${n}=${col(r, n)}`);
    return v;
  };
  const roomGroups = new Map();
  const seenDeviceKeys = new Map();
  const device_intervals = [];
  for (const r of data) {
    const device_id = col(r, 'device_id');
    const room_id = col(r, 'room_id');
    if (!devById.has(device_id)) fail('UNKNOWN_DEVICE', device_id);
    if (!roomById.has(room_id)) fail('UNKNOWN_ROOM', room_id);
    if (col(r, 'run_id') !== env.run.run_id || col(r, 'building_id') !== env.building.building_id ||
        col(r, 'scenario_id') !== env.run.scenario_id) fail('ID_MISMATCH', `${device_id}@${col(r, 'interval_start_utc')}`);
    const policy_ref = col(r, 'policy_ref');
    if (!/^[A-Za-z0-9_-]+:[0-9]+$/.test(policy_ref) || !polByKey.has(policy_ref)) fail('UNKNOWN_POLICY_REF', policy_ref);
    const rk = `${room_id}|${col(r, 'interval_start_utc')}`;
    const roomVals = {
      occupancy_avg: num(r, 'room_occupancy_avg'), occupancy_max: num(r, 'room_occupancy_max'),
      occupied_fraction: num(r, 'room_occupied_fraction'), avg_temp_c: num(r, 'room_temp_c'), avg_rh_pct: num(r, 'room_rh_pct'),
    };
    if (roomGroups.has(rk)) {
      const prev = roomGroups.get(rk);
      if (JSON.stringify(prev) !== JSON.stringify(roomVals)) fail('CONFLICTING_ROOM_VALUES', rk);
    } else roomGroups.set(rk, roomVals);
    const b = (n) => col(r, n) === 'true';
    const dk = `${col(r, 'run_id')}|${device_id}|${col(r, 'interval_start_utc')}`;
    const rec = {
      run_id: col(r, 'run_id'), room_id, device_id,
      interval_start_utc: col(r, 'interval_start_utc'), interval_end_utc: col(r, 'interval_end_utc'),
      interval_seconds: num(r, 'interval_seconds'), avg_power_w: num(r, 'avg_power_w'), max_power_w: num(r, 'max_power_w'),
      energy_kwh: num(r, 'energy_kwh'), cumulative_kwh: num(r, 'cumulative_kwh'),
      avg_voltage_v: col(r, 'avg_voltage_v') === '' ? undefined : num(r, 'avg_voltage_v'),
      avg_current_a: col(r, 'avg_current_a') === '' ? undefined : num(r, 'avg_current_a'),
      power_factor: num(r, 'power_factor'), on_fraction: num(r, 'on_fraction'),
      override_seconds: num(r, 'override_seconds'), vacant_on_seconds: num(r, 'vacant_on_seconds'),
      offschedule_on_seconds: num(r, 'offschedule_on_seconds'), policy_ref, partial: b('partial'),
    };
    if (seenDeviceKeys.has(dk)) {
      if (JSON.stringify(seenDeviceKeys.get(dk)) !== JSON.stringify(rec)) fail('CONFLICTING_DUPLICATE', dk);
    } else { seenDeviceKeys.set(dk, rec); device_intervals.push(rec); }
  }
  const room_intervals = [...roomGroups.entries()].map(([rk, v]) => {
    const [room_id, interval_start_utc] = rk.split('|');
    const src = data.find((r) => col(r, 'room_id') === room_id && col(r, 'interval_start_utc') === interval_start_utc);
    return {
      run_id: col(src, 'run_id'), room_id, interval_start_utc,
      interval_end_utc: col(src, 'interval_end_utc'), interval_seconds: Number(col(src, 'interval_seconds')),
      ...v, partial: col(src, 'partial') === 'true',
    };
  });
  return {
    schema_version: env.schema_version, source: env.source, synthetic: env.synthetic,
    synthetic_label: env.synthetic_label, building: env.building, run: env.run, export: env.export,
    rooms: env.rooms, devices: env.devices, policies: env.policies, room_intervals, device_intervals,
  };
}

// ---- load ----
const refPath = join(V1, 'fixtures', 'reference.json');
const csvPath = join(V1, 'fixtures', 'reference.csv');
const exptPath = join(V1, 'fixtures', 'expected.json');
const manPath = join(V1, 'manifest.json');
for (const [n, p] of [['reference.json', refPath], ['reference.csv', csvPath], ['expected.json', exptPath], ['manifest.json', manPath]]) {
  check(`artifact present: ${n}`, existsSync(p));
}
if (failures) { console.log(`\nRESULT: ${failures} failure(s). Semantic checks only; not formal schema validation.`); process.exit(1); }

const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const exp = JSON.parse(readFileSync(exptPath, 'utf8'));
const man = JSON.parse(readFileSync(manPath, 'utf8'));
const refRaw = readFileSync(refPath, 'utf8');
const csvRaw = readFileSync(csvPath, 'utf8');

// ---- versions ----
check('schema_version is 1.0.1', ref.schema_version === '1.0.1', ref.schema_version);
check('expected.json schema_version is 1.0.1', exp.schema_version === '1.0.1');
check('manifest contract_version is 1.0.1', man.contract_version === '1.0.1');
check('source is simulation', ref.source === 'simulation');
check('fixture marked synthetic', ref.synthetic === true && typeof ref.synthetic_label === 'string');

// ---- hand-calculated totals (tolerances scale with interval count) ----
const byDevice = {};
for (const d of ref.device_intervals) {
  byDevice[d.device_id] = byDevice[d.device_id] || { energy: 0, n: 0, last: null };
  byDevice[d.device_id].energy += d.energy_kwh;
  byDevice[d.device_id].n += 1;
  byDevice[d.device_id].last = d;
}
check('light-a total is 0.02 kWh', approx(byDevice['light-a'].energy, 0.02, TOL_TOTAL(2)), byDevice['light-a']?.energy);
check('fridge-b total is 0.01 kWh', approx(byDevice['fridge-b'].energy, 0.01, TOL_TOTAL(2)), byDevice['fridge-b']?.energy);
const office = Object.values(byDevice).reduce((s, v) => s + v.energy, 0);
check('office total is 0.03 kWh', approx(office, 0.03, TOL_TOTAL(4)), office);
check('final cumulative light-a is 0.02', approx(byDevice['light-a'].last.cumulative_kwh, 0.02, TOL_VALUE));
check('final cumulative fridge-b is 0.01', approx(byDevice['fridge-b'].last.cumulative_kwh, 0.01, TOL_VALUE));
for (const [id, v] of Object.entries(byDevice)) {
  const rows = ref.device_intervals.filter((d) => d.device_id === id)
    .sort((a, b) => (a.interval_start_utc < b.interval_start_utc ? -1 : 1));
  let prev = 0;
  rows.forEach((r, i) => {
    check(`counter reconciliation ${id} interval ${i + 1}`, approx(r.cumulative_kwh - prev, r.energy_kwh, TOL_VALUE), `${r.cumulative_kwh} - ${prev} != ${r.energy_kwh}`);
    prev = r.cumulative_kwh;
  });
}
check('120 s reaggregation preserves 0.03 kWh', approx(office, exp.reaggregation_120s_kwh.office, TOL_TOTAL(4)));
check('tariff cost is Rs 0.30', approx(office * exp.tariff.inr_per_kwh, exp.tariff.office_cost_inr, TOL_TOTAL(4)));
check('expected totals match recomputation',
  approx(exp.totals_kwh['light-a'], 0.02, TOL_VALUE) &&
  approx(exp.totals_kwh['fridge-b'], 0.01, TOL_VALUE) &&
  approx(exp.totals_kwh.office, 0.03, TOL_VALUE));

// ---- identities and references ----
const roomIds = new Set(ref.rooms.map((r) => r.room_id));
const devIds = new Set(ref.devices.map((d) => d.device_id));
const polKeys = new Set(ref.policies.map((p) => `${p.policy_id}:${p.version}`));
check('device rooms exist', ref.devices.every((d) => roomIds.has(d.room_id)));
check('interval rooms/devices exist',
  ref.device_intervals.every((d) => devIds.has(d.device_id) && roomIds.has(d.room_id)) &&
  ref.room_intervals.every((r) => roomIds.has(r.room_id)));
check('policy refs resolve', ref.device_intervals.every((d) => polKeys.has(d.policy_ref)));
// Kind-specific policy rule structures (dependency-free spot check mirroring
// the schema: required fields present, unknown fields rejected).
{
  const SPEC = {
    office_hours: { required: ['working_days_iso', 'open_local', 'close_local', 'overnight'], allowed: ['working_days_iso', 'open_local', 'close_local', 'overnight'] },
    lighting_schedule: { required: ['on_during_hours', 'vacancy_grace_seconds'], allowed: ['on_during_hours', 'vacancy_grace_seconds'] },
    device_schedule: { required: ['office_hours_ref'], allowed: ['office_hours_ref', 'on_windows', 'vacancy_grace_seconds', 'allow_manual_override'] },
    always_on: { required: ['always_on_exception'], allowed: ['always_on_exception'] },
    occupancy: { required: ['mode'], allowed: ['mode', 'auto_allocate'] },
  };
  for (const p of ref.policies) {
    const tag = `policy ${p.policy_id}:${p.version}`;
    const spec = SPEC[p.kind];
    check(`${tag} kind known`, !!spec, p.kind);
    if (!spec) continue;
    const keys = Object.keys(p.rules);
    check(`${tag} rules complete`, spec.required.every((k) => keys.includes(k)), keys.join(','));
    check(`${tag} rules closed (no unknown fields)`, keys.every((k) => spec.allowed.includes(k)), keys.join(','));
  }
}
const dKeys = ref.device_intervals.map((d) => `${d.run_id}|${d.device_id}|${d.interval_start_utc}`);
const rKeys = ref.room_intervals.map((r) => `${r.run_id}|${r.room_id}|${r.interval_start_utc}`);
check('device interval keys unique', new Set(dKeys).size === dKeys.length);
check('room interval keys unique', new Set(rKeys).size === rKeys.length);
check('single run_id throughout', new Set([...ref.device_intervals, ...ref.room_intervals].map((r) => r.run_id)).size === 1);
for (const id of devIds) {
  const rows = ref.device_intervals.filter((d) => d.device_id === id)
    .sort((a, b) => (a.interval_start_utc < b.interval_start_utc ? -1 : 1));
  check(`intervals contiguous for ${id}`, rows.every((r, i) => i === 0 || rows[i - 1].interval_end_utc === r.interval_start_utc));
}
check('energy formula holds on all device intervals (1e-9)',
  ref.device_intervals.every((d) => approx(d.energy_kwh, (d.avg_power_w * d.interval_seconds) / 3600000, TOL_VALUE)));
// Constant-fixture check only (CONTRACT.md §3.4): this asserts a property of the
// constant-load fixture, not a universal export constraint. Interval averages
// of V and I are not generally required to multiply into average real power.
check('constant-fixture V*I*pf relationship holds (rel 1e-9)',
  ref.device_intervals.every((d) => {
    if (d.avg_voltage_v == null || d.avg_current_a == null) return true;
    if (!(d.avg_power_w > 0)) return true; // never divide by zero at zero power
    const p = d.avg_voltage_v * d.avg_current_a * d.power_factor;
    return Math.abs(p - d.avg_power_w) / d.avg_power_w <= TOL_TRIPLE_REL;
  }));

// ---- manifest hashes ----
check('manifest lists files', Array.isArray(man.files) && man.files.length >= 8, man.files?.length);
check('manifest excludes itself', !man.files.some((f) => f.path.endsWith('manifest.json')));
for (const f of man.files) {
  const p = join(ROOT, f.path);
  check(`hash match: ${f.path}`, existsSync(p) && sha256(p) === f.sha256,
    existsSync(p) ? `got ${sha256(p).slice(0, 12)}… want ${String(f.sha256).slice(0, 12)}…` : 'missing');
}

// ---- CSV-alone reconstruction + full semantic parity (oracle: reference.json) ----
const numEq = (a, b) => approx(a, b, TOL_PARITY);
function objEq(a, b, path, errs) {
  if (typeof a === 'number' && typeof b === 'number') { if (!numEq(a, b)) errs.push(`${path}: ${a} != ${b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { errs.push(`${path}: length ${a.length} != ${b.length}`); return; }
    a.forEach((v, i) => objEq(v, b[i], `${path}[${i}]`, errs)); return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined).sort();
    const kb = Object.keys(b).filter((k) => b[k] !== undefined).sort();
    if (ka.join(',') !== kb.join(',')) { errs.push(`${path}: keys ${ka} != ${kb}`); return; }
    ka.forEach((k) => objEq(a[k], b[k], `${path}.${k}`, errs)); return;
  }
  if (a !== b) errs.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
let recon = null;
try {
  recon = reconstructFromCsv(csvRaw);
  check('CSV-alone reconstruction succeeds', true);
} catch (e) {
  check('CSV-alone reconstruction succeeds', false, e.code || e.message);
}
if (recon) {
  const errs = [];
  for (const k of ['schema_version', 'source', 'synthetic', 'synthetic_label']) objEq(recon[k], ref[k], k, errs);
  for (const k of ['building', 'run', 'export']) objEq(recon[k], ref[k], k, errs);
  const keyed = (arr, k) => new Map(arr.map((o) => [typeof k === 'function' ? k(o) : o[k], o]));
  for (const [name, ka, kb] of [
    ['rooms', keyed(recon.rooms, 'room_id'), keyed(ref.rooms, 'room_id')],
    ['devices', keyed(recon.devices, 'device_id'), keyed(ref.devices, 'device_id')],
    ['policies', keyed(recon.policies, (p) => `${p.policy_id}:${p.version}`), keyed(ref.policies, (p) => `${p.policy_id}:${p.version}`)],
    ['room_intervals', keyed(recon.room_intervals, (r) => `${r.room_id}|${r.interval_start_utc}`), keyed(ref.room_intervals, (r) => `${r.room_id}|${r.interval_start_utc}`)],
    ['device_intervals', keyed(recon.device_intervals, (d) => `${d.device_id}|${d.interval_start_utc}`), keyed(ref.device_intervals, (d) => `${d.device_id}|${d.interval_start_utc}`)],
  ]) {
    if (ka.size !== kb.size) { errs.push(`${name}: ${ka.size} != ${kb.size}`); continue; }
    for (const [k, v] of ka) {
      if (!kb.has(k)) { errs.push(`${name}: missing ${k}`); continue; }
      objEq(v, kb.get(k), `${name}.${k}`, errs);
    }
  }
  check('reconstructed dataset matches reference.json semantically', !errs.length, errs.slice(0, 5).join('; '));
  const envCount = parseCsv(csvRaw).slice(1).filter((r) => r[parseCsv(csvRaw)[0].indexOf('meta_run')].trim() !== '').length;
  check('exactly one metadata envelope, on the first data row', envCount === 1);
}

// ---- negative checks (mutated CSV must fail with the expected code) ----
{
  const rows = parseCsv(csvRaw);
  const H = rows[0];
  const mi = H.indexOf('meta_run');
  const pi = H.indexOf('policy_ref');
  const ti = H.indexOf('room_temp_c');
  const ser = (rs) => rs.map((r) => r.map(escCell).join(',')).join('\n') + '\n';
  const cases = [
    ['missing envelope fails', (rs) => rs.map((r, i) => (i ? [...r.slice(0, mi), ''] : r)), 'MISSING_ENVELOPE'],
    ['multiple envelopes fail', (rs) => rs.map((r, i) => (i === 2 ? [...r.slice(0, mi), rs[1][mi]] : r)), 'MULTIPLE_ENVELOPES'],
    ['unknown policy ref fails', (rs) => rs.map((r, i) => (i === 2 ? [...r.slice(0, pi), 'pol-nope:9', ...r.slice(pi + 1)] : r)), 'UNKNOWN_POLICY_REF'],
    ['conflicting room values fail', (rs) => [...rs, [...rs[2].slice(0, ti), '99.9', ...rs[2].slice(ti + 1)]], 'CONFLICTING_ROOM_VALUES'],
  ];
  for (const [name, mutate, code] of cases) {
    try {
      reconstructFromCsv(ser(mutate(rows)));
      check(`negative: ${name}`, false, 'reconstruction unexpectedly succeeded');
    } catch (e) {
      check(`negative: ${name}`, e.code === code, `got ${e.code || e.message}, want ${code}`);
    }
  }
}

// ---- rounding budget (in-memory 7 W / 44,640-interval check) ----
{
  const RB = exp.rounding_budget;
  const e = (RB.load_w * RB.interval_seconds) / 3600000;
  let acc = 0, accRounded = 0;
  for (let i = 0; i < RB.intervals; i++) { acc += e; accRounded += Math.round(e * 1e12) / 1e12; }
  check('analytic total matches expectation', approx((RB.load_w * RB.interval_seconds * RB.intervals) / 3600000, RB.analytic_total_kwh, 1e-12));
  check('rounded-interval sums stay within budget', approx(accRounded, RB.analytic_total_kwh, RB.budget_kwh), `|${accRounded} - ${RB.analytic_total_kwh}|`);
  check('unrounded accumulation is sane', approx(acc, RB.analytic_total_kwh, 1e-9));
}

// ---- fractional export precision (9dp power, 12dp energy, every nominal interval) ----
// Stored energy derives from UNROUNDED power; this checks the rounded exports
// stay consistent. It must not be "fixed" by computing energy from display power.
{
  const FP = exp.fractional_power_check;
  const r9 = (x) => Math.round(x * 1e9) / 1e9;
  const r12 = (x) => Math.round(x * 1e12) / 1e12;
  for (const t of FP.interval_seconds) {
    const eExact = (FP.power_w * t) / 3600000;
    const eExp = r12(eExact);
    const fromRoundedPower = (r9(FP.power_w) * t) / 3600000;
    check(`fractional ${FP.power_w} W / ${t}s exports consistent (1e-9 kWh)`,
      approx(eExp, fromRoundedPower, FP.tolerance_kwh), `|${eExp} - ${fromRoundedPower}|`);
    check(`fractional ${FP.power_w} W / ${t}s export rounding sane`,
      approx(eExp, eExact, 0.5e-12 + 1e-18));
  }
}

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
