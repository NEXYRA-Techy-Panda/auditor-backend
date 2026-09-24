import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createApp } from '../dist/app.js';
import { PythonAnalysisClient } from '../dist/analysis/client.js';
import { AnalysisBatchRunner } from '../dist/analysis/batches.js';
import { AnalysisJobManager } from '../dist/analysis/jobs.js';
import { ForecastRunner } from '../dist/forecast/runner.js';
import { loadConfig } from '../dist/config.js';
import { AuditorDatabase } from '../dist/db/database.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pythonRepo = resolve(repo, '..', 'energy-ml-service');
const pythonCommit = '7f71363aa9361e67a0cb2815b98aee79b0708cf9';
const pythonExe = join(pythonRepo, '.venv', 'Scripts', 'python.exe');
const referencePath = join(repo, 'contracts', 'v1', 'fixtures', 'reference.json');
if (!existsSync(pythonExe)) throw new Error(`Python interpreter unavailable: ${pythonExe}`);

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function waitHealth(url, child, stderrPath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Committed P013 exited early: ${readFileSync(stderrPath, 'utf8')}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch { /* retry while P013 starts */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Committed P013 did not become healthy: ${readFileSync(stderrPath, 'utf8')}`);
}
async function waitForecast(base, forecastId) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = await fetch(`${base}/api/v1/forecasts/${forecastId}`);
    const body = await response.json();
    if (body.data?.status === 'completed' || body.data?.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Forecast did not settle within 20 seconds');
}
function syntheticMonthDataset() {
  const data = JSON.parse(readFileSync(referencePath, 'utf8'));
  const start = Date.parse('2026-09-21T03:30:00Z');
  const hours = 672;
  const end = start + hours * 3_600_000;
  data.run.run_id = 'run-p020-synthetic-28d';
  data.export.export_id = 'export-p020-synthetic-28d';
  data.export.interval_seconds = 3600;
  data.export.export_start_utc = new Date(start).toISOString().replace('.000Z', 'Z');
  data.export.export_end_utc = new Date(end).toISOString().replace('.000Z', 'Z');
  data.export.created_utc = new Date(end).toISOString().replace('.000Z', 'Z');
  data.synthetic = true;
  data.synthetic_label = 'Generated deterministic 28-day hourly forecast test data; not measured.';
  data.devices.find((device) => device.device_id === 'light-a').quantity = 4;
  data.devices.find((device) => device.device_id === 'fridge-b').quantity = 6;
  const office = data.policies.find((policy) => policy.kind === 'office_hours');
  const previous = structuredClone(office);
  previous.version = 7;
  previous.effective_from_utc = new Date(end - 3_600_000).toISOString().replace('.000Z', 'Z');
  previous.rules.open_local = '08:00';
  const effectiveAtOrigin = structuredClone(office);
  effectiveAtOrigin.version = 2;
  effectiveAtOrigin.effective_from_utc = new Date(end).toISOString().replace('.000Z', 'Z');
  effectiveAtOrigin.rules.open_local = '10:00';
  data.policies.push(previous, effectiveAtOrigin);
  data.room_intervals = [];
  data.device_intervals = [];
  const totals = new Map([['light-a', 0], ['fridge-b', 0]]);
  for (let index = 0; index < hours; index++) {
    const intervalStart = new Date(start + index * 3_600_000).toISOString().replace('.000Z', 'Z');
    const intervalEnd = new Date(start + (index + 1) * 3_600_000).toISOString().replace('.000Z', 'Z');
    for (const roomId of ['room-a', 'room-b']) data.room_intervals.push({ run_id: data.run.run_id,
      room_id: roomId, interval_start_utc: intervalStart, interval_end_utc: intervalEnd,
      interval_seconds: 3600, occupancy_avg: 0, occupancy_max: 0, occupied_fraction: 0,
      avg_temp_c: 25, avg_rh_pct: 50, partial: false });
    for (const item of [
      { deviceId: 'light-a', roomId: 'room-a', energy: 0.01, policy: 'pol-light-a:1' },
      { deviceId: 'fridge-b', roomId: 'room-b', energy: 0.005, policy: 'pol-fridge-b:1' },
    ]) {
      totals.set(item.deviceId, totals.get(item.deviceId) + item.energy);
      data.device_intervals.push({ run_id: data.run.run_id, room_id: item.roomId, device_id: item.deviceId,
        interval_start_utc: intervalStart, interval_end_utc: intervalEnd, interval_seconds: 3600,
        avg_power_w: item.energy * 1000, max_power_w: item.energy * 1000, energy_kwh: item.energy,
        cumulative_kwh: totals.get(item.deviceId), power_factor: 1, on_fraction: 1, override_seconds: 0,
        vacant_on_seconds: 0, offschedule_on_seconds: 0, policy_ref: item.policy, partial: false });
    }
  }
  return data;
}
async function importDataset(base, data, filename) {
  const form = new FormData();
  form.set('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), filename);
  const response = await fetch(`${base}/api/v1/imports`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.dataset_id;
}

const tempRoot = mkdtempSync(join(tmpdir(), 'nexyra-p020-forecast-'));
const archivePath = join(tempRoot, 'p013-app.zip');
const stdoutPath = join(tempRoot, 'python.stdout.log');
const stderrPath = join(tempRoot, 'python.stderr.log');
const stdoutFd = openSync(stdoutPath, 'w');
const stderrFd = openSync(stderrPath, 'w');
let pythonProcess;
let auditorServer;
let database;
let cleanupError;
try {
  const archived = spawnSync('git', ['-C', pythonRepo, 'archive', '--format=zip', '-o', archivePath, pythonCommit, 'app'], { encoding: 'utf8' });
  if (archived.status !== 0) throw new Error(`Could not export committed P013 source: ${archived.stderr}`);
  const extracted = spawnSync('tar', ['-xf', archivePath, '-C', tempRoot], { encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(`Could not extract committed P013 source: ${extracted.stderr}`);
  rmSync(archivePath, { force: true });

  const pythonPort = await freePort();
  const pythonUrl = `http://127.0.0.1:${pythonPort}`;
  // The production launcher has a fixed 19003 port. Test isolated ASGI startup
  // explicitly so this check can use an ephemeral loopback port without adding
  // a runtime override to the service.
  pythonProcess = spawn(pythonExe, ['-B', '-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1', '--port', String(pythonPort)], { cwd: tempRoot, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(pythonPort) },
    stdio: ['ignore', stdoutFd, stderrFd] });
  const healthData = (await waitHealth(pythonUrl, pythonProcess, stderrPath)).data;
  assert.equal(healthData.model_available, false);

  const auditorPort = await freePort();
  database = new AuditorDatabase(join(tempRoot, 'auditor-scratch.sqlite'));
  let forecastRequests = 0;
  const python = new PythonAnalysisClient({ baseUrl: pythonUrl, timeoutMs: 15_000,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/v1/forecast')) forecastRequests++;
      return fetch(input, init);
    } });
  const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, python), new ForecastRunner(database, python));
  jobs.recoverAfterRestart();
  auditorServer = createApp(loadConfig({ ML_SERVICE_URL: pythonUrl, ML_TIMEOUT_MS: '15000' }),
    database, { python, jobs }).listen(auditorPort, '127.0.0.1');
  await new Promise((resolve, reject) => auditorServer.once('listening', resolve).once('error', reject));
  const base = `http://127.0.0.1:${auditorPort}`;

  const datasetId = await importDataset(base, syntheticMonthDataset(), 'synthetic-28-day-hourly.json');
  const post = await fetch(`${base}/api/v1/forecasts`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataset_id: datasetId, horizon: 'next_calendar_month' }) });
  assert.equal(post.status, 202);
  const accepted = (await post.json()).data;
  assert.equal(accepted.origin_utc, '2026-10-19T03:30:00Z');
  assert.equal(accepted.synthetic, true);
  const completed = await waitForecast(base, accepted.forecast_id);
  assert.equal(completed.data.status, 'completed', JSON.stringify(completed));
  const result = completed.data.result;
  assert.equal(result.baseline_version, 'hourly-profile-median-v1');
  assert.equal(result.method, 'statistical_baseline');
  assert.equal(result.model_version, null);
  assert.equal(result.points.length, 720);
  assert.equal(result.horizon_start_utc, '2026-10-31T18:30:00Z');
  assert.equal(result.horizon_end_utc, '2026-11-30T18:30:00Z');
  assert.equal(result.history_coverage.observed_hours, 672);
  assert.equal(result.office_hours_policy.version, 2);
  assert.equal(result.office_hours_policy.effective_from_utc, accepted.origin_utc);
  assert(Math.abs(result.total_energy_kwh - 10.8) < 1e-9);
  assert.equal(result.tariff_inr_per_kwh, null);
  assert.equal(result.forecast_cost_inr, null);
  assert.equal(database.getForecastRecord(accepted.forecast_id).energy_kwh, result.total_energy_kwh);

  const tariff = await fetch(`${base}/api/v1/imports/${datasetId}/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inr_per_kwh: 10 }) });
  assert.equal(tariff.status, 200);
  const repriced = await (await fetch(`${base}/api/v1/forecasts/${accepted.forecast_id}`)).json();
  assert(Math.abs(repriced.data.result.forecast_cost_inr - 108) < 1e-9);
  assert.equal(forecastRequests, 1, 'tariff update does not call Python again');

  const shortDataset = await importDataset(base, JSON.parse(readFileSync(referencePath, 'utf8')), 'reference-short.json');
  const shortPost = await fetch(`${base}/api/v1/forecasts`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataset_id: shortDataset, horizon: 'next_calendar_month' }) });
  const shortAccepted = (await shortPost.json()).data;
  const insufficient = await waitForecast(base, shortAccepted.forecast_id);
  assert.equal(insufficient.data.status, 'failed');
  assert.equal(insufficient.data.error.code, 'INSUFFICIENT_DATA');
  assert.match(insufficient.data.error.message, /at least 672 observed history hours/);
  assert.equal(insufficient.data.result, undefined);

  console.log(JSON.stringify({ status: 'pass', python_commit: pythonCommit, model_available: healthData.model_available,
    horizon: result.horizon, point_count: result.points.length, horizon_start_utc: result.horizon_start_utc,
    horizon_end_utc: result.horizon_end_utc, observed_history_hours: result.history_coverage.observed_hours,
    total_energy_kwh: result.total_energy_kwh, unset_tariff_cost: null, tariff_10_cost_inr: repriced.data.result.forecast_cost_inr,
    effective_origin_policy_version: result.office_hours_policy.version, insufficient_error: insufficient.data.error,
    real_python_forecast_requests: forecastRequests }));
} finally {
  if (auditorServer?.listening) await new Promise((resolve) => auditorServer.close(resolve));
  database?.close();
  if (pythonProcess && pythonProcess.exitCode === null) {
    pythonProcess.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => pythonProcess.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  closeSync(stdoutFd); closeSync(stderrFd);
  for (let attempt = 0; ; attempt++) {
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; }
    catch (error) {
      if (attempt >= 4) { cleanupError = error; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
if (cleanupError) throw cleanupError;
