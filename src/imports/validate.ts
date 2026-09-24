import { readFileSync } from 'node:fs';
import { createHash as cryptoHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { DatasetImport } from '../db/database.js';
import { ImportError, type ImportReport, type ValidationIssue } from './errors.js';

type Row = Record<string, unknown>;
type Dataset = DatasetImport['data'];
const MAX_ISSUES = 100;
const ENERGY_TOLERANCE_KWH = 1e-9;
const FORBIDDEN = new Set(['fault_active', 'fault_type', 'fault_window', 'fault_windows', 'injected_fault',
  'expected_diagnosis', 'expected_finding', 'is_fault', 'fault_label']);

const schema = JSON.parse(readFileSync(new URL('../../contracts/v1/dataset.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv2020({ strict: true, allErrors: false });
const validateSchema = ajv.compile(schema);

export class Issues {
  private readonly list: ValidationIssue[] = [];
  private total = 0;
  add(field: string, message: string, row?: number): void {
    this.total++;
    if (this.list.length < MAX_ISSUES) this.list.push(row === undefined ? { field, message } : { field, message, row });
  }
  get hasIssues(): boolean { return this.total > 0; }
  report(duplicates: number): ImportReport {
    return { errors: this.list, warnings: duplicates ? [`${duplicates} identical duplicate record(s) removed`] : [],
      duplicates_deduped: duplicates, additional_errors: this.total > this.list.length };
  }
  throwIfAny(duplicates: number): void {
    if (!this.hasIssues) return;
    const first = this.list[0]!;
    throw new ImportError(422, 'VALIDATION_ERROR', 'Uploaded dataset failed validation', this.report(duplicates), first.field, first.row);
  }
}

export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

function* canonicalChunks(value: unknown, path = ''): Generator<string> {
  if (Array.isArray(value)) {
    const recordsSortedByIdentity = ['rooms', 'devices', 'policies', 'room_intervals', 'device_intervals'].includes(path);
    const sorted = recordsSortedByIdentity ? value : [...value].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    yield '[';
    for (let i = 0; i < sorted.length; i++) { if (i) yield ','; yield* canonicalChunks(sorted[i], `${path}[]`); }
    yield ']';
    return;
  }
  if (value && typeof value === 'object') {
    const row = value as Row;
    const keys = Object.keys(row).filter((key) => !(path === '' && ['created_note', 'source'].includes(key))
      && !(['run', 'room_intervals[]', 'device_intervals[]'].includes(path) && key === 'run_id')
      && !(path === 'export' && key === 'created_utc')
      && !(path === 'export' && key === 'export_id')).sort();
    yield '{';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!; if (i) yield ',';
      yield `${JSON.stringify(key)}:`;
      yield* canonicalChunks(row[key], path ? `${path}.${key}` : key);
    }
    yield '}';
    return;
  }
  yield JSON.stringify(value) ?? 'null';
}

function rowKey(row: Row, fields: string[]): string { return fields.map((field) => String(row[field])).join('\u0000'); }

function dedupe(rows: Row[], fields: string[], name: string, issues: Issues): { rows: Row[]; count: number } {
  const byKey = new Map<string, Row>();
  let count = 0;
  for (const row of rows) {
    const key = rowKey(row, fields);
    const previous = byKey.get(key);
    if (!previous) byKey.set(key, row);
    else if (canonicalJson(previous) === canonicalJson(row)) count++;
    else issues.add(name, `Conflicting duplicate record for key ${key.replaceAll('\u0000', '/')}`, sourceRow(row));
  }
  return { rows: [...byKey.values()], count };
}

function actualUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace('.000Z', 'Z') === value;
}

function scanForbidden(value: unknown, path: string, issues: Issues): void {
  if (Array.isArray(value)) { value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, issues)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (FORBIDDEN.has(key)) issues.add(field, 'Forbidden fault-label fields are not accepted');
    scanForbidden(child, field, issues);
  }
}

function asRow(value: unknown): Row { return value as Row; }
function str(row: Row, key: string): string { return String(row[key]); }
function num(row: Row, key: string): number { return Number(row[key]); }
function bool(row: Row, key: string): boolean { return row[key] === true; }
function sourceRow(row: Row): number | undefined {
  return typeof row.__source_row === 'number' ? row.__source_row : undefined;
}

export interface ValidatedDataset { data: Dataset; semanticFingerprint: string; duplicatesDeduped: number; report: ImportReport; }

export function validateAndFingerprint(raw: unknown, _sourceFormat: 'csv' | 'json', suppliedDuplicates = 0): ValidatedDataset {
  const issues = new Issues();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add('/', 'Dataset must be a JSON object');
    issues.throwIfAny(suppliedDuplicates);
  }
  const data = raw as Dataset;
  const candidate = raw as Row;
  if ((Array.isArray(candidate.device_intervals) && candidate.device_intervals.length > 1_100_000)
    || (Array.isArray(candidate.room_intervals) && candidate.room_intervals.length > 250_000)) {
    throw new ImportError(413, 'REQUEST_TOO_LARGE', 'Dataset exceeds supported interval record limits',
      { errors: [], warnings: [], duplicates_deduped: suppliedDuplicates, additional_errors: false });
  }
  scanForbidden(raw, '', issues);
  let duplicates = suppliedDuplicates;

  if (data.schema_version !== '1.0.1') {
    throw new ImportError(422, 'UNSUPPORTED_VERSION', 'Only dataset schema version 1.0.1 is supported',
      { errors: [{ field: 'schema_version', message: 'Expected 1.0.1' }], warnings: [], duplicates_deduped: duplicates, additional_errors: false }, 'schema_version');
  }

  if (!validateSchema(raw)) {
    const err = validateSchema.errors?.[0];
    const field = (err?.instancePath || '/') + (err?.keyword === 'required' ? `/${String(err.params.requiredProperty)}` : '');
    issues.add(field, `Schema validation failed: ${err?.keyword ?? 'invalid'}`);
  }
  issues.throwIfAny(duplicates);
  const metadata = { schema_version: data.schema_version, source: data.source, synthetic: data.synthetic,
    synthetic_label: data.synthetic_label, created_note: data.created_note, building: data.building, run: data.run, export: data.export,
    rooms: data.rooms, devices: data.devices, policies: data.policies };
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8 * 1024 * 1024) {
    throw new ImportError(413, 'REQUEST_TOO_LARGE', 'Dataset metadata exceeds 8 MiB',
      { errors: [], warnings: [], duplicates_deduped: duplicates, additional_errors: false });
  }
  if (data.device_intervals.length > 1_100_000 || data.room_intervals.length > 250_000) {
    throw new ImportError(413, 'REQUEST_TOO_LARGE', 'Dataset exceeds supported interval record limits',
      { errors: [], warnings: [], duplicates_deduped: duplicates, additional_errors: false });
  }

  const specs: Array<[keyof Dataset, string[], string]> = [
    ['rooms', ['room_id'], 'rooms'], ['devices', ['device_id'], 'devices'],
    ['policies', ['policy_id', 'version'], 'policies'],
    ['room_intervals', ['run_id', 'room_id', 'interval_start_utc'], 'room_intervals'],
    ['device_intervals', ['run_id', 'device_id', 'interval_start_utc'], 'device_intervals'],
  ];
  for (const [key, fields, name] of specs) {
    const result = dedupe(data[key] as Row[], fields, name, issues);
    (data[key] as Row[]) = result.rows;
    duplicates += result.count;
  }
  semanticChecks(data, issues);
  issues.throwIfAny(duplicates);

  const sortFields: Partial<Record<keyof Dataset, string[]>> = {
    rooms: ['room_id'], devices: ['device_id'], policies: ['policy_id', 'version'],
    room_intervals: ['run_id', 'room_id', 'interval_start_utc'],
    device_intervals: ['run_id', 'device_id', 'interval_start_utc'],
  };
  for (const [key, fields] of Object.entries(sortFields) as Array<[keyof Dataset, string[]]>) {
    (data[key] as Row[]).sort((a, b) => rowKey(a, fields).localeCompare(rowKey(b, fields)));
  }
  const fingerprint = createHashStream(canonicalChunks(data));
  return { data, semanticFingerprint: fingerprint, duplicatesDeduped: duplicates, report: issues.report(duplicates) };
}

