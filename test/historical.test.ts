import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuditorDatabase } from '../src/db/database.js';
import { validateAndFingerprint } from '../src/imports/validate.js';

const fixture = JSON.parse(readFileSync(new URL('../contracts/v1/fixtures/reference.json', import.meta.url), 'utf8')) as Record<string, unknown>;
function shiftUtc(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shiftUtc);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftUtc(item)]));
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
    return new Date(Date.parse(value) - 30_600_000).toISOString().replace('.000Z', 'Z');
  return value;
}

test('historical HTTP analytics reconcile persisted energy and disclose coverage, provenance and paging', async () => {
  const database = new AuditorDatabase(':memory:');
  const data = shiftUtc(structuredClone(fixture)) as Record<string, unknown>;
  const validated = validateAndFingerprint(data, 'json');
  const stored = database.storeDataset({ datasetId: 'analytics-fixture', sourceFormat: 'json', sourceResolutionSeconds: 60,
    semanticFingerprint: validated.semanticFingerprint, data: validated.data });
  assert.equal(stored.inserted, true);
  const initialTemplates = database.db.prepare('SELECT * FROM device_intervals WHERE dataset_id=? ORDER BY device_id,interval_start_utc').all('analytics-fixture') as Array<Record<string, string | number>>;
  const initialTemplateByDevice = new Map(initialTemplates.map((row) => [row.device_id, row]));
  const server = createApp(loadConfig({}), database).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP address');
  const base = `http://127.0.0.1:${address.port}/api/v1/imports/analytics-fixture`;
  try {
    database.db.prepare("UPDATE devices SET quantity=7 WHERE dataset_id=? AND device_id='fridge-b'").run('analytics-fixture');
    const referenceSeries = (await (await fetch(`${base}/timeseries?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z&bucket_seconds=60`)).json()) as { data: { items: Array<{ energy_kwh: number; coverage: { status: string; covered_device_count: number } }> } };
    assert.equal(referenceSeries.data.items[0]!.energy_kwh, 0.015);
    assert.equal(referenceSeries.data.items[0]!.coverage.status, 'complete');
    assert.equal(referenceSeries.data.items[0]!.coverage.covered_device_count, 2);
    const referenceDevices = (await (await fetch(`${base}/devices?from=2026-09-20T19:00:00Z&to=2026-09-20T19:02:00Z`)).json()) as { data: { items: Array<{ device_id: string; observed_energy_kwh: number }> } };
    assert.deepEqual(referenceDevices.data.items.map((item) => [item.device_id, item.observed_energy_kwh]), [['light-a', 0.02], ['fridge-b', 0.01]]);
    const referenceRooms = (await (await fetch(`${base}/rooms?from=2026-09-20T19:00:00Z&to=2026-09-20T19:02:00Z`)).json()) as { data: { items: Array<{ room_id: string; observed_energy_kwh: number }> } };
    assert.deepEqual(referenceRooms.data.items.map((item) => [item.room_id, item.observed_energy_kwh]), [['room-a', 0.02], ['room-b', 0.01]]);
    assert.equal(referenceDevices.data.items.reduce((sum, item) => sum + item.observed_energy_kwh, 0), 0.03);
    assert.equal(referenceRooms.data.items.reduce((sum, item) => sum + item.observed_energy_kwh, 0), 0.03);
    const localHour = (await (await fetch(`${base}/timeseries?from=2026-09-20T18:30:00Z&to=2026-09-20T19:30:00Z&bucket_seconds=3600`)).json()) as { data: { items: Array<{ start_utc: string; energy_kwh: number; coverage: { status: string; expected_seconds: number; covered_seconds: number } }> } };
    assert.equal(localHour.data.items[0]!.start_utc, '2026-09-20T18:30:00.000Z');
    assert.equal(localHour.data.items[0]!.energy_kwh, 0.03);
    assert.equal(localHour.data.items[0]!.coverage.status, 'partial');
    assert.equal(localHour.data.items[0]!.coverage.expected_seconds, 3_600 * 2);
    assert.equal(localHour.data.items[0]!.coverage.covered_seconds, 240);
    const referenceSummary = (await (await fetch(`${base}/summary`)).json()) as { data: { energy_kwh: number; cost_inr: number | null; tariff_inr_per_kwh: number | null } };
    assert.equal(referenceSummary.data.energy_kwh, 0.03);
    assert.equal(referenceSummary.data.cost_inr, null);
    assert.equal(referenceSummary.data.tariff_inr_per_kwh, null);
    await fetch(`${base}/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 10 }) });
    const referenceCost = (await (await fetch(`${base}/summary`)).json()) as { data: { energy_kwh: number; cost_inr: number; tariff_inr_per_kwh: number } };
    assert.equal(referenceCost.data.energy_kwh, 0.03);
    assert.equal(referenceCost.data.cost_inr, 0.3);
    assert.equal(referenceCost.data.tariff_inr_per_kwh, 10);
    await fetch(`${base}/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 0 }) });
    const zeroCost = (await (await fetch(`${base}/summary`)).json()) as { data: { cost_inr: number; tariff_inr_per_kwh: number } };
    assert.equal(zeroCost.data.cost_inr, 0);
    assert.equal(zeroCost.data.tariff_inr_per_kwh, 0);
    database.db.prepare("DELETE FROM device_intervals WHERE dataset_id=? AND (device_id='fridge-b' AND interval_start_utc=? OR interval_start_utc=?)")
      .run('analytics-fixture', '2026-09-20T19:00:00Z', '2026-09-20T19:01:00Z');
    const summaryResponse = await fetch(`${base}/summary`);
    const summary = (await summaryResponse.json()) as { data: Record<string, unknown> };
    assert.equal(summary.data.energy_kwh, 0.01);
    assert.deepEqual(summary.data.gaps, []);
    assert.equal((summary.data.gap_assessment as { status: string }).status, 'not_performed');
    assert.equal((summary.data.source_metadata as { synthetic: boolean }).synthetic, true);

    await fetch(`${base}/tariff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 10 }) });
    const timeResponse = await fetch(`${base}/timeseries?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z&bucket_seconds=60&page_size=1`);
    assert.equal(timeResponse.status, 200);
    const firstPage = (await timeResponse.json()) as { data: { full_period_observed_energy_kwh: number; full_period_complete: boolean; page_observed_energy_kwh: number; items: Array<{ energy_kwh: number | null; cost_inr: number | null; coverage: { status: string; expected_seconds: number; covered_seconds: number } }>; pagination: { total: number; total_pages: number } } };
    assert.equal(firstPage.data.full_period_observed_energy_kwh, 0.01);
    assert.equal(firstPage.data.full_period_complete, false);
    assert.equal(firstPage.data.page_observed_energy_kwh, 0.01);
    assert.deepEqual(firstPage.data.items[0], { start_utc: '2026-09-20T19:00:00.000Z', end_utc: '2026-09-20T19:01:00.000Z', energy_kwh: 0.01, cost_inr: 0.1,
      coverage: { status: 'partial', expected_seconds: 120, covered_seconds: 60, expected_device_count: 2, covered_device_count: 1, partial_source_intervals: 0 } });
    assert.deepEqual(firstPage.data.pagination, { page: 1, page_size: 1, total: 2, total_pages: 2 });
    const secondPage = (await (await fetch(`${base}/timeseries?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z&bucket_seconds=60&page=2&page_size=1`)).json()) as { data: { page_observed_energy_kwh: number | null; items: Array<{ energy_kwh: number | null; coverage: { status: string } }> } };
    assert.equal(secondPage.data.items[0]!.energy_kwh, null);
    assert.equal(secondPage.data.items[0]!.coverage.status, 'missing');
    assert.equal(secondPage.data.page_observed_energy_kwh, null);

    const devices = (await (await fetch(`${base}/devices?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z`)).json()) as { data: { items: Array<Record<string, unknown>> } };
    const fridge = devices.data.items.find((device) => device.device_id === 'fridge-b')!;
    assert.equal(fridge.quantity, 7);
    assert.equal(fridge.observed_energy_kwh, null);
    assert.equal(fridge.nominal_rated_power_w, 300);
    const light = devices.data.items.find((device) => device.device_id === 'light-a')!;
    assert.equal(light.observed_energy_kwh, 0.01);
    assert.equal(light.observed_cost_inr, 0.1);
    assert.equal(light.nominal_rated_power_w, 600);
    assert.equal(light.observed_average_power_w, 600);
    assert.equal(light.observed_peak_power_w, 600);
    const roomsFirst = (await (await fetch(`${base}/rooms?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z&page_size=1`)).json()) as { data: { items: Array<{ room_id: string; observed_energy_kwh: number | null }> } };
    const roomsSecond = (await (await fetch(`${base}/rooms?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z&page=2&page_size=1`)).json()) as { data: { items: Array<{ room_id: string; observed_energy_kwh: number | null }> } };
    assert.deepEqual(roomsFirst.data.items.map((room) => room.room_id), ['room-a']);
    assert.deepEqual(roomsSecond.data.items.map((room) => room.room_id), ['room-b']);
    assert.equal(roomsFirst.data.items[0]!.observed_energy_kwh, 0.01);
    assert.equal(roomsSecond.data.items[0]!.observed_energy_kwh, null);

    const weekdays = (await (await fetch(`${base}/weekday-analytics?from_utc=2026-09-20T19:00:00Z&to_utc=2026-09-20T19:02:00Z`)).json()) as { data: { weekdays: Array<{ weekday: string; observed_energy_total_kwh: number | null; complete_day_count: number; partial_day_count: number; mean_energy_per_complete_day_kwh: number | null }> } };
    const monday = weekdays.data.weekdays.find((day) => day.weekday === 'Monday')!;
    assert.equal(monday.observed_energy_total_kwh, 0.01);
    assert.equal(monday.complete_day_count, 0);
    assert.equal(monday.partial_day_count, 1);
    assert.equal(monday.mean_energy_per_complete_day_kwh, null);

    assert.equal(monday.weekday, 'Monday');
    const daily = (await (await fetch(`${base}/timeseries?from_utc=2026-09-20T18:30:00Z&to_utc=2026-09-21T18:30:00Z&bucket_seconds=86400`)).json()) as { data: { items: Array<{ start_utc: string; energy_kwh: number | null; coverage: { status: string; expected_seconds: number; covered_seconds: number } }> } };
    assert.equal(daily.data.items.length, 1);
    assert.equal(daily.data.items[0]!.start_utc, '2026-09-20T18:30:00.000Z');
    assert.equal(daily.data.items[0]!.coverage.status, 'partial');
    assert.equal(daily.data.items[0]!.coverage.expected_seconds, 86_400 * 2);
    assert.equal(daily.data.items[0]!.coverage.covered_seconds, 60);
    const misaligned = await fetch(`${base}/timeseries?from_utc=2026-09-20T19:00:30Z&to_utc=2026-09-20T19:02:00Z&bucket_seconds=60`);
    assert.equal(misaligned.status, 422);
    assert.equal(((await misaligned.json()) as { error: { code: string } }).error.code, 'UNSUPPORTED_INPUT');
    database.db.prepare("UPDATE device_intervals SET interval_end_utc=?,interval_seconds=90 WHERE dataset_id=? AND device_id='light-a' AND interval_start_utc=?")
      .run('2026-09-20T19:01:30Z', 'analytics-fixture', '2026-09-20T19:00:00Z');
    const crossing = await fetch(`${base}/timeseries?from_utc=2026-09-20T19:01:00Z&to_utc=2026-09-20T19:02:00Z&bucket_seconds=60`);
    assert.equal(crossing.status, 422);
    const crossingBody = (await crossing.json()) as { error: { code: string; message: string } };
    assert.equal(crossingBody.error.code, 'UNSUPPORTED_INPUT');
    assert.match(crossingBody.error.message, /crosses/);
    database.db.prepare('DELETE FROM device_intervals WHERE dataset_id=?').run('analytics-fixture');
    const noKnownReadings = (await (await fetch(`${base}/summary`)).json()) as { data: { energy_kwh: number | null; cost_inr: number | null; tariff_inr_per_kwh: number | null } };
    assert.equal(noKnownReadings.data.energy_kwh, null);
    assert.equal(noKnownReadings.data.cost_inr, null);
    assert.equal(noKnownReadings.data.tariff_inr_per_kwh, 10);

    const metadata = JSON.parse((database.db.prepare('SELECT source_metadata_json FROM datasets WHERE dataset_id=?').get('analytics-fixture') as { source_metadata_json: string }).source_metadata_json) as { export: Record<string, unknown> };
    metadata.export.export_start_utc = '2026-09-20T18:30:00Z';
    metadata.export.export_end_utc = '2026-09-28T18:30:00Z';
    database.transaction(() => {
      database.db.prepare('DELETE FROM device_intervals WHERE dataset_id=?').run('analytics-fixture');
      database.db.prepare('UPDATE datasets SET source_metadata_json=? WHERE dataset_id=?').run(JSON.stringify(metadata), 'analytics-fixture');
      const insert = database.db.prepare('INSERT INTO device_intervals(dataset_id,run_id,room_id,device_id,interval_start_utc,interval_end_utc,interval_seconds,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_id,policy_version,partial) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const dayStart of ['2026-09-20T18:30:00Z', '2026-09-21T18:30:00Z', '2026-09-27T18:30:00Z']) {
        const day = Date.parse(dayStart);
        for (let minute = 0; minute < 1_440; minute++) for (const deviceId of ['light-a', 'fridge-b']) {
          const start = new Date(day + minute * 60_000).toISOString().replace('.000Z', 'Z');
          const end = new Date(day + (minute + 1) * 60_000).toISOString().replace('.000Z', 'Z');
          const row = initialTemplateByDevice.get(deviceId)!;
          insert.run(row.dataset_id,row.run_id,row.room_id,row.device_id,start,end,row.interval_seconds,row.avg_power_w,row.max_power_w,row.energy_kwh,row.cumulative_kwh,row.avg_voltage_v,row.avg_current_a,row.power_factor,row.on_fraction,row.override_seconds,row.vacant_on_seconds,row.offschedule_on_seconds,row.policy_id,row.policy_version,row.partial);
        }
      }
    });
    database.db.prepare("UPDATE device_intervals SET partial=1 WHERE dataset_id=? AND device_id='light-a' AND interval_start_utc=?")
      .run('analytics-fixture', '2026-09-20T18:30:00Z');
    const flaggedPartial = (await (await fetch(`${base}/timeseries?from=2026-09-20T18:30:00Z&to=2026-09-20T18:31:00Z&bucket_seconds=60`)).json()) as { data: { items: Array<{ energy_kwh: number; coverage: { status: string; expected_seconds: number; covered_seconds: number; partial_source_intervals: number } }> } };
    assert.equal(flaggedPartial.data.items[0]!.energy_kwh, 0.015);
    assert.equal(flaggedPartial.data.items[0]!.coverage.status, 'partial');
    assert.equal(flaggedPartial.data.items[0]!.coverage.expected_seconds, 120);
    assert.equal(flaggedPartial.data.items[0]!.coverage.covered_seconds, 120);
    assert.equal(flaggedPartial.data.items[0]!.coverage.partial_source_intervals, 1);
    database.db.prepare("UPDATE device_intervals SET partial=0 WHERE dataset_id=? AND device_id='light-a' AND interval_start_utc=?")
      .run('analytics-fixture', '2026-09-20T18:30:00Z');
    const weekdayCounts = (await (await fetch(`${base}/weekday-analytics?from=2026-09-20T18:30:00Z&to=2026-09-28T18:30:00Z`)).json()) as { data: { weekdays: Array<{ weekday: string; observed_energy_total_kwh: number | null; complete_day_count: number; mean_energy_per_complete_day_kwh: number | null }> } };
    const twoMondays = weekdayCounts.data.weekdays.find((day) => day.weekday === 'Monday')!;
    const oneTuesday = weekdayCounts.data.weekdays.find((day) => day.weekday === 'Tuesday')!;
    assert.equal(twoMondays.complete_day_count, 2);
    assert.ok(Math.abs(twoMondays.observed_energy_total_kwh! - 43.2) < 1e-9);
    assert.ok(Math.abs(twoMondays.mean_energy_per_complete_day_kwh! - 21.6) < 1e-9);
    assert.equal(oneTuesday.complete_day_count, 1);
    assert.ok(Math.abs(oneTuesday.observed_energy_total_kwh! - 21.6) < 1e-9);
    assert.ok(Math.abs(oneTuesday.mean_energy_per_complete_day_kwh! - 21.6) < 1e-9);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});
