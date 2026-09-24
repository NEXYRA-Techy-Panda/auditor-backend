import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuditorDatabase, type DatasetImport } from '../src/db/database.js';

const fixture = JSON.parse(readFileSync(new URL('../contracts/v1/fixtures/reference.json', import.meta.url), 'utf8')) as DatasetImport['data'];
const database = new AuditorDatabase(':memory:');
let server: Server;
let base: string;

function seedDataset(datasetId: string, runId: string, exportId: string): void {
  const data = structuredClone(fixture);
  data.run.run_id = runId;
  data.export.export_id = exportId;
  database.storeDataset({ datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: `report-${datasetId}`, data });
}

function seedJob(jobId: string, datasetId: string, findingId: string, type = 'vacant_but_on'): string {
  database.createAnalysisJob({ jobId, datasetId, status: 'completed', request: { dataset_id: datasetId } });
  database.db.prepare("UPDATE analysis_jobs SET method='rule', method_version='vacant-beyond-grace-v1' WHERE job_id=?").run(jobId);
  const details = { finding_id: findingId, finding_type: type, device_id: 'light-a', room_id: 'room-a',
    window_start_utc: '2026-09-21T03:30:00Z', window_end_utc: '2026-09-21T03:31:00Z',
    method: 'rule', suggested_action: 'Review the lighting schedule', assumptions: 'Vacancy beyond applicable grace',
    resolution_limit: '60-second intervals', observed: { value: 0.01, unit: 'kWh' }, avoidable_energy_kwh: 0.01 };
  database.addFinding({ findingId: `${jobId}:${findingId}`, jobId, datasetId, scopeType: 'device', scopeId: 'light-a',
    findingType: type, severity: 'warning', details });
  return findingId;
}

