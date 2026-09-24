import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditorDatabase, type DatasetImport } from '../src/db/database.js';

const fixture = JSON.parse(readFileSync(new URL('../contracts/v1/fixtures/reference.json', import.meta.url), 'utf8')) as DatasetImport['data'];
const count = (db: AuditorDatabase, table: string): number =>
  (db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function input(datasetId = 'auditor-dataset-1', data = structuredClone(fixture), semanticFingerprint = 'fixture-semantic-v1'): DatasetImport {
  return { datasetId, sourceFormat: 'json', sourceResolutionSeconds: 60, semanticFingerprint,
    fileSha256: 'fixture-byte-sha', data };
}

test('SQLite persistence: migrations, atomic dataset storage, dataset scope, identity, tariff and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-auditor-db-'));
  const path = join(dir, 'test.sqlite');
  let db = new AuditorDatabase(path);
  try {
    assert.equal(count(db, 'migration_history'), 1);
    db.close();
    db = new AuditorDatabase(path);
    assert.equal(count(db, 'migration_history'), 1);
    assert.equal(count(db, 'datasets'), 0);
    assert.equal(count(db, 'rooms'), 0);

    const first = db.storeDataset(input());
    assert.deepEqual(first, { datasetId: 'auditor-dataset-1', inserted: true });
    assert.equal(count(db, 'datasets'), 1);
    assert.equal(count(db, 'buildings'), 1);
    assert.equal(count(db, 'rooms'), 2);
    assert.equal(count(db, 'devices'), 2);
    assert.equal(count(db, 'policy_versions'), 3);
    assert.equal(count(db, 'room_intervals'), 4);
    assert.equal(count(db, 'device_intervals'), 4);
    assert.equal((db.db.prepare('SELECT sum(energy_kwh) AS kwh FROM device_intervals').get() as { kwh: number }).kwh, 0.03);

    const broken = structuredClone(fixture);
    broken.devices[0]!.room_id = 'missing-room';
    assert.throws(() => db.storeDataset(input('rollback-dataset', broken, 'bad-import')));
    assert.equal(count(db, 'datasets'), 1);
    assert.equal(count(db, 'rooms'), 2);

    const other = structuredClone(fixture);
    other.run.run_id = 'run-fixture-002';
    other.export.export_id = 'export-fixture-002';
    const second = db.storeDataset(input('auditor-dataset-2', other, 'fixture-semantic-v2'));
    assert.equal(second.inserted, true);
    assert.equal(count(db, 'datasets'), 2);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM rooms WHERE room_id='room-a'").get() as { n: number }).n, 2);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM devices WHERE device_id='light-a'").get() as { n: number }).n, 2);

    assert.equal(db.storeDataset(input('ignored-new-id')).inserted, false);
    assert.equal(db.storeDataset(input('ignored-new-id')).datasetId, 'auditor-dataset-1');
    assert.equal(count(db, 'datasets'), 2);
    assert.throws(() => db.storeDataset(input('conflict-id', structuredClone(fixture), 'different-semantic-content')), /semantic content differs/);
    assert.equal(count(db, 'datasets'), 2);

    assert.throws(() => db.db.prepare(`INSERT INTO room_intervals(dataset_id, run_id, room_id, interval_start_utc, interval_end_utc,
      interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial)
      VALUES ('missing-dataset','run','room','a','b',60,0,0,0,0,0,0)`).run());

    const identityBefore = db.db.prepare('SELECT dataset_id, semantic_fingerprint FROM datasets WHERE dataset_id=?').get('auditor-dataset-1');
    const energyBefore = (db.db.prepare('SELECT sum(energy_kwh) AS kwh FROM device_intervals WHERE dataset_id=?').get('auditor-dataset-1') as { kwh: number }).kwh;
    db.setTariff('user-1', 7.5);
    db.setTariff('user-1', 9.25);
    const energyAfter = (db.db.prepare('SELECT sum(energy_kwh) AS kwh FROM device_intervals WHERE dataset_id=?').get('auditor-dataset-1') as { kwh: number }).kwh;
    assert.equal(energyAfter, energyBefore);
    assert.deepEqual(db.db.prepare('SELECT dataset_id, semantic_fingerprint FROM datasets WHERE dataset_id=?').get('auditor-dataset-1'), identityBefore);
    assert.equal((db.db.prepare("SELECT rate_per_kwh AS rate FROM user_tariff_settings WHERE user_id='user-1'").get() as { rate: number }).rate, 9.25);
  } finally {
    db.close();
  }

  db = new AuditorDatabase(path);
  try {
    assert.equal(count(db, 'datasets'), 2);
    assert.equal(count(db, 'device_intervals'), 8);
    assert.equal(count(db, 'user_tariff_settings'), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
