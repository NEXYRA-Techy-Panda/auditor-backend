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

/**
 * P026 real integration check: the auditor's public excess-consumption and
 * gradual-trend jobs against the pinned committed Python detectors, on a
 * scratch database and an isolated ephemeral loopback Python port. It never
 * touches a deployed service, database or port: the sibling repository is only
 * read (git archive) and its existing interpreter is reused unchanged.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pythonRepo = resolve(repo, '..', 'energy-ml-service');
const pythonCommit = 'a0a86cc5d96b16082d8a1d1b911de7a7d1b2474d';
const pythonExe = join(pythonRepo, '.venv', 'Scripts', 'python.exe');
if (!existsSync(pythonExe)) throw new Error(`The existing Python interpreter is unavailable: ${pythonExe}`);

const DAY = 86_400_000;
const iso = (epochMs) => new Date(epochMs).toISOString().replace('.000Z', 'Z');
const START = Date.parse('2026-01-01T00:00:00Z');

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitHealth(url, child, stderrPath) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Pinned Python exited early: ${readFileSync(stderrPath, 'utf8')}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch { /* retry until the isolated service is ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pinned Python did not become healthy: ${readFileSync(stderrPath, 'utf8')}`);
}

const fixturePath = join(repo, 'contracts', 'v1', 'fixtures', 'reference.json');

function dataset({ id, resolutionSeconds, days, power, deviceType = 'lighting', appliesTo = 'device:light-a' }) {
  const start = START;
  const end = start + days * DAY;
  const step = resolutionSeconds * 1000;
  const device_intervals = [];
  const room_intervals = [];
  for (let at = start; at < end; at += step) {
    const offset = at - start;
    const watts = power(offset);
    const occupied = ((at + 19_800_000) % DAY) / 3_600_000 >= 9 && ((at + 19_800_000) % DAY) / 3_600_000 < 18;
    device_intervals.push({ run_id: 'run-p026', room_id: 'room-a', device_id: 'light-a',
      interval_start_utc: iso(at), interval_end_utc: iso(at + step), interval_seconds: resolutionSeconds,
      avg_power_w: watts, max_power_w: watts, energy_kwh: watts * resolutionSeconds / 3_600_000,
      cumulative_kwh: 0, avg_voltage_v: 230, avg_current_a: 1, power_factor: 1, on_fraction: 1,
      override_seconds: 0, vacant_on_seconds: 0, offschedule_on_seconds: 0, policy_ref: 'pol-light-a:1', partial: false });
    room_intervals.push({ run_id: 'run-p026', room_id: 'room-a', interval_start_utc: iso(at),
      interval_end_utc: iso(at + step), interval_seconds: resolutionSeconds,
      occupancy_avg: occupied ? 2 : 0, occupancy_max: occupied ? 2 : 0, occupied_fraction: occupied ? 1 : 0,
      avg_temp_c: 26, avg_rh_pct: 55, partial: false });
  }
  return { schema_version: '1.0.1', source: 'simulation', synthetic: true,
    synthetic_label: 'synthetic P026 integration fixture (not real building data)',
    building: { building_id: 'nexyra-demo-office', name: 'Demo office', timezone: 'Asia/Kolkata' },
    run: { run_id: 'run-p026', scenario_id: 'original', run_start_utc: iso(start), comparison_id: null },
    export: { export_id: `export-${id}`, export_start_utc: iso(start), export_end_utc: iso(end),
      interval_seconds: resolutionSeconds, created_utc: iso(end) },
    rooms: [{ room_id: 'room-a', name: 'Open workspace', room_type: 'open_workspace', capacity: 8, floor_area_m2: 40 }],
    devices: [{ device_id: 'light-a', room_id: 'room-a', name: 'Lighting A', device_type: deviceType, quantity: 1,
      nominal_power_w: 600, standby_power_w: 0, power_factor: 1, always_on: false, control: 'scheduled', controls: ['power'] }],
    policies: [{ policy_id: 'pol-light-a', version: 1, applies_to: appliesTo, kind: 'lighting_schedule',
      effective_from_utc: iso(start), rules: { on_during_hours: true, vacancy_grace_seconds: 300 } }],
    room_intervals, device_intervals };
}

const tempRoot = mkdtempSync(join(tmpdir(), 'nexyra-p026-detectors-'));
const archivePath = join(tempRoot, 'p024-app.tar');
const pythonOut = join(tempRoot, 'python.stdout.log');
const pythonErr = join(tempRoot, 'python.stderr.log');
const pythonStdoutFd = openSync(pythonOut, 'w');
const pythonStderrFd = openSync(pythonErr, 'w');
let pythonProcess;
let auditorServer;
let database;
let cleanupError;
try {
  const archive = spawnSync('git', ['-C', pythonRepo, 'archive', '--format=tar', '-o', archivePath, pythonCommit, 'app'], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`Could not export committed P024 source: ${archive.stderr}`);
  // Plain tar (not zip): the extraction runs with a relative path and cwd so
  // Windows drive letters are not mistaken for tar's remote-host syntax.
  const extraction = spawnSync('tar', ['-xf', 'p024-app.tar'], { cwd: tempRoot, encoding: 'utf8' });
  if (extraction.status !== 0) throw new Error(`Could not extract committed P024 source: ${extraction.stderr}`);
  rmSync(archivePath, { force: true });

  const pythonPort = await freePort();
  const pythonUrl = `http://127.0.0.1:${pythonPort}`;
  // The deployed launcher fixes port 19003. An isolated ASGI startup is used so
  // this check can pick an ephemeral loopback port without touching that
  // configuration or any process already listening on the fixed ports.
  pythonProcess = spawn(pythonExe, ['-B', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(pythonPort)],
    { cwd: tempRoot, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1' },
      stdio: ['ignore', pythonStdoutFd, pythonStderrFd] });
  const pythonHealth = await waitHealth(pythonUrl, pythonProcess, pythonErr);
  assert.equal(pythonHealth.data.status, 'ok');
  assert.equal(pythonHealth.data.model_available, false, 'both detectors must work without a trained model');

  const observed = { calls: 0, maxDevice: 0, maxRoom: 0, paths: new Set() };
  const pythonClient = new PythonAnalysisClient({ baseUrl: pythonUrl, timeoutMs: 20_000,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/anomalies') || url.endsWith('/v1/drift')) {
        const request = JSON.parse(String(init?.body ?? '{}'));
        observed.calls++;
        observed.paths.add(url.slice(url.indexOf('/v1/')));
        for (const section of ['reference', 'evaluation']) {
          observed.maxDevice = Math.max(observed.maxDevice, request[section].device_intervals.length);
          observed.maxRoom = Math.max(observed.maxRoom, request[section].room_intervals.length);
          assert(request[section].device_intervals.length <= 2000, `${section} device intervals exceed Python's bound`);
          assert(request[section].room_intervals.length <= 2000, `${section} room intervals exceed Python's bound`);
          for (const record of request[section].device_intervals) {
            assert.equal(record.partial, false);
            assert(Math.abs(record.energy_kwh - record.avg_power_w * record.interval_seconds / 3_600_000) < 1e-9,
              'aggregated energy must stay consistent with avg_power_w x interval_seconds');
          }
        }
        assert.equal(request.contract_version, '1.0.1');
      }
      return fetch(input, init);
    } });
  database = new AuditorDatabase(join(tempRoot, 'auditor-scratch.sqlite'));
  const jobs = new AnalysisJobManager(database, new AnalysisBatchRunner(database, pythonClient));
  const config = loadConfig({ ML_SERVICE_URL: pythonUrl, ML_TIMEOUT_MS: '20000' });
  const auditPort = await freePort();
  auditorServer = createApp(config, database, { python: pythonClient, jobs }).listen(auditPort, '127.0.0.1');
  await new Promise((resolve, reject) => auditorServer.once('listening', resolve).once('error', reject));
  const auditUrl = `http://127.0.0.1:${auditPort}`;

  const submit = async (datasetId, detector, reference, evaluation) => {
    const queued = await fetch(`${auditUrl}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(detector === 'vacancy'
        ? { dataset_id: datasetId }
        : { dataset_id: datasetId, detector, reference_window: reference, evaluation_window: evaluation }) });
    const accepted = await queued.text();
    assert.equal(queued.status, 202, accepted);
    const acceptedData = JSON.parse(accepted).data;
    assert.equal(acceptedData.detector, detector, 'the queued response always carries the detector identity');
    const jobId = acceptedData.job_id;
    for (let attempt = 0; attempt < 1500; attempt++) {
      const body = await (await fetch(`${auditUrl}/api/v1/analysis/jobs/${jobId}?page_size=50`)).json();
      if (body.data.status === 'completed' || body.data.status === 'failed') {
        assert.equal(body.data.status, 'completed', JSON.stringify(body.data.error));
        return body.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('detector job did not settle within 30 seconds');
  };

  const window = (fromDays, toDays) => ({ start_utc: iso(START + fromDays * DAY), end_utc: iso(START + toDays * DAY) });

  const catalogue = await (await fetch(`${auditUrl}/api/v1/detectors`)).json();
  assert.deepEqual(catalogue.data.detectors.map((entry) => entry.id), ['vacancy', 'excess_consumption', 'gradual_trend']);
  assert.equal(catalogue.data.limits.max_section_records, 2000);

  // Vacancy must stay the default and keep its previous behaviour and shape.
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  database.storeDataset({ datasetId: 'dataset-p026-vacancy', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: 'p026-vacancy', data: fixture });
  const vacancy = await submit('dataset-p026-vacancy', 'vacancy');
  assert.equal(vacancy.method_version, 'vacant-beyond-grace-v1');
  assert.equal(vacancy.result.findings.length, 1);
  assert.equal(vacancy.result.findings[0].finding_type, 'vacant_but_on');
  assert.equal(vacancy.result.findings[0].avoidable_energy_kwh, 0.01);
  assert.equal(vacancy.detector, undefined,
    'the vacancy result keeps its documented shape; the additive detector block exists only for the two new detectors');

  const minute = dataset({ id: 'minute', resolutionSeconds: 60, days: 5,
    power: (offset) => (offset < 3 * DAY ? 600 : 1000) });
  database.storeDataset({ datasetId: 'dataset-p026-minute', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: 'p026-minute', data: minute });

  // Reference/evaluation validation is enforced before queueing.
  const rejected = await fetch(`${auditUrl}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataset_id: 'dataset-p026-minute', detector: 'excess_consumption',
      reference_window: window(2, 3), evaluation_window: window(1, 2) }) });
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error.field, 'reference_window');
  const unaligned = await fetch(`${auditUrl}/api/v1/analysis/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataset_id: 'dataset-p026-minute', detector: 'gradual_trend',
      reference_window: { start_utc: iso(START + 30_000), end_utc: iso(START + 90_000) },
      evaluation_window: { start_utc: iso(START + 120_000), end_utc: iso(START + 180_000) } }) });
  assert.equal(unaligned.status, 422);
  assert.match((await unaligned.json()).error.message, /align/);
  const increased = await submit('dataset-p026-minute', 'excess_consumption', window(0, 2), window(2, 4));
  assert.equal(increased.result.status, 'findings_detected', JSON.stringify(increased.result.devices));
  assert.equal(increased.result.findings.length, 1);
  assert.equal(increased.result.findings[0].finding_type, 'excess_consumption_deviation');
  assert(increased.result.findings[0].energy_above_baseline_kwh > 0);
  assert.equal(increased.result.detector.method_version, 'excess-power-mad-v1');
  assert.equal(increased.result.aggregation.resolutions_by_device['light-a'], 300,
    'minute readings are aggregated onto a requested contract interval that fits the bound');
  assert.equal(increased.result.warnings.some((warning) => warning.code === 'AGGREGATED_INTERVALS'), true);
  assert.equal(increased.detector.method_version, 'excess-power-mad-v1', 'job polling keeps the detector identity');
  assert.equal(increased.result.totals.avoidable_energy_kwh, undefined, 'a deviation is never reported as avoidable energy');
  assert.equal(increased.result.totals.dataset_cost_inr, undefined, 'detector results are never priced');
  assert.equal(increased.result.findings[0].avoidable_energy_kwh, undefined);
  assert.equal(increased.result.findings[0].avoidable_cost_inr, undefined);
  assert.match(increased.result.findings[0].energy_note, /NOT a guaranteed avoidable amount/);
  assert.deepEqual(increased.result.aggregation.excluded_device_bins['light-a'], undefined,
    'fully-on minute data aggregates without exclusions');

  // A referenced policy that is not device-scoped cannot be sent to Python, so
  // the device is reported as not assessed rather than as evaluated-no-findings.
  const misapplied = dataset({ id: 'scope', resolutionSeconds: 3600, days: 5, power: () => 600,
    appliesTo: 'building:nexyra-demo-office' });
  database.storeDataset({ datasetId: 'dataset-p026-scope', sourceFormat: 'json', sourceResolutionSeconds: 3600,
    semanticFingerprint: 'p026-scope', data: misapplied });
  const notAssessed = await submit('dataset-p026-scope', 'excess_consumption', window(0, 1), window(1, 3));
  assert.equal(notAssessed.result.status, 'unsupported_aggregation');
  assert.equal(notAssessed.result.findings.length, 0);
  assert.equal(notAssessed.result.devices[0].assessment_source, 'auditor_precheck');
  assert.match(notAssessed.result.devices[0].reason, /device-scoped/);
  assert.notEqual(notAssessed.result.status, 'evaluated_no_deviation',
    'not assessed must stay distinct from evaluated with no deviation');

  const stable = await submit('dataset-p026-minute', 'excess_consumption', window(0, 1), window(1, 2));
  assert.equal(stable.result.status, 'evaluated_no_deviation');
  assert.equal(stable.result.findings.length, 0);

  const thin = dataset({ id: 'thin', resolutionSeconds: 60, days: 1, power: () => 600 });
  database.storeDataset({ datasetId: 'dataset-p026-thin', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: 'p026-thin', data: thin });
  const insufficient = await submit('dataset-p026-thin', 'excess_consumption',
    { start_utc: iso(START), end_utc: iso(START + 10 * 60_000) },
    { start_utc: iso(START + 10 * 60_000), end_utc: iso(START + 20 * 60_000) });
  assert.equal(insufficient.result.status, 'insufficient_reference');
  assert.equal(insufficient.result.findings.length, 0);
  assert.notEqual(insufficient.result.status, stable.result.status,
    'insufficient reference stays distinct from evaluated with no deviation');

  const hourly = (id, power) => dataset({ id, resolutionSeconds: 3600, days: 22, power });
  database.storeDataset({ datasetId: 'dataset-p026-ramp', sourceFormat: 'json', sourceResolutionSeconds: 3600,
    semanticFingerprint: 'p026-ramp', data: hourly('ramp', (offset) => offset < 7 * DAY ? 600 : 600 + 300 * (offset - 7 * DAY) / (15 * DAY)) });
  database.storeDataset({ datasetId: 'dataset-p026-flat', sourceFormat: 'json', sourceResolutionSeconds: 3600,
    semanticFingerprint: 'p026-flat', data: hourly('flat', () => 600) });
  // The step sits well inside the evaluation window: the detector requires at
  // least three days on each side of a changepoint to call a step a step.
  database.storeDataset({ datasetId: 'dataset-p026-step', sourceFormat: 'json', sourceResolutionSeconds: 3600,
    semanticFingerprint: 'p026-step', data: hourly('step', (offset) => offset < 14 * DAY ? 600 : 750) });

  const reference = window(0, 7);
  const evaluation = window(7, 22);
  const trend = await submit('dataset-p026-ramp', 'gradual_trend', reference, evaluation);
  assert.equal(trend.result.status, 'findings_detected', JSON.stringify(trend.result.devices));
  assert.equal(trend.result.findings[0].finding_type, 'sustained_upward_power_trend');
  assert.equal(trend.result.detector.method_version, 'gradual-power-trend-v1');
  assert.deepEqual(trend.result.other_changes, []);

  const flat = await submit('dataset-p026-flat', 'gradual_trend', reference, evaluation);
  assert.equal(flat.result.status, 'evaluated_no_gradual_trend');
  assert.equal(flat.result.findings.length, 0);

  const step = await submit('dataset-p026-step', 'gradual_trend', reference, evaluation);
  assert.equal(step.result.findings.length, 0, 'a step is not a gradual trend finding');
  assert.equal(step.result.status, 'evaluated_no_gradual_trend');
  assert.equal(step.result.other_changes.length, 1);
  assert.equal(step.result.other_changes[0].classification, 'abrupt_level_change');

  const short = await submit('dataset-p026-flat', 'gradual_trend', reference, window(7, 15));
  assert.equal(short.result.status, 'insufficient_history');
  assert.equal(short.result.findings.length, 0);

  console.log(JSON.stringify({ status: 'pass', python_commit: pythonCommit, python_port: pythonPort,
    python_model_available: pythonHealth.data.model_available, detector_requests: observed.calls,
    detector_paths: [...observed.paths].sort(), max_device_records_per_section: observed.maxDevice,
    max_room_records_per_section: observed.maxRoom,
    vacancy: { default_when_omitted: true, method_version: vacancy.method_version, findings: vacancy.result.findings.length,
      avoidable_energy_kwh: vacancy.result.findings[0].avoidable_energy_kwh,
      result_detector_block_absent: vacancy.detector === undefined },
    validation: { reference_after_evaluation: rejected.status, unaligned_window: unaligned.status },
    not_assessed: { status: notAssessed.result.status, assessment_source: notAssessed.result.devices[0].assessment_source,
      findings: notAssessed.result.findings.length },
    anomalies: { status: increased.result.status, findings: increased.result.findings.length,
      observed_w: increased.result.findings[0].observed.value, reference_median_w: increased.result.findings[0].expected.value,
      threshold_w: increased.result.findings[0].threshold_w,
      energy_above_baseline_kwh: increased.result.findings[0].energy_above_baseline_kwh,
      flagged_intervals: increased.result.detector_coverage.flagged, resolution_seconds: 300,
      stable_status: stable.result.status, insufficient_status: insufficient.result.status },
    drift: { trend_status: trend.result.status, watts_per_day: trend.result.findings[0].trend.watts_per_day,
      relative_change_over_period: trend.result.findings[0].trend.relative_change_over_period,
      reference_level_w: trend.result.findings[0].reference_level_w,
      reference_days: trend.result.findings[0].support.reference_days,
      evaluation_days: trend.result.findings[0].support.evaluation_days,
      flat_status: flat.result.status, step_classification: step.result.other_changes[0].classification,
      short_status: short.result.status } }));
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
