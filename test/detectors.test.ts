import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aggregateSection, resolutionCandidates } from '../src/analysis/aggregate.js';
import { AnalysisBatchRunner } from '../src/analysis/batches.js';
import { PythonAnalysisClient } from '../src/analysis/client.js';
import { DeviceDetectorRunner, MAX_SECTION_RECORDS, isDetectorId } from '../src/analysis/detectors.js';
import { AnalysisJobManager } from '../src/analysis/jobs.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuditorDatabase, type DatasetImport, type StoredAnalysisInterval } from '../src/db/database.js';

type Row = Record<string, unknown>;

const REQUEST_ID = '12345678-1234-4234-9234-123456789abc';
const envelope = (data: unknown): Response => Response.json({ data, meta: { request_id: REQUEST_ID } });
const LOCAL_OFFSET_MS = 19_800_000;
const iso = (epochMs: number): string => new Date(epochMs).toISOString().replace('.000Z', 'Z');
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value as Row[] : []);
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const localDay = (startUtc: string): number => Math.floor((Date.parse(startUtc) + LOCAL_OFFSET_MS) / 86_400_000);

// ---------------------------------------------------------------------------
// Deterministic aggregation (P026 §5): only valid fully-on bins may be emitted.
// ---------------------------------------------------------------------------

function minuteRows(count: number, options: { power?: number; onFraction?: number | null; partial?: boolean;
  policyVersion?: number; startUtc?: string; roomId?: string } = {}): StoredAnalysisInterval[] {
  const start = Date.parse(options.startUtc ?? '2026-01-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * 60_000;
    const power = options.power ?? 600;
    return {
      run_id: 'run-1', room_id: options.roomId ?? 'room-a', device_id: 'light-a',
      interval_start_utc: iso(from), interval_end_utc: iso(from + 60_000), interval_seconds: 60,
      avg_power_w: power, energy_kwh: power / 60_000, vacant_on_seconds: 0, offschedule_on_seconds: 0,
      override_seconds: 0, max_power_w: power, cumulative_kwh: 0, avg_voltage_v: 230, avg_current_a: 1,
      power_factor: 1, on_fraction: options.onFraction === null ? null : options.onFraction ?? 1,
      policy_id: 'pol-light-a', policy_version: options.policyVersion ?? 1,
      partial: options.partial ?? false,
    } as StoredAnalysisInterval;
  });
}

function roomMinutes(count: number, startUtc = '2026-01-01T00:00:00Z'): StoredAnalysisInterval[] {
  const start = Date.parse(startUtc);
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * 60_000;
    return {
      run_id: 'run-1', room_id: 'room-a', interval_start_utc: iso(from), interval_end_utc: iso(from + 60_000),
      interval_seconds: 60, occupancy_avg: 2, occupancy_max: 2, occupied_fraction: 1,
      avg_temp_c: 26, avg_rh_pct: 55, partial: false,
    } as StoredAnalysisInterval;
  });
}

