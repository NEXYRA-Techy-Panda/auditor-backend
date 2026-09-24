import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { DatasetImport, StoredAnalysisInterval } from '../src/db/database.js';
import { AuditorDatabase } from '../src/db/database.js';
import { PythonAnalysisClient, PythonServiceError } from '../src/analysis/client.js';
import { AnalysisBatchRunner } from '../src/analysis/batches.js';
import { AnalysisJobManager } from '../src/analysis/jobs.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { buildCompleteHourlyHistory, ForecastRunner, resolveForecastOrigin, validatePythonForecast } from '../src/forecast/runner.js';

const fixture = JSON.parse(readFileSync(new URL('../contracts/v1/fixtures/reference.json', import.meta.url), 'utf8')) as DatasetImport['data'];
const requestId = '12345678-1234-4234-9234-123456789abc';
const envelope = (data: unknown): Response => Response.json({ data, meta: { request_id: requestId } });
const hourMs = 3_600_000;
const iso = (value: number) => new Date(value).toISOString().replace('.000Z', 'Z');

function interval(deviceId: string, start: number, end: number, energy: number, partial = false): StoredAnalysisInterval {
  return { device_id: deviceId, room_id: 'room-a', interval_start_utc: iso(start), interval_end_utc: iso(end),
    interval_seconds: (end - start) / 1000, energy_kwh: energy, partial };
}

function forecastDataset(hours = 672): DatasetImport['data'] {
  const data = structuredClone(fixture);
  const start = Date.parse('2026-09-21T03:30:00Z');
  const end = start + hours * hourMs;
  data.run.run_id = `run-forecast-${hours}`;
  data.export.export_id = `export-forecast-${hours}`;
  data.export.export_start_utc = iso(start);
  data.export.export_end_utc = iso(end);
  data.synthetic = true;
  data.synthetic_label = 'Generated deterministic hourly forecast test data; not measured.';
  data.devices.find((device) => device.device_id === 'light-a')!.quantity = 4;
  data.devices.find((device) => device.device_id === 'fridge-b')!.quantity = 6;
  const officePolicy = data.policies.find((policy) => policy.kind === 'office_hours')!;
  const higherVersionButOlder = structuredClone(officePolicy);
  higherVersionButOlder.version = 7;
  higherVersionButOlder.effective_from_utc = iso(end - hourMs);
  const effectiveAtOrigin = structuredClone(officePolicy);
  effectiveAtOrigin.version = 2;
  effectiveAtOrigin.effective_from_utc = iso(end);
  (effectiveAtOrigin.rules as Record<string, unknown>).open_local = '10:00';
  data.policies.push(higherVersionButOlder, effectiveAtOrigin);
  data.room_intervals = [];
  data.device_intervals = [];
  let lightTotal = 0;
  let fridgeTotal = 0;
  for (let index = 0; index < hours; index++) {
    const from = iso(start + index * hourMs);
    const to = iso(start + (index + 1) * hourMs);
    for (const roomId of ['room-a', 'room-b']) data.room_intervals.push({ run_id: data.run.run_id, room_id: roomId,
      interval_start_utc: from, interval_end_utc: to, interval_seconds: 3600, occupancy_avg: 0,
      occupancy_max: 0, occupied_fraction: 0, avg_temp_c: 25, avg_rh_pct: 50, partial: false });
    for (const [deviceId, roomId, energy, policy] of [
      ['light-a', 'room-a', 0.01, 'pol-light-a:1'], ['fridge-b', 'room-b', 0.005, 'pol-fridge-b:1'],
    ] as const) {
      if (deviceId === 'light-a') lightTotal += energy; else fridgeTotal += energy;
      data.device_intervals.push({ run_id: data.run.run_id, room_id: roomId, device_id: deviceId,
        interval_start_utc: from, interval_end_utc: to, interval_seconds: 3600,
        avg_power_w: energy * 1000, max_power_w: energy * 1000, energy_kwh: energy,
        cumulative_kwh: deviceId === 'light-a' ? lightTotal : fridgeTotal, power_factor: 1,
        on_fraction: 1, override_seconds: 0, vacant_on_seconds: 0, offschedule_on_seconds: 0,
        policy_ref: policy, partial: false });
    }
  }
  return data;
}

