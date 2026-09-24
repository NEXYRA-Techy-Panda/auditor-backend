import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AnalysisBatchRunner } from '../src/analysis/batches.js';
import { PythonAnalysisClient, PythonServiceError } from '../src/analysis/client.js';
import { AnalysisJobManager } from '../src/analysis/jobs.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuditorDatabase, type DatasetImport } from '../src/db/database.js';

const fixture = JSON.parse(readFileSync(new URL('../contracts/v1/fixtures/reference.json', import.meta.url), 'utf8')) as DatasetImport['data'];
const requestId = '12345678-1234-4234-9234-123456789abc';
const envelope = (data: unknown): Response => Response.json({ data, meta: { request_id: requestId } });

function pythonStub() {
  let analyses = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) return envelope({ status: 'ok', model_available: false });
    analyses++;
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const device = (payload.devices as Array<Record<string, unknown>>)[0]!;
    const deviceRows = payload.device_intervals as Array<Record<string, unknown>>;
    const roomRows = payload.room_intervals as Array<Record<string, unknown>>;
    const portion = deviceRows.find((row) => Number(row.vacant_on_seconds) > 0
      && roomRows.some((room) => room.interval_start_utc === row.interval_start_utc && room.occupancy_max === 0));
    const findings = device.device_id === 'light-a' && portion ? [{
      finding_id: `vacant_but_on:${device.device_id}:${portion.interval_start_utc}`,
      finding_type: 'vacant_but_on', room_id: device.room_id, device_id: device.device_id,
      window_start_utc: portion.interval_start_utc, window_end_utc: portion.interval_end_utc,
      observed: { value: portion.energy_kwh, unit: 'kWh' }, expected: { value: 0, unit: 'kWh' },
      method: 'rule', suggested_action: 'Switch off the light',
      assumptions: 'fixture rule assumption', resolution_limit: '60-second intervals',
      evidence: { rule_version: 'vacant-beyond-grace-v1', policy_refs: [portion.policy_ref],
        vacant_on_seconds_beyond_grace: portion.vacant_on_seconds,
        intervals: [{ interval_start_utc: portion.interval_start_utc, interval_end_utc: portion.interval_end_utc,
          counted_from_utc: portion.interval_start_utc, vacant_on_seconds: portion.vacant_on_seconds,
          energy_kwh: portion.energy_kwh, policy_ref: portion.policy_ref }] },
    }] : [];
    return envelope({ findings, warnings: [{ code: 'ANALYSES_NOT_PERFORMED', message: 'rule only' }], analysis: {
      contract_version: '1.0.1', dataset_id: payload.dataset_id, run_id: payload.run_id, window: payload.window,
      method: 'rule', model_used: false, records: { room_intervals: roomRows.length, device_intervals: deviceRows.length },
      excluded_devices: device.always_on ? [{ device_id: device.device_id, reason: 'always-on exception' }] : [],
    } });
  };
  return { fetchImpl, get analyses() { return analyses; } };
}

test('analysis job lifecycle persists rule findings and applies current tariff without rerunning Python', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-analysis-job-'));
  const dbPath = join(dir, 'auditor.sqlite');
  let database = new AuditorDatabase(dbPath);
  let server: Server | undefined;
  try {
    database.storeDataset({ datasetId: 'dataset-analysis-test', sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'analysis-fixture', data: structuredClone(fixture) });
    const stub = pythonStub();
    const python = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 1000, fetchImpl: stub.fetchImpl });
    const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python));
    const config = loadConfig({ ML_TIMEOUT_MS: '1000' });
    server = createApp(config, database, { python, jobs }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await fetch(`${base}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { data: { ml_reachable: unknown } }).data.ml_reachable, true);

    const queued = await fetch(`${base}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: 'dataset-analysis-test' }) });
    assert.equal(queued.status, 202);
    const { data: accepted } = await queued.json() as { data: { job_id: string; status: string } };
    assert.equal(accepted.status, 'queued');
    let status: { data: Record<string, unknown> } | undefined;
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}?page_size=10`);
      status = await response.json() as { data: Record<string, unknown> };
      if (status.data.status === 'completed' || status.data.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status?.data.status, 'completed', JSON.stringify(status));
    const result = status!.data.result as Record<string, unknown>;
    assert.equal((result.findings as unknown[]).length, 1);
    const finding = (result.findings as Array<Record<string, unknown>>)[0]!;
    assert.equal(finding.avoidable_energy_kwh, 0.01);
    assert.deepEqual(result.excluded_devices, [{ device_id: 'fridge-b', reason: 'always-on exception' }]);
    assert.equal((result.totals as Record<string, unknown>).dataset_energy_kwh, 0.03);
    assert.equal((result.totals as Record<string, unknown>).tariff_inr_per_kwh, null);
    assert.equal(stub.analyses, 2, 'called once per device; model_available=false does not block rule analysis');

    await fetch(`${base}/api/v1/imports/dataset-analysis-test/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 0 }) });
    const zero = await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}`);
    const zeroData = (await zero.json() as { data: { result: { totals: Record<string, unknown> } } }).data.result.totals;
    assert.equal(zeroData.tariff_inr_per_kwh, 0);
    assert.equal(zeroData.dataset_cost_inr, 0);
    await fetch(`${base}/api/v1/imports/dataset-analysis-test/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 10 }) });
    const priced = await fetch(`${base}/api/v1/analysis/jobs/${accepted.job_id}`);
    const pricedResult = (await priced.json() as { data: { result: { findings: Array<Record<string, unknown>>; totals: Record<string, unknown> } } }).data.result;
    assert.equal(pricedResult.totals.dataset_cost_inr, 0.3);
    assert.equal(pricedResult.findings[0]?.avoidable_cost_inr, 0.1);
    assert.equal(stub.analyses, 2, 'tariff changes do not call Python again');
    assert.equal(database.getDatasetSummary('dataset-analysis-test')?.energy_kwh, 0.03);
    assert.equal(database.getDatasetSummary('dataset-analysis-test')?.synthetic, true);

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

