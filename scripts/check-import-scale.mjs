// Bounded end-to-end import exercise for a 31-day, one-minute, 18-device CSV.
// Generates all data in OS temp storage, starts only its own server on port 4001,
// then removes its upload and temporary database.
import { once } from 'node:events';
import { createWriteStream, mkdtempSync, openAsBlob, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'nexyra-p006-scale-'));
const csvPath = join(temp, 'month.csv');
const dbPath = join(temp, 'auditor.sqlite');
const firstMs = Date.parse('2026-01-01T00:00:00Z');
const intervalCount = 31 * 24 * 60;
const deviceCount = 18;
const rowCount = intervalCount * deviceCount;
const rounded = (value) => Math.round(value * 1e12) / 1e12;
const quote = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const rowText = (cells) => `${cells.map((value) => quote(String(value))).join(',')}\r\n`;

function room(id) { return { room_id: id, name: `Room ${id}`, room_type: 'office', capacity: 10 }; }
function device(index) {
  const id = `dev-${String(index + 1).padStart(2, '0')}`;
  return { device_id: id, name: `Device ${id}`, room_id: `room-${(index % 5) + 1}`, device_type: 'lighting', quantity: 1,
    nominal_power_w: 7, standby_power_w: 0, power_factor: 1, always_on: true, control: 'always_on', controls: [] };
}
const rooms = Array.from({ length: 5 }, (_, index) => room(`room-${index + 1}`));
const devices = Array.from({ length: deviceCount }, (_, index) => device(index));
const policies = devices.map((item, index) => ({ policy_id: `pol-${String(index + 1).padStart(2, '0')}`, version: 1,
  applies_to: `device:${item.device_id}`, kind: 'always_on', effective_from_utc: '2026-01-01T00:00:00Z', rules: { always_on_exception: true } }));
const endUtc = new Date(firstMs + intervalCount * 60_000).toISOString().replace('.000Z', 'Z');
const metadata = {
  schema_version: '1.0.1', source: 'simulation', synthetic: true, synthetic_label: 'Temporary P006 scale-check data',
  building: { building_id: 'scale-office', name: 'Scale office', timezone: 'Asia/Kolkata' },
  run: { run_id: 'scale-run', scenario_id: 'original', comparison_id: null, run_start_utc: '2026-01-01T00:00:00Z' },
  export: { export_id: 'scale-export', export_start_utc: '2026-01-01T00:00:00Z', export_end_utc: endUtc,
    interval_seconds: 60, created_utc: endUtc }, rooms, devices, policies,
};
const header = 'run_id,building_id,scenario_id,interval_start_utc,interval_end_utc,interval_seconds,room_id,room_occupancy_avg,room_occupancy_max,room_occupied_fraction,room_temp_c,room_rh_pct,device_id,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_ref,partial,meta_run';
let server;

try {
  const portProbe = createServer();
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen);
    portProbe.listen(4001, '127.0.0.1', () => portProbe.close(resolveListen));
  });

  const output = createWriteStream(csvPath, { encoding: 'utf8' });
  const write = async (value) => { if (!output.write(value)) await once(output, 'drain'); };
  await write(`${header}\r\n`);
  let rows = [];
  const energyPerInterval = rounded(7 * 60 / 3_600_000);
  for (let minute = 0; minute < intervalCount; minute++) {
    const startMs = firstMs + minute * 60_000;
    const start = new Date(startMs).toISOString().replace('.000Z', 'Z');
    const end = new Date(startMs + 60_000).toISOString().replace('.000Z', 'Z');
    for (let index = 0; index < deviceCount; index++) {
      const item = devices[index];
      const roomId = item.room_id;
      const cells = ['scale-run', 'scale-office', 'original', start, end, 60, roomId, 0, 0, 0, 25, 50,
        item.device_id, 7, 7, energyPerInterval, rounded(energyPerInterval * (minute + 1)), '', '', 1, 1, 0, 0, 0,
        `${policies[index].policy_id}:1`, false, minute === 0 && index === 0 ? JSON.stringify(metadata) : ''];
      rows.push(rowText(cells));
      if (rows.length >= 8192) { await write(rows.join('')); rows = []; }
    }
  }
  if (rows.length) await write(rows.join(''));
  output.end();
  await once(output, 'close');
  const bytes = statSync(csvPath).size;

  server = spawn(process.execPath, ['dist/server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '4001', DATABASE_PATH: dbPath },
  });
  console.log(`scale_server_pid=${server.pid}`);
  server.stdout.setEncoding('utf8').on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.setEncoding('utf8').on('data', (chunk) => process.stderr.write(chunk));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Scale server exited early (${server.exitCode})`);
    try { const health = await fetch('http://127.0.0.1:4001/api/v1/health'); if (health.ok) { ready = true; break; } }
    catch { /* The server is still starting; retry within the bounded deadline. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!ready) throw new Error('Scale server did not become ready on port 4001');

  const form = new FormData();
  form.append('file', await openAsBlob(csvPath), 'month.csv');
  const started = performance.now();
  const response = await fetch('http://127.0.0.1:4001/api/v1/imports', { method: 'POST', body: form });
  const elapsedSeconds = (performance.now() - started) / 1000;
  const payload = await response.json();
  if (response.status !== 201) throw new Error(`Month-size import failed (${response.status}): ${JSON.stringify(payload).slice(0, 1000)}`);
  const datasetId = payload.data.dataset_id;
  const summaryResponse = await fetch(`http://127.0.0.1:4001/api/v1/imports/${datasetId}/summary`);
  const summary = await summaryResponse.json();
  const expected = energyPerInterval * rowCount;
  if (Math.abs(summary.data.energy_kwh - expected) > rowCount * 1e-9) throw new Error('Month-size total did not match generated readings');
  console.log(JSON.stringify({ status: response.status, file_bytes: bytes, device_interval_records: rowCount,
    room_interval_records: intervalCount * rooms.length, elapsed_seconds: Number(elapsedSeconds.toFixed(2)),
    energy_kwh: summary.data.energy_kwh, rss_bytes_harness: process.memoryUsage().rss,
    server_rss_bytes: null, server_memory_note: 'Not sampled by this portable Node script' }, null, 2));
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  rmSync(temp, { recursive: true, force: true });
}