function mockForecastFetch(observe: (payload: Record<string, unknown>) => void = () => {}, failInsufficient = false) {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input).endsWith('/v1/forecast'), true);
    calls++;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    observe(payload);
    const observedHours = (payload.history_hourly_kwh as unknown[]).length;
    if (failInsufficient && observedHours < 168) {
      return Response.json({ error: { code: 'INSUFFICIENT_DATA', message: `next_24h requires at least 168 observed history hours; got ${observedHours}.` } }, { status: 422 });
    }
    const origin = Date.parse(String(payload.origin_utc));
    const horizon = String(payload.horizon);
    let start = origin; let end = origin + (horizon === 'next_7d' ? 168 : 24) * hourMs;
    if (horizon === 'next_calendar_month') {
      const local = new Date(origin + 330 * 60_000);
      start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 330 * 60_000;
      end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 2, 1) - 330 * 60_000;
    }
    const points = Array.from({ length: (end - start) / hourMs }, (_, index) => ({
      start_utc: iso(start + index * hourMs), energy_kwh: 0.015, basis: 'weekday_hour', support: 4,
    }));
    const history = payload.history_hourly_kwh as unknown[];
    return envelope({ horizon, origin_utc: payload.origin_utc, model_version: null,
      baseline_version: 'hourly-profile-median-v1', method: 'statistical_baseline', timezone: 'Asia/Kolkata',
      horizon_start_utc: iso(start), horizon_end_utc: iso(end), points,
      total_energy_kwh: points.reduce((sum, point) => sum + point.energy_kwh, 0), uncertainty: 'unavailable',
      history_coverage: { observed_hours: history.length, min_observed_hours_required: horizon === 'next_24h' ? 168 : horizon === 'next_7d' ? 336 : 672 },
      assumptions: ['baseline assumption'], assumptions_recorded: {}, limitations: ['Synthetic mock baseline'], warnings: [] });
  };
  return { fetchImpl, get calls() { return calls; } };
}

test('hourly history sums complete per-device energy once and omits missing or overlapping hours', () => {
  const start = Date.parse('2026-09-21T03:30:00Z');
  const origin = iso(start + 2 * hourMs);
  const rows = [
    interval('light-a', start, start + hourMs / 2, 0.004, true),
    interval('light-a', start + hourMs / 2, start + hourMs, 0.006, true),
    interval('fridge-b', start, start + hourMs, 0.005),
    interval('light-a', start + hourMs, start + 2 * hourMs, 0.01),
    interval('light-a', start + hourMs, start + 2 * hourMs, 0.01),
    interval('fridge-b', start + hourMs, start + 2 * hourMs, 0.005),
  ];
  const result = buildCompleteHourlyHistory(['light-a', 'fridge-b'], rows, iso(start), origin);
  assert.deepEqual(result.points, [{ start_utc: iso(start), energy_kwh: 0.015 }]);
  assert.equal(result.coverage.incomplete_hours, 1);
  assert.deepEqual(result.coverage.incomplete_hours_by_reason, { OVERLAPPING_DEVICE_INTERVALS: 1 });
  const missing = buildCompleteHourlyHistory(['light-a', 'fridge-b'], rows.filter((row) =>
    !(row.device_id === 'fridge-b' && row.interval_start_utc === iso(start))), iso(start), origin);
  assert.equal(missing.points.length, 0, 'missing one expected device must omit the entire office hour');
  assert.equal((missing.coverage.incomplete_hours_by_reason as Record<string, number>).MISSING_DEVICE_COVERAGE, 1);
});

test('partial intervals count only when exact unions cover the hour; crossing-hour intervals are omitted', () => {
  const start = Date.parse('2026-09-21T03:30:00Z');
  const origin = iso(start + hourMs);
  const split = [interval('d', start, start + 30 * 60_000, 0.2, true),
    interval('d', start + 30 * 60_000, start + hourMs, 0.3, true)];
  assert.deepEqual(buildCompleteHourlyHistory(['d'], split, iso(start), origin).points,
    [{ start_utc: iso(start), energy_kwh: 0.5 }]);
  const crossing = [interval('d', start - 30 * 60_000, start + 30 * 60_000, 0.5, true)];
  const rejected = buildCompleteHourlyHistory(['d'], crossing, iso(start), origin);
  assert.equal(rejected.points.length, 0);
  assert.equal((rejected.coverage.incomplete_hours_by_reason as Record<string, number>).CROSSING_HOUR_INTERVAL, 1);
});

