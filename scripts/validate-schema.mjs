// validate-schema.mjs — formal JSON Schema (Draft 2020-12) validation of the
// contract v1.0.1 bundle. Run from the repository root:
//   npm run validate:schema      (or: node scripts/validate-schema.mjs)
//
// Uses Ajv's Draft 2020-12 build (`ajv/dist/2020`) in strict mode. The schema
// uses no `format` keyword, so no format plugin is loaded.
//
// Scope: the schema is valid against the 2020-12 meta-schema and compiles;
// fixtures/reference.json validates; mutated in-memory copies that break the
// structural rules are rejected for the expected reason. contracts/v1 is
// read-only — nothing here writes to it.
//
// NOT covered by JSON Schema (and not claimed here): cross-record arithmetic
// (energy/counter reconciliation, totals), foreign-key references
// (device→room, policy_ref→policy, office_hours_ref), key uniqueness,
// contiguity, CSV parity. Those remain semantic checks in
// scripts/verify-contract.mjs.
//
// This file is agent-owned tooling, not part of the contract bundle; an
// identical copy lives in simulation-backend and auditor-backend.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1 = join(ROOT, 'contracts', 'v1');
const schema = JSON.parse(readFileSync(join(V1, 'dataset.schema.json'), 'utf8'));
const reference = JSON.parse(readFileSync(join(V1, 'fixtures', 'reference.json'), 'utf8'));
const ajvVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'ajv', 'package.json'), 'utf8')).version;

let passes = 0;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passes++; console.log(`PASS  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const fmt = (errors) => (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.keyword} ${JSON.stringify(e.params)}`).join('; ');

console.log(`Ajv ${ajvVersion} (Draft 2020-12, strict mode, allErrors)`);

const ajv = new Ajv2020({ strict: true, allErrors: true });

check('schema declares Draft 2020-12', schema.$schema === 'https://json-schema.org/draft/2020-12/schema', String(schema.$schema));
const metaOk = ajv.validateSchema(schema);
check('schema is valid against the Draft 2020-12 meta-schema', metaOk === true, fmt(ajv.errors));

let validate;
try {
  validate = ajv.compile(schema);
  check('schema compiles (strict mode)', true);
} catch (err) {
  check('schema compiles (strict mode)', false, err.message);
  console.log(`\nRESULT: ${passes} passed, ${failures} failed.`);
  process.exit(1);
}

check('fixtures/reference.json validates', validate(reference) === true, fmt(validate.errors));

// Positive in-memory variants — prove the closed rule sets accept valid
// policies of the kinds absent from the fixture, so the negatives below fail
// for the stated reason rather than for an unrelated one.
const deviceSchedule = {
  policy_id: 'pol-dev-sched', version: 1, applies_to: 'device:light-a', kind: 'device_schedule',
  effective_from_utc: '2026-09-21T03:30:00Z',
  rules: {
    office_hours_ref: 'pol-hours:1',
    on_windows: [{ days: [1, 2, 3, 4, 5], start_local: '09:00', end_local: '18:00' }],
    vacancy_grace_seconds: 300, allow_manual_override: true,
  },
};
const occupancy = {
  policy_id: 'pol-occ', version: 1, applies_to: 'building:fixture-office', kind: 'occupancy',
  effective_from_utc: '2026-09-21T03:30:00Z', rules: { mode: 'manual', auto_allocate: true },
};
const withPolicies = (...extra) => { const d = structuredClone(reference); d.policies.push(...structuredClone(extra)); return d; };
{
  const d = withPolicies(deviceSchedule, occupancy);
  check('variant: valid device_schedule + occupancy policies validate', validate(d) === true, fmt(validate.errors));
}

// Negative checks. Each mutates a fresh deep copy and must be rejected with an
// error of the expected keyword at the expected instance path.
const negative = (name, mutate, expect) => {
  const doc = structuredClone(reference);
  mutate(doc);
  const ok = validate(doc);
  const errs = validate.errors ?? [];
  const matched = errs.some((e) => e.keyword === expect.keyword && e.instancePath === expect.path
    && (!expect.param || Object.entries(expect.param).every(([k, v]) => e.params[k] === v)));
  check(`reject: ${name}`, ok === false && matched,
    ok ? 'validated unexpectedly' : `expected ${expect.keyword} at ${expect.path || '/'}; got ${fmt(errs)}`);
};
const pIndex = (kind) => reference.policies.findIndex((p) => p.kind === kind);