const WINDOW = { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-01T01:00:00Z' };

test('aggregation emits only contiguous, non-partial, fully-on, single-policy bins with room context', () => {
  const section = aggregateSection({ deviceRows: minuteRows(60), roomRows: roomMinutes(60), resolutionSeconds: 3600,
    storedIntervalSeconds: 60, windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.equal(section.device_intervals.length, 1);
  assert.equal(section.room_intervals.length, 1);
  assert.deepEqual(section.report.excluded_device_bins, {});
  const [device] = section.device_intervals;
  assert.deepEqual(device, {
    run_id: 'run-1', room_id: 'room-a', device_id: 'light-a',
    interval_start_utc: '2026-01-01T00:00:00Z', interval_end_utc: '2026-01-01T01:00:00Z', interval_seconds: 3600,
    avg_power_w: 600, energy_kwh: 0.6, vacant_on_seconds: 0, offschedule_on_seconds: 0,
    policy_ref: 'pol-light-a:1', on_fraction: 1, partial: false, max_power_w: 600, override_seconds: 0,
    avg_voltage_v: 230, avg_current_a: 1, power_factor: 1,
  });
  const [room] = section.room_intervals;
  assert.deepEqual(room, { run_id: 'run-1', room_id: 'room-a', interval_start_utc: '2026-01-01T00:00:00Z',
    interval_end_utc: '2026-01-01T01:00:00Z', interval_seconds: 3600, occupancy_avg: 2, occupancy_max: 2,
    occupied_fraction: 1, partial: false, avg_temp_c: 26, avg_rh_pct: 55 });

  const mixed = aggregateSection({ deviceRows: minuteRows(60, { onFraction: 0.5 }), roomRows: roomMinutes(60),
    resolutionSeconds: 3600, storedIntervalSeconds: 60, windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.equal(mixed.device_intervals.length, 0, 'mixed duty is never averaged into a fully-on observation');
  assert.deepEqual(mixed.report.excluded_device_bins, { mixed_duty_or_off: 1 });

  const unknownDuty = aggregateSection({ deviceRows: minuteRows(60, { onFraction: null }), roomRows: roomMinutes(60),
    resolutionSeconds: 3600, storedIntervalSeconds: 60, windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.deepEqual(unknownDuty.report.excluded_device_bins, { duty_unknown: 1 });

  const partial = aggregateSection({ deviceRows: minuteRows(60, { partial: true }), roomRows: roomMinutes(60),
    resolutionSeconds: 3600, storedIntervalSeconds: 60, windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.deepEqual(partial.report.excluded_device_bins, { partial_or_incomplete_readings: 1 });

  const gap = aggregateSection({ deviceRows: minuteRows(30).concat(minuteRows(29, { startUtc: '2026-01-01T00:31:00Z' })),
    roomRows: roomMinutes(60), resolutionSeconds: 3600, storedIntervalSeconds: 60,
    windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.deepEqual(gap.report.excluded_device_bins, { partial_or_incomplete_readings: 1 }, 'missing readings break tiling and are never zero-filled');

  const policyChange = aggregateSection({ deviceRows: minuteRows(30).concat(minuteRows(30, { startUtc: '2026-01-01T00:30:00Z', policyVersion: 2 })),
    roomRows: roomMinutes(60), resolutionSeconds: 3600, storedIntervalSeconds: 60,
    windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.deepEqual(policyChange.report.excluded_device_bins, { policy_change: 1 });

  const missingRoom = aggregateSection({ deviceRows: minuteRows(60), roomRows: roomMinutes(30), resolutionSeconds: 3600,
    storedIntervalSeconds: 60, windowStartUtc: WINDOW.start_utc, windowEndUtc: WINDOW.end_utc });
  assert.deepEqual(missingRoom.report.excluded_device_bins, { missing_room_context: 1 });
  assert.equal(missingRoom.device_intervals.length, 0);

  assert.deepEqual(resolutionCandidates(60), [60, 300, 600, 900, 1800, 3600]);
  assert.deepEqual(resolutionCandidates(900), [900, 1800, 3600]);
  assert.deepEqual(resolutionCandidates(3600), [3600]);
});

// ---------------------------------------------------------------------------
// Fixtures and a documented simplified Python stand-in. The stand-in mirrors
// the committed detectors' comparability rules and the status distinctions the
// assignment requires; it does NOT prove Python's own detection (that is the
// separate real-integration check).
// ---------------------------------------------------------------------------

interface DatasetSpec {
  datasetId: string;
  resolutionSeconds: number;
  startUtc: string;
  endUtc: string;
  deviceId: string;
  deviceType: string;
  appliesTo: string;
  power: (offsetSeconds: number) => number;
  onFraction?: (offsetSeconds: number) => number;
}

function buildDataset(spec: DatasetSpec): DatasetImport['data'] {
  const start = Date.parse(spec.startUtc);
  const end = Date.parse(spec.endUtc);
  const step = spec.resolutionSeconds * 1000;
  const roomId = 'room-a';
  const device_intervals: Row[] = [];
  const room_intervals: Row[] = [];
  for (let at = start; at < end; at += step) {
    const offset = (at - start) / 1000;
    const power = spec.power(offset);
    const onFraction = spec.onFraction?.(offset) ?? 1;
    device_intervals.push({ run_id: 'run-detector-001', room_id: roomId, device_id: spec.deviceId,
      interval_start_utc: iso(at), interval_end_utc: iso(at + step), interval_seconds: spec.resolutionSeconds,
      avg_power_w: power, max_power_w: power, energy_kwh: power * spec.resolutionSeconds / 3_600_000, cumulative_kwh: 0,
      avg_voltage_v: 230, avg_current_a: 1, power_factor: 1, on_fraction: onFraction, override_seconds: 0,
      vacant_on_seconds: 0, offschedule_on_seconds: 0, policy_ref: 'pol-light-a:1', partial: false });
    const occupied = ((offset / 3600) % 24) >= 2 && ((offset / 3600) % 24) < 18;
    room_intervals.push({ run_id: 'run-detector-001', room_id: roomId, interval_start_utc: iso(at),
      interval_end_utc: iso(at + step), interval_seconds: spec.resolutionSeconds,
      occupancy_avg: occupied ? 2 : 0, occupancy_max: occupied ? 2 : 0, occupied_fraction: occupied ? 1 : 0,
      avg_temp_c: 26, avg_rh_pct: 55, partial: false });
  }
  return {
    schema_version: '1.0.1', source: 'simulation', synthetic: true, synthetic_label: 'synthetic detector fixture',
    building: { building_id: 'nexyra-demo-office', name: 'Demo office', timezone: 'Asia/Kolkata' },
    run: { run_id: 'run-detector-001', scenario_id: 'original', run_start_utc: spec.startUtc, comparison_id: null },
    export: { export_id: `export-${spec.datasetId}`, export_start_utc: spec.startUtc, export_end_utc: spec.endUtc,
      interval_seconds: spec.resolutionSeconds, created_utc: spec.endUtc },
    rooms: [{ room_id: roomId, name: 'Room A', room_type: 'open_workspace', capacity: 8, floor_area_m2: 40 }],
    devices: [{ device_id: spec.deviceId, room_id: roomId, name: 'Light A', device_type: spec.deviceType, quantity: 1,
      nominal_power_w: 600, standby_power_w: 0, power_factor: 1, always_on: false, control: 'scheduled', controls: ['power'] }],
    policies: [{ policy_id: 'pol-light-a', version: 1, applies_to: spec.appliesTo, kind: 'lighting_schedule',
      effective_from_utc: spec.startUtc, rules: { on_during_hours: true, vacancy_grace_seconds: 300 } }],
    room_intervals, device_intervals,
  };
}

interface StubCall { path: string; payload: Row; }

function detectorStub() {
  const calls: StubCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) return envelope({ status: 'ok', model_available: false });
    const path = url.endsWith('/v1/drift') ? '/v1/drift' : '/v1/anomalies';
    const payload = JSON.parse(String(init?.body ?? '{}')) as Row;
    calls.push({ path, payload });
    return envelope(path === '/v1/drift' ? driftResponse(payload) : anomaliesResponse(payload));
  };
  return { fetchImpl, calls };
}

const sectionOf = (payload: Row, key: 'reference' | 'evaluation'): { window: Row; device: Row[]; room: Row[] } => {
  const block = payload[key] as Row;
  return { window: block.window as Row, device: rows(block.device_intervals), room: rows(block.room_intervals) };
};

const comparable = (section: { device: Row[]; room: Row[] }, device: Row): Row[] => {
  const comfort = device.device_type === 'ac' || device.device_type === 'refrigerator';
  const starts = new Set(section.room.map((row) => String(row.interval_start_utc)));
  return section.device.filter((row) => Number(row.on_fraction) === 1 && row.partial === false
    && (!comfort || starts.has(String(row.interval_start_utc))));
};

function anomaliesResponse(payload: Row): Row {
  const device = rows(payload.devices)[0]!;
  const reference = sectionOf(payload, 'reference');
  const evaluation = sectionOf(payload, 'evaluation');
  const referenceObs = comparable(reference, device);
  const evaluationObs = comparable(evaluation, device);
  const span = referenceObs.length
    ? (Date.parse(String(referenceObs.at(-1)!.interval_end_utc)) - Date.parse(String(referenceObs[0]!.interval_start_utc))) / 3_600_000
    : 0;
  const supported = referenceObs.length >= 12 && span >= 2;
  const baseline = supported ? median(referenceObs.map((row) => Number(row.avg_power_w))) : 0;
  const threshold = baseline * 1.5;
  const flagged = supported ? evaluationObs.filter((row) => Number(row.avg_power_w) > threshold) : [];
  const groups: Row[][] = [];
  for (const row of flagged) {
    const last = groups.at(-1)?.at(-1);
    if (last && last.interval_end_utc === row.interval_start_utc) groups.at(-1)!.push(row);
    else groups.push([row]);
  }
  const findings = groups.map((group) => ({
    finding_id: `excess_consumption_deviation:${String(device.device_id)}:${String(group[0]!.interval_start_utc)}`,
    finding_type: 'excess_consumption_deviation', device_id: device.device_id, room_id: device.room_id,
    window_start_utc: group[0]!.interval_start_utc, window_end_utc: group.at(-1)!.interval_end_utc,
    intervals: group.length,
    observed: { value: median(group.map((row) => Number(row.avg_power_w))), unit: 'W' },
    expected: { value: baseline, unit: 'W' }, threshold_w: threshold,
    energy_above_baseline_kwh: group.reduce((sum, row) => sum
      + (Number(row.avg_power_w) - baseline) * Number(row.interval_seconds) / 3_600_000, 0),
    method: 'rule', technique: 'robust_median_mad', detector_version: 'excess-power-mad-v1',
    assumptions: 'stub: compared with the device own earlier fully-on reference', suggested_action: 'check the device',
  }));
  const status = findings.length ? 'findings_detected' : supported ? 'evaluated_no_deviation' : 'insufficient_reference';
  return {
    status, findings,
    devices: [{ device_id: device.device_id, room_id: device.room_id, device_type: device.device_type,
      status: findings.length ? 'deviation_found' : supported ? 'evaluated_no_deviation' : 'insufficient_reference',
      comparison: 'own fully-on reference',
      reference: { usable_intervals: referenceObs.length, excluded: {},
        baselines_by_interval_seconds: supported ? { 300: { support: referenceObs.length, median_w: baseline, threshold_w: threshold } } : null },
      evaluation: { evaluated: supported ? evaluationObs.length : 0, flagged: flagged.length,
        insufficient_reference: supported ? 0 : evaluationObs.length, insufficient_reasons: {}, excluded: {} } }],
    coverage: { evaluation_device_intervals: evaluation.device.length, evaluated: supported ? evaluationObs.length : 0,
      flagged: flagged.length, insufficient_reference: supported ? 0 : evaluationObs.length, excluded: {},
      reference_device_intervals: reference.device.length, reference_usable: referenceObs.length, reference_excluded: {} },
    exclusions: [], exclusions_listed: 0, exclusions_total: 0,
    warnings: [{ code: 'NOT_A_DIAGNOSIS', message: 'stub: a deviation is not a malfunction' }],
    detector: { version: 'excess-power-mad-v1', method: 'rule', technique: 'robust_median_mad',
      request_format: 'excess-power-request-v1', model_used: false, parameters: { threshold_k: 4, stub: true } },
    analysis: { contract_version: '1.0.1', dataset_id: payload.dataset_id, run_id: payload.run_id,
      reference_window: reference.window, evaluation_window: evaluation.window,
      bounds: { device_intervals_per_section: 2000, room_intervals_per_section: 2000 } },
  };
}

function driftResponse(payload: Row): Row {
  const device = rows(payload.devices)[0]!;
  const reference = sectionOf(payload, 'reference');
  const evaluation = sectionOf(payload, 'evaluation');
  const referenceObs = comparable(reference, device);
  const evaluationObs = comparable(evaluation, device);
  const days = (items: Row[]): Map<number, number[]> => {
    const byDay = new Map<number, number[]>();
    for (const item of items) {
      const day = localDay(String(item.interval_start_utc));
      const bucket = byDay.get(day);
      if (bucket) bucket.push(Number(item.avg_power_w));
      else byDay.set(day, [Number(item.avg_power_w)]);
    }
    return byDay;
  };
  const referenceDays = days(referenceObs);
  const evaluationDays = days(evaluationObs);
  const span = (values: Map<number, number[]>): number => values.size === 0 ? 0
    : Math.floor((Math.max(...values.keys()) - Math.min(...values.keys()))) + 1;
  const supportedDay = (values: number[]): boolean => values.length >= 3;
  const keptReference = new Map([...referenceDays].filter(([, values]) => supportedDay(values)));
  const keptEvaluation = new Map([...evaluationDays].filter(([, values]) => supportedDay(values)));
  const referenceSpan = span(keptReference);
  const evaluationSpan = span(keptEvaluation);
  const coverage = evaluationSpan ? keptEvaluation.size / evaluationSpan : 0;
  const enoughReference = keptReference.size >= 5 && referenceSpan >= 7;
  const enoughEvaluation = keptEvaluation.size >= 10 && evaluationSpan >= 14 && coverage >= 0.5;

  const daily = [...keptEvaluation].sort((a, b) => a[0] - b[0]).map(([, values]) => median(values));
  const findings: Row[] = [];
  const otherChanges: Row[] = [];
  let classification = 'stable';
  if (!enoughReference || !enoughEvaluation) classification = 'insufficient';
  else {
    const sorted = [...daily].sort((a, b) => a - b);
    const peak = sorted.at(-1)!;
    const others = sorted.slice(0, -1);
    const abrupt = peak >= 1.25 * median(others) && others.every((value) => Math.abs(value - median(others)) <= 0.05 * median(others));
    const third = Math.floor(daily.length / 3) || 1;
    const firstThird = median(daily.slice(0, third));
    const lastThird = median(daily.slice(-third));
    if (abrupt) classification = 'abrupt_level_change';
    else if ((lastThird - firstThird) / Math.max(firstThird, 1e-9) >= 0.1) classification = 'sustained_upward_trend';
  }
  const status = classification === 'sustained_upward_trend' ? 'findings_detected'
    : classification === 'insufficient' ? 'insufficient_history' : 'evaluated_no_gradual_trend';
  if (classification === 'sustained_upward_trend') {
    findings.push({ finding_id: `${String(device.device_id)}:2026-01-01`, finding_type: 'sustained_upward_power_trend',
      device_id: device.device_id, room_id: device.room_id, method: 'rule', technique: 'theil_sen_context_normalised_daily',
      detector_version: 'gradual-power-trend-v1', reference_level_w: median(referenceObs.map((row) => Number(row.avg_power_w))),
      trend: { watts_per_day: 3.5, relative_change_over_period: 0.167 }, suggested_action: 'investigate the device' });
  }
  if (classification === 'abrupt_level_change') {
    otherChanges.push({ device_id: device.device_id, classification: 'abrupt_level_change',
      note: 'Not classified as a gradual trend.', metrics: {}, spike_days: [] });
  }
  return {
    status, findings, other_changes: otherChanges,
    devices: [{ device_id: device.device_id, room_id: device.room_id, device_type: device.device_type,
      status: classification === 'insufficient' ? 'insufficient_history' : 'evaluated',
      classification: classification === 'insufficient' ? null : classification,
      reason: enoughEvaluation ? null : `evaluation has ${keptEvaluation.size} supported days over ${evaluationSpan} days`,
      support: { reference_days: keptReference.size, evaluation_days: keptEvaluation.size, evaluation_span_days: evaluationSpan,
        reference_observations: referenceObs.length, evaluation_observations: evaluationObs.length } }],
    coverage: { devices: 1, evaluated: classification === 'insufficient' ? 0 : 1,
      insufficient_history: classification === 'insufficient' ? 1 : 0, unsupported_context: 0, no_comparable_observations: 0,
      reference_device_intervals: reference.device.length, evaluation_device_intervals: evaluation.device.length },
    exclusions: [],
    warnings: [{ code: 'NOT_AN_EFFICIENCY_DIAGNOSIS', message: 'stub: a trend is not an efficiency diagnosis' },
      { code: 'NOT_ADDITIVE', message: 'stub: do not add trend magnitudes to other findings' }],
    detector: { version: 'gradual-power-trend-v1', method: 'rule', technique: 'theil_sen_context_normalised_daily',
      request_format: 'drift-request-v1', model_used: false, parameters: { min_evaluation_days: 10, stub: true } },
    analysis: { contract_version: '1.0.1', dataset_id: payload.dataset_id, run_id: payload.run_id,
      reference_window: reference.window, evaluation_window: evaluation.window,
      bounds: { device_intervals_per_section: 2000, room_intervals_per_section: 2000 } },
  };
}

function detectorRunner(database: AuditorDatabase, stub: ReturnType<typeof detectorStub>,
  limits: { maxSectionRecords?: number; maxFindings?: number } = {}): DeviceDetectorRunner {
  const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 1000, fetchImpl: stub.fetchImpl });
  return new DeviceDetectorRunner(database, python, limits.maxSectionRecords ?? MAX_SECTION_RECORDS, limits.maxFindings ?? 100_000);
}

const WINDOWS = { reference: { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-03T00:00:00Z' },
  evaluation: { start_utc: '2026-01-03T00:00:00Z', end_utc: '2026-01-05T00:00:00Z' } };

test('minute readings are sent unchanged when they fit, and aggregated deterministically when they do not', () => {
  const database = new AuditorDatabase(':memory:');
  try {
    const spec: DatasetSpec = { datasetId: 'dataset-fit', resolutionSeconds: 60, startUtc: WINDOWS.reference.start_utc,
      endUtc: WINDOWS.evaluation.end_utc, deviceId: 'light-a', deviceType: 'lighting', appliesTo: 'device:light-a',
      power: (offset) => (offset < 3 * 86_400 ? 600 : 1000) };
    database.storeDataset({ datasetId: spec.datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'fit', data: buildDataset({ ...spec, endUtc: WINDOWS.evaluation.start_utc }) });
    const stub = detectorStub();
    const shortWindow = { reference: { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-01T01:00:00Z' },
      evaluation: { start_utc: '2026-01-01T01:00:00Z', end_utc: '2026-01-01T02:00:00Z' } };
    const plans = detectorRunner(database, stub).plan('dataset-fit', 'excess_consumption', shortWindow.reference, shortWindow.evaluation);
    assert.equal(plans[0]!.resolution_seconds, 60, 'stored resolution is used when it fits the 2,000-record bound');
    assert.equal(plans[0]!.reference!.aggregation, null, 'no aggregation happens when the stored records fit');

    const longDatabase = new AuditorDatabase(':memory:');
    try {
      longDatabase.storeDataset({ datasetId: 'dataset-aggregate', sourceFormat: 'json', sourceResolutionSeconds: 60,
        semanticFingerprint: 'aggregate', data: buildDataset(spec) });
      const longPlans = detectorRunner(longDatabase, stub).plan('dataset-aggregate', 'excess_consumption', WINDOWS.reference, WINDOWS.evaluation);
      assert.equal(longPlans[0]!.resolution_seconds, 300, 'finest resolution that fits the bound');
      assert.equal(longPlans[0]!.reference!.aggregation?.excluded_device_bins.missing_room_context, undefined);
      assert.equal(longPlans[0]!.reference!.device_records.length, 576);
      assert.equal(longPlans[0]!.reference!.room_records.length, 576);
      for (const record of longPlans[0]!.reference!.device_records) {
        assert.equal(record.on_fraction, 1);
        assert.equal(record.interval_seconds, 300);
        assert.equal(record.energy_kwh, Number(record.avg_power_w) * 300 / 3_600_000, 'energy matches avg_power_w x interval_seconds for Python');
        assert.equal(record.partial, false);
      }
      assert.equal(isDetectorId('excess_consumption'), true);
      assert.equal(isDetectorId('vacancy'), false);
    } finally { longDatabase.close(); }
  } finally { database.close(); }
});

test('each device keeps one fixed reference section across all evaluation batches', async () => {
  const database = new AuditorDatabase(':memory:');
  try {
    const reference = { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-02T00:00:00Z' };
    const evaluation = { start_utc: '2026-01-02T00:00:00Z', end_utc: '2026-01-06T00:00:00Z' };
    const spec: DatasetSpec = { datasetId: 'dataset-batches', resolutionSeconds: 60, startUtc: reference.start_utc,
      endUtc: evaluation.end_utc, deviceId: 'light-a', deviceType: 'lighting', appliesTo: 'device:light-a',
      power: (offset) => (offset < 86_400 ? 600 : offset < 172_800 ? 600 : 1000) };
    database.storeDataset({ datasetId: spec.datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'batches', data: buildDataset(spec) });
    const stub = detectorStub();
    const runner = detectorRunner(database, stub, { maxSectionRecords: 100 });
    const execution = await runner.run(spec.datasetId, 'excess_consumption', reference, evaluation);
    assert.ok(stub.calls.length >= 2, 'the evaluation section is split at the section bound');
    const first = JSON.stringify(sectionOf(stub.calls[0]!.payload, 'reference'));
    for (const call of stub.calls) {
      assert.equal(JSON.stringify(sectionOf(call.payload, 'reference')), first, 'the reference baseline section never changes across batches');
      assert.ok(sectionOf(call.payload, 'evaluation').device.length <= 100);
    }
    assert.equal(execution.batches, stub.calls.length);
    // Python groups contiguous flagged intervals only within one request, so a
    // split evaluation reports one finding per batch that contains a run. That
    // is documented behaviour, not a merge failure.
    assert.equal(execution.findings.length, stub.calls.length);
    assert.equal(execution.result.status, 'findings_detected');
    for (const finding of execution.findings) {
      assert.equal(finding.finding_type, 'excess_consumption_deviation');
    }
  } finally { database.close(); }
});

test('a device whose referenced policy is not device-scoped is reported as not assessed, never as no findings', async () => {
  const database = new AuditorDatabase(':memory:');
  try {
    const spec: DatasetSpec = { datasetId: 'dataset-scope', resolutionSeconds: 3600, startUtc: WINDOWS.reference.start_utc,
      endUtc: WINDOWS.evaluation.end_utc, deviceId: 'light-a', deviceType: 'lighting',
      appliesTo: 'building:nexyra-demo-office', power: () => 600 };
    database.storeDataset({ datasetId: spec.datasetId, sourceFormat: 'json', sourceResolutionSeconds: 3600,
      semanticFingerprint: 'scope', data: buildDataset(spec) });
    const stub = detectorStub();
    const execution = await detectorRunner(database, stub).run(spec.datasetId, 'excess_consumption', WINDOWS.reference, WINDOWS.evaluation);
    assert.equal(stub.calls.length, 0, 'no Python call is made for an unusable request');
    assert.equal(execution.result.status, 'unsupported_aggregation');
    const devices = rows(execution.result.devices);
    assert.equal(devices[0]!.status, 'unsupported_aggregation');
    assert.equal(devices[0]!.assessment_source, 'auditor_precheck');
    assert.match(String(devices[0]!.reason), /device-scoped/);
    assert.ok(rows(execution.result.warnings).some((warning) => warning.code === 'DEVICES_NOT_ASSESSED'));
  } finally { database.close(); }
});

test('findings above the configured cap fail the job instead of truncating a completed result', async () => {
  const database = new AuditorDatabase(':memory:');
  try {
    const spec: DatasetSpec = { datasetId: 'dataset-cap', resolutionSeconds: 60, startUtc: WINDOWS.reference.start_utc,
      endUtc: WINDOWS.evaluation.end_utc, deviceId: 'light-a', deviceType: 'lighting', appliesTo: 'device:light-a',
      power: (offset) => (offset < 3 * 86_400 ? 600 : (Math.floor(offset / 600) % 2 === 0 ? 1000 : 600)) };
    database.storeDataset({ datasetId: spec.datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'cap', data: buildDataset(spec) });
    const stub = detectorStub();
    await assert.rejects(detectorRunner(database, stub, { maxFindings: 1 }).run(spec.datasetId, 'excess_consumption',
      WINDOWS.reference, WINDOWS.evaluation), /more than 1 findings/);
    assert.ok(stub.calls.length > 0);
  } finally { database.close(); }
});

test('public detector jobs persist findings, paginate them and never reprice them with the tariff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-detector-job-'));
  const dbPath = join(dir, 'auditor.sqlite');
  let database = new AuditorDatabase(dbPath);
  let server: Server | undefined;
  try {
    const spec: DatasetSpec = { datasetId: 'dataset-public-detector', resolutionSeconds: 60, startUtc: WINDOWS.reference.start_utc,
      endUtc: WINDOWS.evaluation.end_utc, deviceId: 'light-a', deviceType: 'lighting', appliesTo: 'device:light-a',
      power: (offset) => (offset < 3 * 86_400 ? 600 : 1000) };
    database.storeDataset({ datasetId: spec.datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'public', data: buildDataset(spec) });
    const stub = detectorStub();
    const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 1000, fetchImpl: stub.fetchImpl });
    const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python));
    const config = loadConfig({ ML_TIMEOUT_MS: '1000' });
    server = createApp(config, database, { python, jobs }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const catalogue = await (await fetch(`${base}/api/v1/detectors`)).json() as { data: { detectors: Row[]; limits: Row } };
    assert.deepEqual(catalogue.data.detectors.map((entry) => entry.id), ['vacancy', 'excess_consumption', 'gradual_trend']);
    assert.equal(catalogue.data.limits.max_section_records, 2000);

    const rejected = await fetch(`${base}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: spec.datasetId, detector: 'excess_consumption',
        reference_window: { start_utc: '2026-01-03T00:00:00Z', end_utc: '2026-01-05T00:00:00Z' },
        evaluation_window: { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-03T00:00:00Z' } }) });
    assert.equal(rejected.status, 422, 'a reference after the evaluation is refused before queueing');

    const queued = await fetch(`${base}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: spec.datasetId, detector: 'excess_consumption',
        reference_window: WINDOWS.reference, evaluation_window: WINDOWS.evaluation }) });
    assert.equal(queued.status, 202);
    const accepted = (await queued.json() as { data: { job_id: string; status: string; detector: string } }).data;
    assert.equal(accepted.status, 'queued');
    assert.equal(accepted.detector, 'excess_consumption');

    let body: { data: Row } | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      body = await (await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}?page=1&page_size=1`)).json() as { data: Row };
      if (body.data.status === 'completed' || body.data.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(body?.data.status, 'completed', JSON.stringify(body));
    assert.deepEqual(body?.data.detector, { id: 'excess_consumption',
      label: 'Excess-consumption deviation versus an earlier comparable reference', method: 'rule',
      method_version: 'excess-power-mad-v1', technique: 'robust_median_mad',
      finding_type: 'excess_consumption_deviation', request_format: 'excess-power-request-v1' });
    const result = body!.data.result as Row;
    assert.equal(result.status, 'findings_detected');
    assert.equal(rows(result.findings).length, 1);
    assert.deepEqual(result.findings_pagination, { page: 1, page_size: 1, total: 1 });
    assert.equal((result.totals as Row).findings, 1);
    assert.equal((result.coverage as Row).detector_calls, 1);
    assert.equal(rows(result.warnings).some((warning) => warning.code === 'AGGREGATED_INTERVALS'), true);
    assert.equal(rows(result.warnings).some((warning) => warning.code === 'NOT_AVOIDABLE_SAVINGS'), true);
    const finding = rows(result.findings)[0]!;
    assert.equal(finding.finding_type, 'excess_consumption_deviation');
    assert.equal(finding.detector_id, 'excess_consumption');
    assert.equal(finding.avoidable_cost_inr, undefined, 'power deviations are never priced as avoidable savings');
    assert.equal(result.dataset_cost_inr, undefined);
    assert.equal((result.aggregation as Row).stored_interval_seconds, 60);
    assert.equal((result.detector_coverage as Row).reference_device_intervals, 576);
    assert.equal((result.detector_coverage as Row).evaluation_device_intervals, 576);
    assert.equal((result.detector_coverage as Row).evaluated, 576, 'every comparable evaluation interval is compared');
    assert.equal((result.detector_coverage as Row).flagged, 288);

    const page2 = await (await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}?page=2&page_size=1`)).json() as
      { data: { result: { findings: Row[]; findings_pagination: Row } } };
    assert.deepEqual(page2.data.result.findings, []);
    assert.equal(page2.data.result.findings_pagination.total, 1);

    const callsAfterRun = stub.calls.length;
    await fetch(`${base}/api/v1/imports/${spec.datasetId}/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inr_per_kwh: 10 }) });
    const repriced = await (await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}`)).json() as { data: { result: Row } };
    assert.equal(stub.calls.length, callsAfterRun, 'a tariff change never reruns a detector');
    assert.equal(repriced.data.result.findings_pagination !== undefined, true);

    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
    database.close();
    database = new AuditorDatabase(dbPath);
    assert.equal(database.getAnalysisJob(accepted.job_id)?.status, 'completed');
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed detector job still reports its detector identity and persists no findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-detector-failure-'));
  let database = new AuditorDatabase(join(dir, 'auditor.sqlite'));
  let server: Server | undefined;
  try {
    const spec: DatasetSpec = { datasetId: 'dataset-detector-failure', resolutionSeconds: 3600,
      startUtc: WINDOWS.reference.start_utc, endUtc: WINDOWS.evaluation.end_utc, deviceId: 'light-a',
      deviceType: 'lighting', appliesTo: 'device:light-a', power: () => 600 };
    database.storeDataset({ datasetId: spec.datasetId, sourceFormat: 'json', sourceResolutionSeconds: 3600,
      semanticFingerprint: 'detector-failure', data: buildDataset(spec) });
    const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
      fetchImpl: async (input) => {
        if (String(input).endsWith('/health')) return envelope({ status: 'ok', model_available: false });
        throw new TypeError('connection refused');
      } });
    const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python));
    server = createApp(loadConfig({ ML_TIMEOUT_MS: '100' }), database, { python, jobs }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const queued = await fetch(`${base}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: spec.datasetId, detector: 'gradual_trend',
        reference_window: WINDOWS.reference, evaluation_window: WINDOWS.evaluation }) });
    assert.equal(queued.status, 202);
    const accepted = (await queued.json() as { data: { job_id: string; detector: string } }).data;
    assert.equal(accepted.detector, 'gradual_trend', 'the queued response carries the detector identity');
    let body: { data: Row } | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      body = await (await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}`)).json() as { data: Row };
      if (body.data.status === 'failed' || body.data.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(body?.data.status, 'failed');
    assert.equal((body!.data.detector as Row).id, 'gradual_trend', 'a failed response keeps the detector identity');
    assert.equal((body!.data.error as Row).code, 'PYTHON_UNAVAILABLE');
    assert.doesNotMatch(String((body!.data.error as Row).message), /stack|TypeError|Traceback/i);
    assert.equal(database.getAnalysisFindings(accepted.job_id, 10, 0).total, 0, 'a failed detector job persists no findings');
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
    database.close();
    database = new AuditorDatabase(join(dir, 'auditor.sqlite'));
    assert.equal(database.getAnalysisJob(accepted.job_id)?.status, 'failed');
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Status distinctions and drift observations (P026 §6).
// ---------------------------------------------------------------------------

const HOURLY_REFERENCE = { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-08T00:00:00Z' };

test('drift distinguishes a sustained trend, a step observation and insufficient history, and stable data has no findings', async () => {
  const database = new AuditorDatabase(':memory:');
  try {
    const dayOffset = (days: number): number => days * 86_400;
    database.storeDataset({ datasetId: 'dataset-drift-trend', sourceFormat: 'json', sourceResolutionSeconds: 3600,
      semanticFingerprint: 'drift-trend', data: buildDataset({ datasetId: 'dataset-drift-trend', resolutionSeconds: 3600,
        startUtc: HOURLY_REFERENCE.start_utc, endUtc: '2026-01-23T00:00:00Z', deviceId: 'light-a', deviceType: 'lighting',
        appliesTo: 'device:light-a', power: (offset) => (offset < 7 * 86_400 ? 600 : offset < 14 * 86_400 ? 600 : 700) }) });
    database.storeDataset({ datasetId: 'dataset-drift-stable', sourceFormat: 'json', sourceResolutionSeconds: 3600,
      semanticFingerprint: 'drift-stable', data: buildDataset({ datasetId: 'dataset-drift-stable', resolutionSeconds: 3600,
        startUtc: HOURLY_REFERENCE.start_utc, endUtc: '2026-01-23T00:00:00Z', deviceId: 'light-a', deviceType: 'lighting',
        appliesTo: 'device:light-a', power: () => 600 }) });
    database.storeDataset({ datasetId: 'dataset-drift-step', sourceFormat: 'json', sourceResolutionSeconds: 3600,
      semanticFingerprint: 'drift-step', data: buildDataset({ datasetId: 'dataset-drift-step', resolutionSeconds: 3600,
        startUtc: HOURLY_REFERENCE.start_utc, endUtc: '2026-01-23T00:00:00Z', deviceId: 'light-a', deviceType: 'lighting',
        appliesTo: 'device:light-a', power: (offset) => (offset >= dayOffset(10) && offset < dayOffset(11) ? 900 : 600) }) });
    database.storeDataset({ datasetId: 'dataset-drift-short', sourceFormat: 'json', sourceResolutionSeconds: 3600,
      semanticFingerprint: 'drift-short', data: buildDataset({ datasetId: 'dataset-drift-short', resolutionSeconds: 3600,
        startUtc: HOURLY_REFERENCE.start_utc, endUtc: '2026-01-16T00:00:00Z', deviceId: 'light-a', deviceType: 'lighting',
        appliesTo: 'device:light-a', power: () => 600 }) });
    const evaluation = { start_utc: '2026-01-08T00:00:00Z', end_utc: '2026-01-23T00:00:00Z' };
    const runner = detectorRunner(database, detectorStub());

    const trend = await runner.run('dataset-drift-trend', 'gradual_trend', HOURLY_REFERENCE, evaluation);
    assert.equal(trend.result.status, 'findings_detected');
    assert.equal(trend.findings.length, 1);
    assert.equal(trend.findings[0]!.finding_type, 'sustained_upward_power_trend');
    assert.equal(trend.findings[0]!.detector_id, 'gradual_trend');
    assert.deepEqual(trend.result.other_changes, []);

    const stable = await runner.run('dataset-drift-stable', 'gradual_trend', HOURLY_REFERENCE, evaluation);
    assert.equal(stable.result.status, 'evaluated_no_gradual_trend');
    assert.equal(stable.findings.length, 0, 'evaluated with no trend is distinct from not being assessed');

    const step = await runner.run('dataset-drift-step', 'gradual_trend', HOURLY_REFERENCE, evaluation);
    assert.equal(step.result.status, 'evaluated_no_gradual_trend');
    assert.equal(step.findings.length, 0, 'a step is not a gradual trend finding');
    assert.equal(rows(step.result.other_changes).length, 1);
    assert.equal(rows(step.result.other_changes)[0]!.classification, 'abrupt_level_change');

    const short = await runner.run('dataset-drift-short', 'gradual_trend', HOURLY_REFERENCE,
      { start_utc: '2026-01-08T00:00:00Z', end_utc: '2026-01-16T00:00:00Z' });
    assert.equal(short.result.status, 'insufficient_history');
    assert.equal(short.findings.length, 0);
    assert.match(String(rows(short.result.devices)[0]!.reason), /supported days/);
  } finally { database.close(); }
});

test('an insufficient reference is reported as insufficient_reference, never as evaluated with no findings', async () => {
  const database = new AuditorDatabase(':memory:');
  try {
    database.storeDataset({ datasetId: 'dataset-thin', sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'thin', data: buildDataset({ datasetId: 'dataset-thin', resolutionSeconds: 60,
        startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-01-01T00:20:00Z', deviceId: 'light-a', deviceType: 'lighting',
        appliesTo: 'device:light-a', power: () => 600 }) });
    const execution = await detectorRunner(database, detectorStub()).run('dataset-thin', 'excess_consumption',
      { start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-01T00:10:00Z' },
      { start_utc: '2026-01-01T00:10:00Z', end_utc: '2026-01-01T00:20:00Z' });
    assert.equal(execution.result.status, 'insufficient_reference');
    assert.equal(execution.findings.length, 0);
    assert.equal((execution.result.detector_coverage as Row).insufficient_reference, 10);
    assert.equal(rows(execution.result.devices)[0]!.status, 'insufficient_reference');
  } finally { database.close(); }
});