test('history retention is limited to the latest 2,160 aligned hourly slots', () => {
  const start = Date.parse('2026-09-21T03:30:00Z');
  const totalHours = 2_200;
  const rows = Array.from({ length: totalHours }, (_, index) => interval('d', start + index * hourMs,
    start + (index + 1) * hourMs, 0.25));
  const result = buildCompleteHourlyHistory(['d'], rows, iso(start), iso(start + totalHours * hourMs));
  assert.equal(result.points.length, 2_160);
  assert.equal(result.points[0]?.start_utc, iso(start + 40 * hourMs));
  assert.equal(result.coverage.candidate_hours, 2_160);
  assert.equal(result.coverage.maximum_history_hours, 2_160);
});

test('historical origin defaults from dataset end and selects the office policy effective at that origin', () => {
  const database = new AuditorDatabase(':memory:');
  try {
    database.storeDataset({ datasetId: 'dataset-policy-origin', sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'policy-origin', data: structuredClone(fixture) });
    const meta = database.getAnalysisDatasetMeta('dataset-policy-origin')!;
    assert.equal(resolveForecastOrigin(meta), '2026-09-21T04:30:00Z');
    assert.throws(() => resolveForecastOrigin(meta, '2026-09-21T03:00:00Z'), /local clock hour/);
    const add = database.db.prepare(`INSERT INTO policy_versions(dataset_id,policy_id,version,applies_to,kind,effective_from_utc,rules_json)
      VALUES (?,?,?,?,?,?,?)`);
    const rules7 = { working_days_iso: [1, 2, 3, 4, 5], open_local: '08:00', close_local: '17:00', overnight: false };
    const rules2 = { working_days_iso: [1, 2, 3, 4, 5, 6], open_local: '10:00', close_local: '19:00', overnight: false };
    add.run('dataset-policy-origin', 'pol-hours', 7, 'building:fixture-office', 'office_hours', '2026-09-21T04:00:00Z', JSON.stringify(rules7));
    add.run('dataset-policy-origin', 'pol-hours', 2, 'building:fixture-office', 'office_hours', '2026-09-21T04:30:00Z', JSON.stringify(rules2));
    const policy = database.getForecastCalendarPolicy('dataset-policy-origin', '2026-09-21T04:30:00Z');
    assert.equal(policy?.version, 2, 'effective time takes precedence over a larger version number');
    assert.equal(policy?.rules.open_local, '10:00');
  } finally { database.close(); }
});

test('forecast submission rejects unsupported timezone and malformed horizon before queueing', async () => {
  const database = new AuditorDatabase(':memory:');
  database.storeDataset({ datasetId: 'dataset-unsupported-zone', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: 'unsupported-zone', data: structuredClone(fixture) });
  database.db.prepare('UPDATE datasets SET timezone=? WHERE dataset_id=?').run('America/Los_Angeles', 'dataset-unsupported-zone');
  const python = new PythonAnalysisClient({ baseUrl: 'http://unused.invalid', timeoutMs: 100 });
  const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python), new ForecastRunner(database, python));
  const server = createApp(loadConfig({}), database, { python, jobs }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const unsupported = await fetch(`${base}/api/v1/forecasts`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: 'dataset-unsupported-zone', horizon: 'next_24h' }) });
    assert.equal(unsupported.status, 422);
    assert.equal((await unsupported.json() as { error: { code: string } }).error.code, 'UNSUPPORTED_INPUT');
    const malformed = await fetch(`${base}/api/v1/forecasts`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: 'dataset-unsupported-zone', horizon: 'next_30d' }) });
    assert.equal(malformed.status, 422);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    assert.equal(database.pendingAnalysisJobs(), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});