// Missing required fields.
negative('missing top-level required field "run"', (d) => { delete d.run; },
  { keyword: 'required', path: '', param: { missingProperty: 'run' } });
negative('missing device_intervals[0].energy_kwh', (d) => { delete d.device_intervals[0].energy_kwh; },
  { keyword: 'required', path: '/device_intervals/0', param: { missingProperty: 'energy_kwh' } });
negative('missing room_intervals[0].occupied_fraction', (d) => { delete d.room_intervals[0].occupied_fraction; },
  { keyword: 'required', path: '/room_intervals/0', param: { missingProperty: 'occupied_fraction' } });
negative('missing office_hours rules.overnight', (d) => { delete d.policies[pIndex('office_hours')].rules.overnight; },
  { keyword: 'required', path: `/policies/${pIndex('office_hours')}/rules`, param: { missingProperty: 'overnight' } });

// Unknown interval fields.
negative('unknown device interval field', (d) => { d.device_intervals[0].extra_field = 1; },
  { keyword: 'additionalProperties', path: '/device_intervals/0', param: { additionalProperty: 'extra_field' } });
negative('unknown room interval field', (d) => { d.room_intervals[0].extra_field = 1; },
  { keyword: 'additionalProperties', path: '/room_intervals/0', param: { additionalProperty: 'extra_field' } });
negative('device interval fault_active field', (d) => { d.device_intervals[0].fault_active = true; },
  { keyword: 'additionalProperties', path: '/device_intervals/0', param: { additionalProperty: 'fault_active' } });

// Invalid fractions.
negative('device on_fraction 1.5 (> 1)', (d) => { d.device_intervals[0].on_fraction = 1.5; },
  { keyword: 'maximum', path: '/device_intervals/0/on_fraction' });
negative('device on_fraction -0.1 (< 0)', (d) => { d.device_intervals[0].on_fraction = -0.1; },
  { keyword: 'minimum', path: '/device_intervals/0/on_fraction' });
negative('room occupied_fraction 1.01 (> 1)', (d) => { d.room_intervals[0].occupied_fraction = 1.01; },
  { keyword: 'maximum', path: '/room_intervals/0/occupied_fraction' });
negative('room occupied_fraction as string', (d) => { d.room_intervals[0].occupied_fraction = '0.5'; },
  { keyword: 'type', path: '/room_intervals/0/occupied_fraction' });

// Unknown policy-rule fields — every kind (fixture kinds + in-memory variants).
for (const kind of ['office_hours', 'lighting_schedule', 'always_on']) {
  const i = pIndex(kind);
  negative(`unknown ${kind} rule field`, (d) => { d.policies[i].rules.unknown_rule = 1; },
    { keyword: 'additionalProperties', path: `/policies/${i}/rules`, param: { additionalProperty: 'unknown_rule' } });
}
for (const [kind, pol] of [['device_schedule', deviceSchedule], ['occupancy', occupancy]]) {
  const i = reference.policies.length;
  negative(`unknown ${kind} rule field`, (d) => { d.policies.push({ ...structuredClone(pol), rules: { ...pol.rules, unknown_rule: 1 } }); },
    { keyword: 'additionalProperties', path: `/policies/${i}/rules`, param: { additionalProperty: 'unknown_rule' } });
}

// Policy-rule fault_active field.
negative('lighting_schedule rules.fault_active', (d) => { d.policies[pIndex('lighting_schedule')].rules.fault_active = true; },
  { keyword: 'additionalProperties', path: `/policies/${pIndex('lighting_schedule')}/rules`, param: { additionalProperty: 'fault_active' } });
negative('always_on rules.fault_active', (d) => { d.policies[pIndex('always_on')].rules.fault_active = false; },
  { keyword: 'additionalProperties', path: `/policies/${pIndex('always_on')}/rules`, param: { additionalProperty: 'fault_active' } });

// Version pin.
negative('schema_version "1.0.0"', (d) => { d.schema_version = '1.0.0'; },
  { keyword: 'const', path: '/schema_version' });

console.log(`\nRESULT: ${passes} passed, ${failures} failed.`);
console.log('NOTE: structural JSON Schema validation only — cross-record arithmetic and');
console.log('      foreign-key references remain semantic checks (scripts/verify-contract.mjs).');
process.exit(failures ? 1 : 0);