before(async () => {
  seedDataset('dataset-report-a', 'run-report-a', 'export-report-a');
  seedDataset('dataset-report-b', 'run-report-b', 'export-report-b');
  seedJob('job-report-a', 'dataset-report-a', 'vacant_but_on:light-a:2026-09-21T03:30:00Z');
  seedJob('job-report-b', 'dataset-report-b', 'vacant_but_on:light-a:2026-09-21T03:30:00Z');
  database.setTariff('local', 10, 'INR');
  server = createApp(loadConfig({}), database).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

async function preview(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/v1/reports/preview`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

type Row = Record<string, unknown>;
function row(value: unknown): Row { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; }
function nested(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => row(current)[key], value);
}
function firstRecommendation(value: unknown): unknown {
  const recommendations = row(value).recommendations;
  assert.ok(Array.isArray(recommendations));
  return recommendations[0];
}

test('report preview uses persisted vacancy energy and the current saved tariff over HTTP', async () => {
  const datasetBefore = database.getDatasetSummary('dataset-report-a');
  const jobsBefore = database.db.prepare('SELECT count(*) AS n FROM analysis_jobs').get() as { n: number };
  const findingId = 'vacant_but_on:light-a:2026-09-21T03:30:00Z';
  const result = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-a', finding_ids: [findingId] });
  assert.equal(result.status, 200);
  const data = row(result.json.data);
  assert.equal(nested(data.recommendations instanceof Array ? data.recommendations[0] : undefined, 'evidence', 'avoidable_energy_kwh'), 0.01);
  assert.equal(nested(data.recommendations instanceof Array ? data.recommendations[0] : undefined, 'economics', 'gross_savings_inr'), 0.1);
  assert.equal(nested(data.recommendations instanceof Array ? data.recommendations[0] : undefined, 'economics', 'period_roi_percent'), null);
  assert.equal(nested(data.recommendations instanceof Array ? data.recommendations[0] : undefined, 'economics', 'simple_payback_months'), null);
  assert.equal(nested(data.tariff, 'inr_per_kwh'), 10);
  assert.equal(nested(data.scenario_comparison, 'status'), 'unverified');
  assert.equal(database.getDatasetSummary('dataset-report-a')?.energy_kwh, datasetBefore?.energy_kwh);
  assert.equal((database.db.prepare('SELECT count(*) AS n FROM analysis_jobs').get() as { n: number }).n, jobsBefore.n);

  database.setTariff('local', 0, 'INR');
  const zero = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-a', finding_ids: [findingId] });
  assert.equal(nested(zero.json.data, 'tariff', 'inr_per_kwh'), 0);
  assert.equal(nested(firstRecommendation(zero.json.data), 'economics', 'gross_savings_inr'), 0);
  database.db.prepare('DELETE FROM user_tariff_settings WHERE user_id=?').run('local');
  const unset = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-a', finding_ids: [findingId] });
  assert.equal(nested(unset.json.data, 'tariff', 'inr_per_kwh'), null);
  assert.equal(nested(firstRecommendation(unset.json.data), 'economics', 'gross_savings_inr'), null);
});

test('report preview validates persisted ownership, completion, evidence kind, and caller fields', async () => {
  const findingId = 'vacant_but_on:light-a:2026-09-21T03:30:00Z';
  const mismatch = await preview({ dataset_id: 'dataset-report-b', job_id: 'job-report-a', finding_ids: [findingId] });
  assert.equal(mismatch.status, 422);
  assert.equal(nested(mismatch.json.error, 'code'), 'VALIDATION_ERROR');
  const overridden = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-a', finding_ids: [findingId],
    avoidable_energy_kwh: 900, tariff_inr_per_kwh: 0, evidence_type: 'vacancy_estimate' });
  assert.equal(overridden.status, 422);
  const unsupportedId = seedJob('job-report-unsupported', 'dataset-report-a', 'excess:light-a', 'excess_consumption');
  const unsupportedJob = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-unsupported', finding_ids: [unsupportedId] });
  assert.equal(unsupportedJob.status, 422);
  const excessive = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-a',
    finding_ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) });
  assert.equal(excessive.status, 422);
});

test('report preview calculates explicit economics and exposes overlap without totaling claims', async () => {
  database.setTariff('local', 10, 'INR');
  const first = 'vacant_but_on:light-a:2026-09-21T03:30:00Z';
  const second = 'vacant_but_on:light-a:2026-09-21T03:31:00Z';
  database.addFinding({ findingId: `job-report-a:${second}`, jobId: 'job-report-a', datasetId: 'dataset-report-a', scopeType: 'device',
    scopeId: 'light-a', findingType: 'vacant_but_on', severity: 'warning', details: {
      finding_id: 'vacant_but_on:light-a:2026-09-21T03:31:00Z', finding_type: 'vacant_but_on', device_id: 'light-a', room_id: 'room-a',
      window_start_utc: '2026-09-21T03:30:30Z', window_end_utc: '2026-09-21T03:31:30Z', method: 'rule',
      suggested_action: 'Review the lighting schedule', assumptions: 'fixture assumption', observed: { value: 0.02, unit: 'kWh' },
      avoidable_energy_kwh: 0.02,
    } });
  const result = await preview({ dataset_id: 'dataset-report-a', job_id: 'job-report-a', finding_ids: [first, second],
    economics: { implementation_cost_inr: 1000, recurring_cost_inr: 10, recurring_cost_period_months: 1,
      supported_gross_recurring_savings_inr_per_month: 100 } });
  assert.equal(result.status, 200);
  const data = row(result.json.data);
  assert.equal((data.overlap_conflicts as unknown[]).length, 1);
  assert.equal((data.recommendations as unknown[]).length, 2);
  assert.deepEqual(nested(data.ranking, 'ranked_ids'), []);
  assert.equal((nested(data.ranking, 'unranked_ids') as unknown[]).length, 2);
  assert.equal(nested((data.recommendations as unknown[])[0], 'economics', 'simple_payback_months'), 1000 / 90);
});