test('public forecast workflow persists all horizons and recalculates current tariff without rerunning Python', async () => {
  const database = new AuditorDatabase(':memory:');
  const datasetId = 'dataset-forecast-api';
  database.storeDataset({ datasetId, sourceFormat: 'json', sourceResolutionSeconds: 3600,
    semanticFingerprint: 'forecast-api', data: forecastDataset() });
  const observed: Record<string, unknown>[] = [];
  const stub = mockForecastFetch((payload) => observed.push(payload));
  const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 1000, fetchImpl: stub.fetchImpl });
  const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python), new ForecastRunner(database, python));
  const server = createApp(loadConfig({ ML_TIMEOUT_MS: '1000' }), database, { python, jobs }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const forecastIds: string[] = [];
    for (const [horizon, expectedPoints] of [['next_24h', 24], ['next_7d', 168], ['next_calendar_month', 720]] as const) {
      const submitted = await fetch(`${base}/api/v1/forecasts`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataset_id: datasetId, horizon }) });
      assert.equal(submitted.status, 202);
      const accepted = (await submitted.json() as { data: { forecast_id: string; status: string; origin_utc: string } }).data;
      forecastIds.push(accepted.forecast_id);
      assert.equal(accepted.status, 'queued');
      assert.equal(accepted.origin_utc, '2026-10-19T03:30:00Z');
      let status: { data: Record<string, unknown> } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = await (await fetch(`${base}/api/v1/forecasts/${accepted.forecast_id}`)).json() as { data: Record<string, unknown> };
        if (status.data.status === 'completed' || status.data.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(status?.data.status, 'completed', JSON.stringify(status));
      const result = status!.data.result as Record<string, unknown>;
      assert.equal((result.points as unknown[]).length, expectedPoints);
      assert.equal(result.model_version, null);
      assert.equal(result.baseline_version, 'hourly-profile-median-v1');
      assert.equal(result.synthetic, true);
      assert.equal(result.tariff_inr_per_kwh, null);
      const persisted = database.getForecastRecord(accepted.forecast_id)!;
      assert.equal(persisted.energy_kwh, result.total_energy_kwh);
      assert.equal((persisted.points as unknown[]).length, expectedPoints);
      assert.equal((observed.at(-1)!.history_hourly_kwh as unknown[]).length, 672);
      assert.equal((observed.at(-1)!.calendar as Record<string, unknown>).timezone, 'Asia/Kolkata');
      assert.equal((observed.at(-1)!.future_assumptions as Record<string, unknown>).schedule !== undefined, true);
      assert.equal((observed.at(-1)!.future_assumptions as Record<string, unknown>).environment, undefined);
      const sentSchedule = (observed.at(-1)!.future_assumptions as { schedule: Record<string, unknown> }).schedule;
      assert.equal(sentSchedule.version, 2, 'policy effective at origin wins over a numerically higher older version');
      assert.equal(sentSchedule.effective_from_utc, accepted.origin_utc);
      assert.equal(((observed.at(-1)!.calendar as Record<string, unknown>).open_local), '10:00');
    }
    const beforeTariff = stub.calls;
    database.setTariff('local', 0);
    let priced = (await (await fetch(`${base}/api/v1/forecasts/${forecastIds[2]}`)).json() as { data: { result: Record<string, unknown> } }).data.result;
    assert.equal(priced.forecast_cost_inr, 0);
    database.setTariff('local', 10);
    priced = (await (await fetch(`${base}/api/v1/forecasts/${forecastIds[2]}`)).json() as { data: { result: Record<string, unknown> } }).data.result;
    assert.equal(priced.forecast_cost_inr, Number(priced.total_energy_kwh) * 10);
    assert.equal(stub.calls, beforeTariff);
    assert.equal(observed.length, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});

test('forecast history reports trailing incomplete hours and the gap to origin', async () => {
  const database = new AuditorDatabase(':memory:');
  const datasetId = 'dataset-trailing-gap';
  const data = forecastDataset();
  data.device_intervals = data.device_intervals.filter((row) =>
    !(row.device_id === 'fridge-b' && row.interval_end_utc === data.export.export_end_utc));
  database.storeDataset({ datasetId, sourceFormat: 'json', sourceResolutionSeconds: 3600,
    semanticFingerprint: 'trailing-gap', data });
  let request: Record<string, unknown> | undefined;
  const stub = mockForecastFetch((payload) => { request = payload; });
  const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 1000, fetchImpl: stub.fetchImpl });
  try {
    const meta = database.getAnalysisDatasetMeta(datasetId)!;
    const result = await new ForecastRunner(database, python).run(datasetId, 'next_24h', meta.end_utc);
    assert.equal((request!.history_hourly_kwh as unknown[]).length, 671);
    const historyCoverage = result.result.history_coverage as Record<string, unknown>;
    assert.equal(historyCoverage.trailing_incomplete_hours, 1);
    assert.equal(historyCoverage.gap_before_origin_hours, 1);
    const warnings = result.result.warnings as Array<Record<string, unknown>>;
    assert.equal(warnings.some((warning) => warning.code === 'INCOMPLETE_HISTORY_HOURS'), true);
    assert.equal(warnings.some((warning) => warning.code === 'GAP_BEFORE_ORIGIN'), true);
  } finally { database.close(); }
});