test('Python client distinguishes unavailable, timeout, malformed and valid upstream error envelopes', async () => {
  const unavailable = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => { throw new TypeError('socket refused'); } });
  await assert.rejects(unavailable.analyze({}), (error: unknown) => error instanceof PythonServiceError && error.kind === 'unavailable');
  const timeout = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; } });
  await assert.rejects(timeout.analyze({}), (error: unknown) => error instanceof PythonServiceError && error.kind === 'timeout');
  const malformed = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => Response.json({ data: {}, meta: { request_id: 'bad' } }) });
  await assert.rejects(malformed.analyze({}), (error: unknown) => error instanceof PythonServiceError && error.kind === 'malformed');
  const rejected = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'REQUEST_TOO_LARGE', message: 'bounded' } }), { status: 413 }) });
  await assert.rejects(rejected.analyze({}), (error: unknown) => error instanceof PythonServiceError && error.kind === 'rejected' && error.upstreamCode === 'REQUEST_TOO_LARGE');
});

test('unfinished analysis jobs become honest interrupted failures on restart', () => {
  const database = new AuditorDatabase(':memory:');
  try {
    database.storeDataset({ datasetId: 'dataset-restart', sourceFormat: 'json', sourceResolutionSeconds: 60,
      semanticFingerprint: 'restart-fixture', data: structuredClone(fixture) });
    database.createAnalysisJob({ jobId: 'job-interrupted', datasetId: 'dataset-restart', status: 'queued', request: {} });
    database.createAnalysisJob({ jobId: 'job-running', datasetId: 'dataset-restart', status: 'running', request: {} });
    const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database,
      new PythonAnalysisClient({ baseUrl: 'http://unused.invalid', timeoutMs: 100 })));
    assert.equal(jobs.recoverAfterRestart(), 2);
    const recovered = database.getAnalysisJob('job-interrupted');
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.error_code, 'JOB_INTERRUPTED');
    assert.match(recovered?.error_message ?? '', /service restart/);
    assert.equal(database.getAnalysisJob('job-running')?.error_code, 'JOB_INTERRUPTED');
  } finally { database.close(); }
});

test('unavailable, timed out and malformed Python replies persist failed jobs, never empty successes', async () => {
  const modes = [
    { name: 'unavailable', fetch: async (): Promise<Response> => { throw new TypeError('connection refused'); }, code: 'PYTHON_UNAVAILABLE' },
    { name: 'timeout', fetch: async (): Promise<Response> => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }, code: 'PYTHON_TIMEOUT' },
    { name: 'malformed', fetch: async (): Promise<Response> => Response.json({ data: [], meta: {} }), code: 'PYTHON_MALFORMED' },
  ];
  for (const mode of modes) {
    const database = new AuditorDatabase(':memory:');
    try {
      database.storeDataset({ datasetId: `dataset-${mode.name}`, sourceFormat: 'json', sourceResolutionSeconds: 60,
        semanticFingerprint: `failure-${mode.name}`, data: structuredClone(fixture) });
      const client = new PythonAnalysisClient({ baseUrl: 'http://python.invalid', timeoutMs: 100, fetchImpl: mode.fetch });
      const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, client));
      const accepted = jobs.submit({ dataset_id: `dataset-${mode.name}` });
      let job = database.getAnalysisJob(accepted.job_id);
      for (let i = 0; i < 100 && job?.status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        job = database.getAnalysisJob(accepted.job_id);
      }
      assert.equal(job?.status, 'failed', mode.name);
      assert.equal(job?.error_code, mode.code);
      assert.match(job?.error_message ?? '', /Python analysis/);
      assert.doesNotMatch(job?.error_message ?? '', /stack|TypeError|Traceback/i);
      assert.equal(database.getAnalysisFindings(accepted.job_id, 10, 0).total, 0);
    } finally { database.close(); }
  }
});