function createHashStream(chunks: Generator<string>): string {
  const hash = cryptoHash('sha256');
  let batch: string[] = [];
  let batchLength = 0;
  for (const chunk of chunks) {
    batch.push(chunk);
    batchLength += chunk.length;
    if (batchLength >= 64 * 1024) {
      hash.update(batch.join(''));
      batch = [];
      batchLength = 0;
    }
  }
  if (batch.length) hash.update(batch.join(''));
  return hash.digest('hex');
}

function semanticChecks(data: Dataset, issues: Issues): void {
  const building = asRow(data.building); const run = asRow(data.run); const exp = asRow(data.export);
  const start = str(exp, 'export_start_utc'); const end = str(exp, 'export_end_utc');
  const nominal = num(exp, 'interval_seconds');
  const runStart = str(run, 'run_start_utc');
  const startMs = actualUtc(start) ? Date.parse(start) : NaN;
  const endMs = actualUtc(end) ? Date.parse(end) : NaN;
  const runStartMs = actualUtc(runStart) ? Date.parse(runStart) : NaN;
  if (!Number.isFinite(startMs)) issues.add('export.export_start_utc', 'Must be a real UTC calendar timestamp');
  if (!Number.isFinite(endMs)) issues.add('export.export_end_utc', 'Must be a real UTC calendar timestamp');
  if (!Number.isFinite(runStartMs)) issues.add('run.run_start_utc', 'Must be a real UTC calendar timestamp');
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) issues.add('export.export_end_utc', 'Must be later than export_start_utc');
  if (Number.isFinite(runStartMs) && Number.isFinite(startMs) && runStartMs > startMs) issues.add('run.run_start_utc', 'Cannot be later than export start');
  if (exp.created_utc !== undefined && !actualUtc(exp.created_utc)) issues.add('export.created_utc', 'Must be a real UTC calendar timestamp');
  else if (actualUtc(exp.created_utc) && Date.parse(str(exp, 'created_utc')) < endMs) issues.add('export.created_utc', 'Cannot precede export end');
  if (str(building, 'timezone') !== 'Asia/Kolkata') issues.add('building.timezone', 'Contract 1.0.1 requires Asia/Kolkata');

  const rooms = new Map(data.rooms.map((item) => [str(asRow(item), 'room_id'), asRow(item)]));
  const devices = new Map(data.devices.map((item) => [str(asRow(item), 'device_id'), asRow(item)]));
  const policies = new Map(data.policies.map((item) => [`${str(asRow(item), 'policy_id')}:${num(asRow(item), 'version')}`, asRow(item)]));
  for (const [index, item] of data.devices.entries()) {
    if (!rooms.has(str(asRow(item), 'room_id'))) issues.add(`devices[${index}].room_id`, 'References an unknown room');
  }
  for (const [index, item] of data.policies.entries()) {
    const policy = asRow(item); const rules = asRow(policy.rules);
    if (!actualUtc(policy.effective_from_utc)) issues.add(`policies[${index}].effective_from_utc`, 'Must be a real UTC calendar timestamp');
    const appliesTo = str(policy, 'applies_to');
    if (appliesTo.startsWith('device:') && !devices.has(appliesTo.slice('device:'.length))) issues.add(`policies[${index}].applies_to`, 'References an unknown device');
    else if (appliesTo.startsWith('room:') && !rooms.has(appliesTo.slice('room:'.length))) issues.add(`policies[${index}].applies_to`, 'References an unknown room');
    else if (appliesTo.startsWith('building:') && appliesTo.slice('building:'.length) !== str(building, 'building_id')) issues.add(`policies[${index}].applies_to`, 'References a different building');
    else if (!['device:', 'room:', 'building:'].some((prefix) => appliesTo.startsWith(prefix))) issues.add(`policies[${index}].applies_to`, 'Must identify a dataset building, room or device');
    if (policy.kind === 'device_schedule') {
      const office = policies.get(str(rules, 'office_hours_ref'));
      if (!office) issues.add(`policies[${index}].rules.office_hours_ref`, 'References an unknown policy version');
      else if (office.kind !== 'office_hours') issues.add(`policies[${index}].rules.office_hours_ref`, 'Must reference an office_hours policy');
    }
  }

  const roomSlotKeys = new Set(data.room_intervals.map((item) => {
    const row = asRow(item); return `${str(row, 'room_id')}\u0000${str(row, 'interval_start_utc')}\u0000${str(row, 'interval_end_utc')}`;
  }));
  const deviceById = new Map<string, Row[]>();
  for (const [index, item] of data.device_intervals.entries()) {
    const row = asRow(item); const field = `device_intervals[${index}]`;
    const csvRow = sourceRow(row);
    const deviceId = str(row, 'device_id'); const device = devices.get(deviceId);
    if (!device) issues.add(`${field}.device_id`, 'References an unknown device', csvRow);
    else if (str(row, 'room_id') !== str(device, 'room_id')) issues.add(`${field}.room_id`, 'Does not match the device inventory room', csvRow);
    if (str(row, 'run_id') !== str(run, 'run_id')) issues.add(`${field}.run_id`, 'Does not match run.run_id', csvRow);
    const policyRef = str(row, 'policy_ref'); const policy = policies.get(policyRef);
    if (!policy) issues.add(`${field}.policy_ref`, 'References an unknown policy version', csvRow);
    else {
      if (str(policy, 'applies_to') !== `device:${deviceId}`) issues.add(`${field}.policy_ref`, 'Policy version does not apply to this device', csvRow);
      if (actualUtc(policy.effective_from_utc) && actualUtc(row.interval_start_utc)
        && Date.parse(str(policy, 'effective_from_utc')) > Date.parse(str(row, 'interval_start_utc'))) {
        issues.add(`${field}.policy_ref`, 'Policy version is not yet effective at this interval', csvRow);
      }
    }
    const s = str(row, 'interval_start_utc'); const e = str(row, 'interval_end_utc');
    const sMs = actualUtc(s) ? Date.parse(s) : NaN; const eMs = actualUtc(e) ? Date.parse(e) : NaN;
    if (!Number.isFinite(sMs)) issues.add(`${field}.interval_start_utc`, 'Must be a real UTC calendar timestamp', csvRow);
    if (!Number.isFinite(eMs)) issues.add(`${field}.interval_end_utc`, 'Must be a real UTC calendar timestamp', csvRow);
    const duration = num(row, 'interval_seconds');
    if (Number.isFinite(sMs) && Number.isFinite(eMs)) {
      if (eMs - sMs !== duration * 1000) issues.add(`${field}.interval_seconds`, 'Must equal the timestamp boundary duration', csvRow);
      if (sMs < startMs || eMs > endMs || eMs <= sMs) issues.add(field, 'Interval must fall within the export range', csvRow);
      if (!roomSlotKeys.has(`${str(row, 'room_id')}\u0000${s}\u0000${e}`)) issues.add('room_intervals', 'Every device slot requires matching room readings', csvRow);
    }
    if (duration > nominal || (duration < nominal && !bool(row, 'partial'))) issues.add(`${field}.interval_seconds`, 'Only partial edge intervals may be shorter than the nominal interval', csvRow);
    if (bool(row, 'partial') && s !== start && e !== end) issues.add(`${field}.partial`, 'Partial intervals are allowed only at export edges', csvRow);
    if (num(row, 'max_power_w') < num(row, 'avg_power_w')) issues.add(`${field}.max_power_w`, 'Must be greater than or equal to average power', csvRow);
    if (Math.abs(num(row, 'energy_kwh') - num(row, 'avg_power_w') * duration / 3600000) > ENERGY_TOLERANCE_KWH) issues.add(`${field}.energy_kwh`, 'Does not reconcile with average power and duration (1e-9 kWh tolerance)', csvRow);
    for (const key of ['override_seconds', 'vacant_on_seconds', 'offschedule_on_seconds']) if (num(row, key) > duration) issues.add(`${field}.${key}`, 'Cannot exceed interval duration', csvRow);
    const group = deviceById.get(deviceId) ?? []; group.push(row); deviceById.set(deviceId, group);
  }
  let referenceSlots: string[] | undefined;
  for (const [deviceId, records] of deviceById) {
    records.sort((a, b) => str(a, 'interval_start_utc').localeCompare(str(b, 'interval_start_utc')));
    const timeline = records.map((item) => `${str(item, 'interval_start_utc')}\u0000${str(item, 'interval_end_utc')}`);
    if (!referenceSlots) referenceSlots = timeline;
    else if (timeline.length !== referenceSlots.length || timeline.some((slot, i) => slot !== referenceSlots![i])) issues.add(`device_intervals.${deviceId}`, 'Device coverage must match every other device without gaps', sourceRow(records[0]!));
    if (records.length && (str(records[0]!, 'interval_start_utc') !== start || str(records.at(-1)!, 'interval_end_utc') !== end)) issues.add(`device_intervals.${deviceId}`, 'Device coverage must span the complete export range', sourceRow(records[0]!));
    for (let i = 0; i < records.length; i++) {
      const row = records[i]!;
      if (i > 0) {
        const previous = records[i - 1]!;
        if (str(row, 'interval_start_utc') < str(previous, 'interval_end_utc')) issues.add(`device_intervals.${deviceId}`, 'Intervals overlap', sourceRow(row));
        else if (str(row, 'interval_start_utc') !== str(previous, 'interval_end_utc')) issues.add(`device_intervals.${deviceId}`, 'Missing interval gap; missing readings are not zero', sourceRow(row));
        const delta = num(row, 'cumulative_kwh') - num(previous, 'cumulative_kwh');
        if (Math.abs(delta - num(row, 'energy_kwh')) > ENERGY_TOLERANCE_KWH) issues.add(`device_intervals.${deviceId}[${i}].cumulative_kwh`, 'Counter delta does not reconcile with interval energy', sourceRow(row));
      } else if (!bool(row, 'partial') && Math.abs(num(row, 'cumulative_kwh') - num(row, 'energy_kwh')) > ENERGY_TOLERANCE_KWH) {
        issues.add(`device_intervals.${deviceId}[0].cumulative_kwh`, 'First full-export counter must reconcile with first interval energy', sourceRow(row));
      }
    }
  }
  for (const deviceId of devices.keys()) if (!deviceById.has(deviceId)) issues.add(`device_intervals.${deviceId}`, 'Export coverage is missing all readings for this device');

  const roomGroups = new Map<string, Row[]>();
  for (const [index, item] of data.room_intervals.entries()) {
    const row = asRow(item); const field = `room_intervals[${index}]`; const roomId = str(row, 'room_id'); const room = rooms.get(roomId);
    const csvRow = sourceRow(row);
    if (!room) issues.add(`${field}.room_id`, 'References an unknown room', csvRow);
    if (str(row, 'run_id') !== str(run, 'run_id')) issues.add(`${field}.run_id`, 'Does not match run.run_id', csvRow);
    const s = str(row, 'interval_start_utc'); const e = str(row, 'interval_end_utc');
    const sMs = actualUtc(s) ? Date.parse(s) : NaN; const eMs = actualUtc(e) ? Date.parse(e) : NaN;
    if (!Number.isFinite(sMs)) issues.add(`${field}.interval_start_utc`, 'Must be a real UTC calendar timestamp', csvRow);
    if (!Number.isFinite(eMs)) issues.add(`${field}.interval_end_utc`, 'Must be a real UTC calendar timestamp', csvRow);
    const duration = num(row, 'interval_seconds');
    if (Number.isFinite(sMs) && Number.isFinite(eMs) && (eMs - sMs !== duration * 1000 || sMs < startMs || eMs > endMs || eMs <= sMs)) issues.add(field, 'Duration/boundaries must be valid and within export range', csvRow);
    if (duration > nominal || (duration < nominal && !bool(row, 'partial'))) issues.add(`${field}.interval_seconds`, 'Only partial edge intervals may be shorter than the nominal interval', csvRow);
    if (bool(row, 'partial') && s !== start && e !== end) issues.add(`${field}.partial`, 'Partial intervals are allowed only at export edges', csvRow);
    if (room && (num(row, 'occupancy_avg') > num(room, 'capacity') || num(row, 'occupancy_max') > num(room, 'capacity'))) issues.add(field, 'Occupancy exceeds room capacity', csvRow);
    if (num(row, 'occupancy_avg') > num(row, 'occupancy_max')) issues.add(`${field}.occupancy_avg`, 'Cannot exceed occupancy_max', csvRow);
    const group = roomGroups.get(roomId) ?? []; group.push(row); roomGroups.set(roomId, group);
  }
  for (const [roomId, records] of roomGroups) {
    records.sort((a, b) => str(a, 'interval_start_utc').localeCompare(str(b, 'interval_start_utc')));
    const timeline = records.map((item) => `${str(item, 'interval_start_utc')}\u0000${str(item, 'interval_end_utc')}`);
    if (referenceSlots && (timeline.length !== referenceSlots.length || timeline.some((slot, i) => slot !== referenceSlots![i]))) issues.add(`room_intervals.${roomId}`, 'Room coverage must match the export grid without gaps', sourceRow(records[0]!));
  }
  for (const roomId of rooms.keys()) if (!roomGroups.has(roomId)) issues.add(`room_intervals.${roomId}`, 'Export coverage is missing all readings for this room');
}