test('insufficient imported history preserves Python INSUFFICIENT_DATA and never substitutes zero forecast', async () => {
  const database = new AuditorDatabase(':memory:');
  database.storeDataset({ datasetId: 'dataset-too-short', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: 'forecast-too-short', data: structuredClone(fixture) });
  const stub = mockForecastFetch(() => {}, true);
  const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 1000, fetchImpl: stub.fetchImpl });
  const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python), new ForecastRunner(database, python));
  const server = createApp(loadConfig({ ML_TIMEOUT_MS: '1000' }), database, { python, jobs }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const submitted = await fetch(`${base}/api/v1/forecasts`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: 'dataset-too-short', horizon: 'next_24h' }) });
    const accepted = (await submitted.json() as { data: { forecast_id: string } }).data;
    let reply: { data: Record<string, unknown> } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      reply = await (await fetch(`${base}/api/v1/forecasts/${accepted.forecast_id}`)).json() as { data: Record<string, unknown> };
      if (reply.data.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reply?.data.status, 'failed');
    assert.deepEqual(reply?.data.error, { code: 'INSUFFICIENT_DATA',
      message: 'next_24h requires at least 168 observed history hours; got 0.' });
    assert.equal(reply?.data.result, undefined);
    assert.equal(database.getAnalysisJob(accepted.forecast_id)?.result, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});

test('forecast job result and hourly record survive SQLite reopen without a tariff snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-forecast-reopen-'));
  const path = join(dir, 'auditor.sqlite');
  let database = new AuditorDatabase(path);
  try {
    database.storeDataset({ datasetId: 'dataset-reopen-forecast', sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'forecast-reopen', data: structuredClone(fixture) });
    database.createAnalysisJob({ jobId: 'forecast-reopen-id', datasetId: 'dataset-reopen-forecast', status: 'queued',
      request: { job_type: 'forecast', dataset_id: 'dataset-reopen-forecast', horizon: 'next_24h', origin_utc: '2026-09-21T04:30:00Z' }, jobType: 'forecast' });
    database.startAnalysisJob('forecast-reopen-id', 'statistical_baseline', 'hourly-profile-median-v1', 1);
    const points = [{ start_utc: '2026-09-21T04:30:00Z', energy_kwh: 2 }];
    const result = { horizon: 'next_24h', total_energy_kwh: 2, points };
    database.completeForecastJob({ forecastId: 'forecast-reopen-id', jobId: 'forecast-reopen-id',
      datasetId: 'dataset-reopen-forecast', horizon: 'next_24h', originUtc: '2026-09-21T04:30:00Z',
      horizonStartUtc: '2026-09-21T04:30:00Z', horizonEndUtc: '2026-09-22T04:30:00Z', energyKwh: 2,
      method: 'statistical_baseline', baselineVersion: 'hourly-profile-median-v1', modelVersion: null,
      timezone: 'Asia/Kolkata', synthetic: true, syntheticLabel: 'Generated deterministic fixture.',
      points, result, assumptions: { calendar: { timezone: 'Asia/Kolkata' } },
      historyStartUtc: '2026-09-14T04:30:00Z', historyEndUtc: '2026-09-21T04:30:00Z' });
    database.close();
    database = new AuditorDatabase(path);
    const job = database.getAnalysisJob('forecast-reopen-id')!;
    const forecast = database.getForecastRecord('forecast-reopen-id')!;
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.result, result);
    assert.equal(forecast.energy_kwh, 2);
    assert.deepEqual(forecast.points, points);
    assert.deepEqual(forecast.assumptions, { calendar: { timezone: 'Asia/Kolkata' } });
    assert.equal((database.db.prepare('SELECT tariff_rate_per_kwh,cost_amount FROM forecast_records WHERE forecast_id=?')
      .get('forecast-reopen-id') as { tariff_rate_per_kwh: number | null; cost_amount: number | null }).cost_amount, null);
    database.setTariff('local', 5);
    assert.equal(database.getForecastRecord('forecast-reopen-id')?.energy_kwh, 2);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forecast response validation rejects wrong month ranges, reordered/duplicate points, bad totals and negative energy', () => {
  const origin = '2026-10-19T03:30:00Z';
  const start = Date.parse('2026-10-31T18:30:00Z');
  const point = (index: number) => ({ start_utc: iso(start + index * hourMs), energy_kwh: 1, basis: 'weekday_hour', support: 4 });
  const response: Record<string, unknown> = { horizon: 'next_calendar_month', origin_utc: origin,
    model_version: null, baseline_version: 'hourly-profile-median-v1', method: 'statistical_baseline', timezone: 'Asia/Kolkata',
    horizon_start_utc: iso(start), horizon_end_utc: '2026-11-30T18:30:00Z', points: Array.from({ length: 720 }, (_, i) => point(i)),
    total_energy_kwh: 720, uncertainty: 'unavailable', history_coverage: { observed_hours: 672, min_observed_hours_required: 672 },
    assumptions: [], assumptions_recorded: {}, limitations: [], warnings: [] };
  assert.equal((validatePythonForecast(response, 'next_calendar_month', origin, 672).points as unknown[]).length, 720);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.horizon_end_utc = '2026-12-19T03:30:00Z'; },
    (value: Record<string, unknown>) => { (value.points as Array<Record<string, unknown>>)[1]!.start_utc = point(0).start_utc; },
    (value: Record<string, unknown>) => { value.total_energy_kwh = 719; },
    (value: Record<string, unknown>) => { (value.points as Array<Record<string, unknown>>)[0]!.energy_kwh = -1; },
  ]) {
    const invalid = structuredClone(response); mutate(invalid);
    assert.throws(() => validatePythonForecast(invalid, 'next_calendar_month', origin, 672), /Python forecast service returned an invalid response/);
  }
});

