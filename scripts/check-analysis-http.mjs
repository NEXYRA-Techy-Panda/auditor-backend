import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createApp } from '../dist/app.js';
import { AnalysisBatchRunner } from '../dist/analysis/batches.js';
import { PythonAnalysisClient } from '../dist/analysis/client.js';
import { AnalysisJobManager } from '../dist/analysis/jobs.js';
import { loadConfig } from '../dist/config.js';
import { AuditorDatabase } from '../dist/db/database.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pythonRepo = resolve(repo, '..', 'energy-ml-service');
const pythonCommit = '36f5832f298379c3a889a32673c409152aa8eaf0';
const pythonExe = join(pythonRepo, '.venv', 'Scripts', 'python.exe');
const fixturePath = join(repo, 'contracts', 'v1', 'fixtures', 'reference.json');
if (!existsSync(pythonExe)) throw new Error(`The existing Python interpreter is unavailable: ${pythonExe}`);

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function waitHealth(url, child, stderrPath) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Committed P010 exited early: ${readFileSync(stderrPath, 'utf8')}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch { /* retry until the isolated service is ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Committed P010 did not become healthy: ${readFileSync(stderrPath, 'utf8')}`);
}
async function waitJob(base, id) {
  for (let i = 0; i < 500; i++) {
    const response = await fetch(`${base}/api/v1/analysis/jobs/${id}?page_size=20`);
    const body = await response.json();
    if (body.data?.status === 'completed' || body.data?.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Analysis job did not settle within 10 seconds');
}
function reference() { return JSON.parse(readFileSync(fixturePath, 'utf8')); }
function longVacancyDataset() {
  const data = reference();
  const start = Date.parse(data.export.export_start_utc);
  data.run.run_id = 'run-batch-boundary';
  data.export.export_id = 'export-batch-boundary';
  data.export.export_end_utc = new Date(start + 1005 * 60_000).toISOString().replace('.000Z', 'Z');
  const originalLightPolicy = data.policies.find((item) => item.policy_id === 'pol-light-a');
  originalLightPolicy.rules.vacancy_grace_seconds = 120;
  const lightPolicy = structuredClone(originalLightPolicy);
  lightPolicy.version = 2;
  lightPolicy.effective_from_utc = new Date(start + 1000 * 60_000).toISOString().replace('.000Z', 'Z');
  lightPolicy.rules.vacancy_grace_seconds = 300;
  data.policies.push(lightPolicy);
  data.room_intervals = [];
  data.device_intervals = [];
  for (let i = 0; i < 1005; i++) {
    const from = new Date(start + i * 60_000).toISOString().replace('.000Z', 'Z');
    const to = new Date(start + (i + 1) * 60_000).toISOString().replace('.000Z', 'Z');
    for (const roomId of ['room-a', 'room-b']) {
      const occupied = roomId === 'room-a' && i === 0;
      data.room_intervals.push({ run_id: data.run.run_id, room_id: roomId, interval_start_utc: from,
        interval_end_utc: to, interval_seconds: 60, occupancy_avg: occupied ? 1 : 0,
        occupancy_max: occupied ? 1 : 0, occupied_fraction: occupied ? 1 : 0,
        avg_temp_c: 25, avg_rh_pct: 50, partial: false });
    }
    data.device_intervals.push({ run_id: data.run.run_id, room_id: 'room-a', device_id: 'light-a',
      interval_start_utc: from, interval_end_utc: to, interval_seconds: 60, avg_power_w: 600,
      max_power_w: 600, energy_kwh: 0.01, cumulative_kwh: 0.01 * (i + 1), power_factor: 1,
      on_fraction: 1, override_seconds: 0, vacant_on_seconds: i === 0 ? 0 : 60,
      offschedule_on_seconds: 0, policy_ref: i >= 1000 ? 'pol-light-a:2' : 'pol-light-a:1', partial: false });
    data.device_intervals.push({ run_id: data.run.run_id, room_id: 'room-b', device_id: 'fridge-b',
      interval_start_utc: from, interval_end_utc: to, interval_seconds: 60, avg_power_w: 300,
      max_power_w: 300, energy_kwh: 0.005, cumulative_kwh: 0.005 * (i + 1), power_factor: 1,
      on_fraction: 1, override_seconds: 0, vacant_on_seconds: 60, offschedule_on_seconds: 0,
      policy_ref: 'pol-fridge-b:1', partial: false });
  }
  return data;
}

const tempRoot = mkdtempSync(join(tmpdir(), 'nexyra-p015-analysis-'));
const archivePath = join(tempRoot, 'p010-app.zip');
const pythonOut = join(tempRoot, 'python.stdout.log');
const pythonErr = join(tempRoot, 'python.stderr.log');
const pythonStdoutFd = openSync(pythonOut, 'w');
const pythonStderrFd = openSync(pythonErr, 'w');
let pythonProcess;
let auditorServer;
let database;
let cleanupError;
try {
  const archive = spawnSync('git', ['-C', pythonRepo, 'archive', '--format=zip', '-o', archivePath, pythonCommit, 'app'], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`Could not export committed P010 source: ${archive.stderr}`);
  const extraction = spawnSync('tar', ['-xf', archivePath, '-C', tempRoot], { encoding: 'utf8' });
  if (extraction.status !== 0) throw new Error(`Could not extract committed P010 source: ${extraction.stderr}`);
  rmSync(archivePath, { force: true });
  const pythonPort = await freePort();
  const pythonUrl = `http://127.0.0.1:${pythonPort}`;
  // The production launcher has a fixed 19003 port. Test isolated ASGI startup
  // explicitly so this check can use an ephemeral loopback port without adding
  // a runtime override to the service.
  pythonProcess = spawn(pythonExe, ['-B', '-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1', '--port', String(pythonPort)], { cwd: tempRoot, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(pythonPort) },
    stdio: ['ignore', pythonStdoutFd, pythonStderrFd] });
  const pythonHealth = await waitHealth(pythonUrl, pythonProcess, pythonErr);
  assert.equal(pythonHealth.data.status, 'ok');
  assert.equal(pythonHealth.data.model_available, false);

  const auditPort = await freePort();
  const dbPath = join(tempRoot, 'auditor-scratch.sqlite');
  database = new AuditorDatabase(dbPath);
  const observedBounds = { maxDevice: 0, maxRoom: 0, requestCount: 0 };
  const pythonClient = new PythonAnalysisClient({ baseUrl: pythonUrl, timeoutMs: 10_000,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/v1/analyze')) {
        const request = JSON.parse(String(init?.body ?? '{}'));
        observedBounds.maxDevice = Math.max(observedBounds.maxDevice, request.device_intervals.length);
        observedBounds.maxRoom = Math.max(observedBounds.maxRoom, request.room_intervals.length);
        observedBounds.requestCount++;
        assert(request.device_intervals.length <= 2000 && request.room_intervals.length <= 2000);
        assert(request.window.start_utc <= request.device_intervals[0].interval_start_utc);
        assert(request.window.end_utc >= request.device_intervals.at(-1).interval_end_utc);
      }
      return fetch(input, init);
    } });
  const runner = new AnalysisBatchRunner(database, pythonClient);
  const jobs = new AnalysisJobManager(database, runner);
  jobs.recoverAfterRestart();
  const config = loadConfig({ ML_SERVICE_URL: pythonUrl, ML_TIMEOUT_MS: '10000' });
  auditorServer = createApp(config, database, { python: pythonClient, jobs }).listen(auditPort, '127.0.0.1');
  await new Promise((resolve, reject) => auditorServer.once('listening', resolve).once('error', reject));
  const auditUrl = `http://127.0.0.1:${auditPort}`;

  const bytes = readFileSync(fixturePath);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'application/json' }), 'reference.json');
  const upload = await fetch(`${auditUrl}/api/v1/imports`, { method: 'POST', body: form });
  assert.equal(upload.status, 201);
  const imported = (await upload.json()).data;
  const queued = await fetch(`${auditUrl}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataset_id: imported.dataset_id }) });
  assert.equal(queued.status, 202);
  const jobId = (await queued.json()).data.job_id;
  const completed = await waitJob(auditUrl, jobId);
  assert.equal(completed.data.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.data.result.findings.length, 1);
  assert.equal(completed.data.result.findings[0].device_id, 'light-a');
  assert.equal(completed.data.result.findings[0].avoidable_energy_kwh, 0.01);
  assert.equal(completed.data.result.excluded_devices.some((item) => item.device_id === 'fridge-b'), true);
  assert.equal(completed.data.result.synthetic, true);
  assert.equal(completed.data.result.totals.dataset_energy_kwh, 0.03);
  assert.equal(completed.data.result.totals.tariff_inr_per_kwh, null);
  const health = await fetch(`${auditUrl}/api/v1/health`);
  assert.equal((await health.json()).data.ml_reachable, true);
  const list = await fetch(`${auditUrl}/api/v1/imports?page=1&page_size=10`);
  assert.equal((await list.json()).meta.pagination.total, 1);
  const summary = await fetch(`${auditUrl}/api/v1/imports/${imported.dataset_id}/summary`);
  assert.equal((await summary.json()).data.energy_kwh, 0.03);
  const zeroTariff = await fetch(`${auditUrl}/api/v1/imports/${imported.dataset_id}/tariff`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 0 }) });
  assert.equal(zeroTariff.status, 200);
  const zeroCost = await waitJob(auditUrl, jobId);
  assert.equal(zeroCost.data.result.totals.tariff_inr_per_kwh, 0);
  assert.equal(zeroCost.data.result.totals.dataset_cost_inr, 0);
  const requestsBeforeTariffEdit = observedBounds.requestCount;
  const freeTariff = await fetch(`${auditUrl}/api/v1/imports/${imported.dataset_id}/tariff`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 10 }) });
  assert.equal(freeTariff.status, 200);
  const priced = await waitJob(auditUrl, jobId);
  assert.equal(priced.data.result.totals.dataset_cost_inr, 0.3);
  assert.equal(priced.data.result.totals.avoidable_cost_inr, 0.1);
  assert.equal(observedBounds.requestCount, requestsBeforeTariffEdit, 'tariff changes do not rerun Python');

  const boundary = longVacancyDataset();
  database.storeDataset({ datasetId: 'dataset-batch-boundary', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: 'p015-batch-boundary', data: boundary });
  const startUtc = boundary.export.export_start_utc;
  const endUtc = boundary.export.export_end_utc;
  const wholeLike = await runner.run('dataset-batch-boundary', startUtc, endUtc, { batchSize: 1000 });
  const repartitioned = await runner.run('dataset-batch-boundary', startUtc, endUtc, { batchSize: 317 });
  for (const key of ['findings', 'warnings', 'excluded_devices', 'coverage', 'synthetic', 'method', 'method_version']) {
    assert.deepEqual(repartitioned[key], wholeLike[key], `batch partition changed ${key}`);
  }
  assert.equal(wholeLike.findings.length, 1);
  assert(Math.abs(wholeLike.findings[0].avoidable_energy_kwh - 10.02) < 1e-9);
  assert.deepEqual(wholeLike.findings[0].evidence.policy_refs, ['pol-light-a:1', 'pol-light-a:2']);
  assert.equal(wholeLike.coverage.complete, true);

  const gapStart = new Date(Date.parse(startUtc) + 500 * 60_000).toISOString().replace('.000Z', 'Z');
  database.db.prepare('DELETE FROM room_intervals WHERE dataset_id=? AND room_id=? AND interval_start_utc=?')
    .run('dataset-batch-boundary', 'room-a', gapStart);
  const gapResult = await runner.run('dataset-batch-boundary', startUtc, endUtc, { batchSize: 317 });
  assert.equal(gapResult.coverage.complete, false);
  assert.equal(gapResult.findings.length, 2);
  assert.equal(gapResult.findings[0].window_end_utc, gapStart);
  assert.equal(gapResult.findings[1].window_start_utc, new Date(Date.parse(gapStart) + 3 * 60_000).toISOString().replace('.000Z', 'Z'));
  assert.equal(gapResult.warnings.some((warning) => warning.code === 'NO_ROOM_INTERVAL'), true);
  assert(observedBounds.maxDevice <= 2000 && observedBounds.maxRoom <= 2000);
  console.log(JSON.stringify({ status: 'pass', python_commit: pythonCommit, reference_findings: 1,
    reference_avoidable_energy_kwh: completed.data.result.findings[0].avoidable_energy_kwh,
    dataset_energy_kwh: completed.data.result.totals.dataset_energy_kwh, dataset_cost_inr_at_10: 0.3,
    boundary_findings: wholeLike.findings.length, boundary_energy_kwh: wholeLike.findings[0].avoidable_energy_kwh,
    compared_batch_sizes: [1000, 317], missing_room_findings: gapResult.findings.length,
    missing_room_warnings: gapResult.warnings.map((item) => item.code), max_python_device_intervals: observedBounds.maxDevice,
    max_python_room_intervals: observedBounds.maxRoom, python_requests: observedBounds.requestCount,
    python_model_available: pythonHealth.data.model_available }));
} finally {
  if (auditorServer?.listening) await new Promise((resolve) => auditorServer.close(resolve));
  database?.close();
  if (pythonProcess && pythonProcess.exitCode === null) {
    pythonProcess.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => pythonProcess.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  closeSync(pythonStdoutFd); closeSync(pythonStderrFd);
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      break;
    } catch (error) {
      if (attempt >= 4) { cleanupError = error; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
if (cleanupError) throw cleanupError;
