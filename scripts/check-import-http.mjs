// Starts only the auditor server it owns on port 19002 and exercises the
// reference import, duplicate acknowledgement, summary and tariff flow.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'nexyra-p006-http-'));
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOST: '127.0.0.1', PORT: '19002', DATABASE_PATH: join(temp, 'auditor.sqlite') },
});
child.stdout.setEncoding('utf8').on('data', (chunk) => process.stdout.write(chunk));
child.stderr.setEncoding('utf8').on('data', (chunk) => process.stderr.write(chunk));

async function stop() {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

async function upload(bytes, filename) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  return fetch('http://127.0.0.1:19002/api/v1/imports', { method: 'POST', body: form });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Auditor exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch('http://127.0.0.1:19002/api/v1/health');
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for this child process to bind its port. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!ready) throw new Error('Auditor did not become ready on port 19002');

  const json = readFileSync(join(root, 'contracts/v1/fixtures/reference.json'));
  const csv = readFileSync(join(root, 'contracts/v1/fixtures/reference.csv'));
  const initial = await upload(json, 'reference.json');
  const accepted = await initial.json();
  if (initial.status !== 201) throw new Error(`Expected 201 first import; got ${initial.status}`);
  const datasetId = accepted.data.dataset_id;
  const summaryBefore = await (await fetch(`http://127.0.0.1:19002/api/v1/imports/${datasetId}/summary`)).json();
  if (summaryBefore.data.energy_kwh !== 0.03 || summaryBefore.data.cost_inr !== null) throw new Error('Unexpected initial summary');

  const repeat = await upload(json, 'repeat.json');
  const repeated = await repeat.json();
  if (repeat.status !== 200 || repeated.data.dataset_id !== datasetId || !repeated.data.already_imported) throw new Error('Equivalent JSON repeat was not acknowledged');
  const csvRepeat = await upload(csv, 'reference.csv');
  const repeatedCsv = await csvRepeat.json();
  if (csvRepeat.status !== 200 || repeatedCsv.data.dataset_id !== datasetId) throw new Error('CSV/JSON semantic parity failed');

  const tariffResponse = await fetch(`http://127.0.0.1:19002/api/v1/imports/${datasetId}/tariff`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 10 }),
  });
  const tariff = await tariffResponse.json();
  const summaryAfter = await (await fetch(`http://127.0.0.1:19002/api/v1/imports/${datasetId}/summary`)).json();
  if (tariffResponse.status !== 200 || summaryAfter.data.energy_kwh !== 0.03 || summaryAfter.data.cost_inr !== 0.3) throw new Error('Tariff summary verification failed');
  const listing = await (await fetch('http://127.0.0.1:19002/api/v1/imports')).json();
  console.log(JSON.stringify({ first_import_http: initial.status, first_import: accepted.data,
    summary_before_tariff: summaryBefore.data, identical_json_http: repeat.status, identical_json: repeated.data,
    equivalent_csv_http: csvRepeat.status, equivalent_csv: repeatedCsv.data, tariff_http: tariffResponse.status,
    tariff: tariff.data, summary_after_tariff: summaryAfter.data, listed_datasets: listing.data.length }, null, 2));
} finally {
  await stop();
  rmSync(temp, { recursive: true, force: true });
}