test('forecast client preserves upstream eligibility errors and classifies service failures', async () => {
  const insufficient = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => Response.json({ error: { code: 'INSUFFICIENT_DATA', message: 'Requires 168 complete observed hours.' } }, { status: 422 }) });
  await assert.rejects(insufficient.forecast({}), (error: unknown) => error instanceof PythonServiceError
    && error.kind === 'rejected' && error.operation === 'forecast' && error.upstreamCode === 'INSUFFICIENT_DATA'
    && error.upstreamMessage === 'Requires 168 complete observed hours.');
  const unavailable = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => { throw new TypeError('connection refused'); } });
  await assert.rejects(unavailable.forecast({}), (error: unknown) => error instanceof PythonServiceError
    && error.kind === 'unavailable' && error.operation === 'forecast');
  const malformed = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => Response.json({ data: [], meta: { request_id: requestId } }) });
  await assert.rejects(malformed.forecast({}), (error: unknown) => error instanceof PythonServiceError
    && error.kind === 'malformed' && error.operation === 'forecast');
});

test('forecast unavailable, timeout and malformed replies persist failed jobs without partial results', async () => {
  const modes = [
    { name: 'unavailable', code: 'PYTHON_UNAVAILABLE', fetch: async (): Promise<Response> => { throw new TypeError('connection refused'); } },
    { name: 'timeout', code: 'PYTHON_TIMEOUT', fetch: async (): Promise<Response> => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; } },
    { name: 'malformed', code: 'PYTHON_MALFORMED', fetch: async (): Promise<Response> => envelope({}) },
  ];
  for (const mode of modes) {
    const database = new AuditorDatabase(':memory:');
    try {
      const datasetId = `dataset-forecast-${mode.name}`;
      database.storeDataset({ datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60,
        semanticFingerprint: `forecast-${mode.name}`, data: structuredClone(fixture) });
      const client = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100, fetchImpl: mode.fetch });
      const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, client), new ForecastRunner(database, client));
      const accepted = jobs.submitForecast({ dataset_id: datasetId, horizon: 'next_24h' });
      let job = database.getAnalysisJob(accepted.job_id);
      for (let attempt = 0; attempt < 100 && job?.status !== 'failed'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        job = database.getAnalysisJob(accepted.job_id);
      }
      assert.equal(job?.status, 'failed', mode.name);
      assert.equal(job?.error_code, mode.code);
      assert.match(job?.error_message ?? '', /Python forecast/);
      assert.equal(job?.result, null);
      assert.equal(database.getForecastRecord(accepted.forecast_id), undefined);
    } finally { database.close(); }
  }
});
