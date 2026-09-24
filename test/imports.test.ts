import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuditorDatabase } from '../src/db/database.js';
import { validateAndFingerprint } from '../src/imports/validate.js';

const jsonFixture = readFileSync(new URL('../contracts/v1/fixtures/reference.json', import.meta.url));
const csvFixture = readFileSync(new URL('../contracts/v1/fixtures/reference.csv', import.meta.url), 'utf8');
const forbiddenFilesBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('nexyra-auditor-upload-')));

function csvEncode(rows: string[][]): string {
  return `${rows.map((row) => row.map((value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\r\n')}\r\n`;
}

async function listen(database: AuditorDatabase, uploadMaxBytes?: number): Promise<{ base: string; close: () => Promise<void> }> {
  const config = loadConfig(uploadMaxBytes === undefined ? {} : { UPLOAD_MAX_BYTES: String(uploadMaxBytes) });
  const server = createApp(config, database).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function upload(base: string, content: string | Buffer, filename: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([content]), filename);
  return fetch(`${base}/api/v1/imports`, { method: 'POST', body: form });
}

function countDatasets(db: AuditorDatabase): number {
  return (db.db.prepare('SELECT count(*) AS n FROM datasets').get() as { n: number }).n;
}
function persistenceSnapshot(db: AuditorDatabase): Record<string, number> {
  return Object.fromEntries(['datasets', 'buildings', 'rooms', 'devices', 'policy_versions', 'room_intervals', 'device_intervals']
    .map((table) => [table, (db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

test('multipart JSON/CSV import, fingerprints, listing, summary, tariff and atomic validation failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-p006-'));
  const dbJson = new AuditorDatabase(join(dir, 'json.sqlite'));
  const dbCsv = new AuditorDatabase(join(dir, 'csv.sqlite'));
  const jsonServer = await listen(dbJson);
  const csvServer = await listen(dbCsv);
  try {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), jsonFixture]);
    const firstResponse = await upload(jsonServer.base, withBom, 'reference.json');
    assert.equal(firstResponse.status, 201);
    const first = (await firstResponse.json() as { data: { dataset_id: string; status: string; already_imported: boolean; report: { errors: unknown[] } } }).data;
    assert.equal(first.status, 'accepted');
    assert.equal(first.already_imported, false);
    assert.deepEqual(first.report.errors, []);
    assert.equal(countDatasets(dbJson), 1);
    const acceptedSnapshot = persistenceSnapshot(dbJson);

    const listed = await (await fetch(`${jsonServer.base}/api/v1/imports`)).json() as { data: Array<{ dataset_id: string; run_id: string; scenario_id: string; interval_seconds: number }> };
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]!.dataset_id, first.dataset_id);
    assert.equal(listed.data[0]!.run_id, 'run-fixture-001');
    assert.equal(listed.data[0]!.interval_seconds, 60);

    let summary = await (await fetch(`${jsonServer.base}/api/v1/imports/${first.dataset_id}/summary`)).json() as { data: { energy_kwh: number; cost_inr: number | null; tariff_inr_per_kwh: number | null; coverage: { device_intervals: number; room_intervals: number } } };
    assert.equal(summary.data.energy_kwh, 0.03);
    assert.equal(summary.data.cost_inr, null);
    assert.equal(summary.data.tariff_inr_per_kwh, null);
    assert.deepEqual(summary.data.coverage, { start_utc: '2026-09-21T03:30:00Z', end_utc: '2026-09-21T03:32:00Z', device_intervals: 4, room_intervals: 4 });

    const withDuplicates = JSON.parse(jsonFixture.toString('utf8')) as Record<string, unknown>;
    for (const key of ['room_intervals', 'device_intervals']) {
      const records = withDuplicates[key] as unknown[];
      records.push(structuredClone(records[0]));
    }
    const duplicateRecordsResponse = await upload(jsonServer.base, JSON.stringify(withDuplicates), 'duplicates.json');
    assert.equal(duplicateRecordsResponse.status, 200);
    const duplicateRecords = (await duplicateRecordsResponse.json() as { data: { dataset_id: string; report: { duplicates_deduped: number } } }).data;
    assert.equal(duplicateRecords.dataset_id, first.dataset_id);
    assert.equal(duplicateRecords.report.duplicates_deduped, 2);
    summary = await (await fetch(`${jsonServer.base}/api/v1/imports/${first.dataset_id}/summary`)).json() as typeof summary;
    assert.equal(summary.data.energy_kwh, 0.03);

    const csvFirst = await upload(csvServer.base, `\ufeff${csvFixture.replace(/\r?\n/g, '\r\n')}`, 'reference.csv');
    assert.equal(csvFirst.status, 201);
    const csvData = (await csvFirst.json() as { data: { dataset_id: string; status: string; report: { duplicates_deduped: number } } }).data;
    assert.equal(csvData.status, 'accepted');
    assert.equal(csvData.report.duplicates_deduped, 0);
    const csvSummary = await (await fetch(`${csvServer.base}/api/v1/imports/${csvData.dataset_id}/summary`)).json() as { data: { energy_kwh: number } };
    assert.equal(csvSummary.data.energy_kwh, 0.03);
    const csvThenJson = await upload(csvServer.base, jsonFixture, 'reference.json');
    assert.equal(csvThenJson.status, 200);
    const duplicate = (await csvThenJson.json() as { data: { dataset_id: string; status: string; already_imported: boolean } }).data;
    assert.equal(duplicate.dataset_id, csvData.dataset_id);
    assert.equal(duplicate.status, 'already_imported');
    assert.equal(duplicate.already_imported, true);
    assert.equal(countDatasets(dbCsv), 1);

    const original = JSON.parse(jsonFixture.toString('utf8')) as Record<string, unknown>;
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
      return value;
    };
    const reordered = reverseKeys(original) as Record<string, unknown>;
    for (const key of ['rooms', 'devices', 'policies', 'room_intervals', 'device_intervals']) (reordered[key] as unknown[]).reverse();
    assert.equal(validateAndFingerprint(reordered, 'json').semanticFingerprint,
      validateAndFingerprint(original, 'json').semanticFingerprint);
    const otherIdentity = structuredClone(original) as Record<string, unknown>;
    (otherIdentity.run as Record<string, unknown>).run_id = 'other-run';
    (otherIdentity.export as Record<string, unknown>).export_id = 'other-export';
    for (const key of ['room_intervals', 'device_intervals']) {
      for (const row of otherIdentity[key] as Array<Record<string, unknown>>) row.run_id = 'other-run';
    }
    assert.equal(validateAndFingerprint(otherIdentity, 'json').semanticFingerprint,
      validateAndFingerprint(original, 'json').semanticFingerprint);
    const annotationsOnly = structuredClone(original) as Record<string, unknown>;
    annotationsOnly.created_note = 'different note';
    (annotationsOnly.export as Record<string, unknown>).created_utc = '2026-09-22T00:00:00Z';
    assert.equal(validateAndFingerprint(annotationsOnly, 'json').semanticFingerprint,
      validateAndFingerprint(original, 'json').semanticFingerprint);

    const storedIdentity = dbJson.db.prepare('SELECT semantic_fingerprint FROM datasets WHERE dataset_id=?').get(first.dataset_id) as { semantic_fingerprint: string };
    const changed = structuredClone(original) as { rooms: Array<Record<string, unknown>> };
    changed.rooms[0]!.name = `${String(changed.rooms[0]!.name)} changed`;
    const conflict = await upload(jsonServer.base, JSON.stringify(changed), 'changed.json');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, 'CONFLICT');
    assert.deepEqual(persistenceSnapshot(dbJson), acceptedSnapshot);

    const parsedRows = parseCsvSync(csvFixture, { bom: true }) as string[][];
    const unknownDeviceCsv = structuredClone(parsedRows);
    unknownDeviceCsv[1]![12] = 'missing-device';
    const unknownCsv = await upload(jsonServer.base, csvEncode(unknownDeviceCsv), 'unknown-device.csv');
    assert.equal(unknownCsv.status, 422);
    const unknownCsvError = (await unknownCsv.json() as { error: { row: number; field: string } }).error;
    assert.equal(unknownCsvError.row, 2);
    assert.match(unknownCsvError.field, /device_id/);
    assert.equal(countDatasets(dbJson), 1);

    const missingEnvelope = structuredClone(parsedRows);
    missingEnvelope[1]![26] = '';
    const badMissing = await upload(jsonServer.base, csvEncode(missingEnvelope), 'missing.csv');
    assert.equal(badMissing.status, 422);
    assert.equal((await badMissing.json() as { error: { field: string; details: { errors: unknown[] } } }).error.field, 'meta_run');
    assert.deepEqual(persistenceSnapshot(dbJson), acceptedSnapshot);

    const missingRunEnvelope = structuredClone(parsedRows);
    const incompleteMetadata = JSON.parse(missingRunEnvelope[1]![26]!) as Record<string, unknown>;
    delete incompleteMetadata.run;
    missingRunEnvelope[1]![26] = JSON.stringify(incompleteMetadata);
    const badMetadata = await upload(jsonServer.base, csvEncode(missingRunEnvelope), 'missing-run.csv');
    assert.equal(badMetadata.status, 422);
    assert.equal((await badMetadata.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    assert.deepEqual(persistenceSnapshot(dbJson), acceptedSnapshot);

    const multipleEnvelope = structuredClone(parsedRows);
    multipleEnvelope[2]![26] = multipleEnvelope[1]![26]!;
    const badMultiple = await upload(jsonServer.base, csvEncode(multipleEnvelope), 'multiple.csv');
    assert.equal(badMultiple.status, 422);
    assert.deepEqual(persistenceSnapshot(dbJson), acceptedSnapshot);

    const conflictingRoom = structuredClone(parsedRows);
    const changedRoomRow = [...conflictingRoom[1]!];
    changedRoomRow[12] = 'fridge-b';
    changedRoomRow[24] = 'pol-fridge-b:1';
    changedRoomRow[7] = '99';
    conflictingRoom.splice(2, 0, changedRoomRow);
    const badRoom = await upload(jsonServer.base, csvEncode(conflictingRoom), 'conflicting-room.csv');
    assert.equal(badRoom.status, 422);
    assert.equal((await badRoom.json() as { error: { row: number } }).error.row, 3);
    assert.deepEqual(persistenceSnapshot(dbJson), acceptedSnapshot);

    const negativeVariants: Array<[string, (value: Record<string, unknown>) => void]> = [
      ['unknown-device.json', (value) => { const rows = value.device_intervals as Array<Record<string, unknown>>; rows[0]!.device_id = 'missing-device'; }],
      ['unknown-policy.json', (value) => { const rows = value.device_intervals as Array<Record<string, unknown>>; rows[0]!.policy_ref = 'missing-policy:1'; }],
      ['invalid-calendar.json', (value) => { const rows = value.device_intervals as Array<Record<string, unknown>>; rows[0]!.interval_start_utc = '2026-02-30T03:30:00Z'; }],
      ['bad-energy.json', (value) => { const rows = value.device_intervals as Array<Record<string, unknown>>; rows[0]!.energy_kwh = 0.5; }],
      ['fault-label.json', (value) => { value.is_fault = true; }],
      ['unsupported-version.json', (value) => { value.schema_version = '2.0.0'; }],
    ];
    for (const [filename, mutate] of negativeVariants) {
      const value = structuredClone(original);
      mutate(value);
      const response = await upload(jsonServer.base, JSON.stringify(value), filename);
      assert.equal(response.status, 422, filename);
      const error = (await response.json() as { error: { code: string; details: { errors: unknown[] } } }).error;
      assert.ok(['VALIDATION_ERROR', 'UNSUPPORTED_VERSION'].includes(error.code));
      assert.ok(error.details.errors.length > 0);
      assert.deepEqual(persistenceSnapshot(dbJson), acceptedSnapshot);
    }

    const tariffResponse = await fetch(`${jsonServer.base}/api/v1/imports/${first.dataset_id}/tariff`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: 10 }),
    });
    assert.equal(tariffResponse.status, 200);
    assert.deepEqual((await tariffResponse.json() as { data: unknown }).data, { dataset_id: first.dataset_id, inr_per_kwh: 10 });
    summary = await (await fetch(`${jsonServer.base}/api/v1/imports/${first.dataset_id}/summary`)).json() as typeof summary;
    assert.equal(summary.data.energy_kwh, 0.03);
    assert.equal(summary.data.tariff_inr_per_kwh, 10);
    assert.equal(summary.data.cost_inr, 0.3);
    assert.equal((dbJson.db.prepare('SELECT semantic_fingerprint FROM datasets WHERE dataset_id=?').get(first.dataset_id) as { semantic_fingerprint: string }).semantic_fingerprint, storedIdentity.semantic_fingerprint);

    const invalidTariff = await fetch(`${jsonServer.base}/api/v1/imports/${first.dataset_id}/tariff`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inr_per_kwh: -1 }),
    });
    assert.equal(invalidTariff.status, 422);
    assert.equal(countDatasets(dbJson), 1);
    assert.throws(() => validateAndFingerprint({ device_intervals: new Array(1_100_001), room_intervals: [] }, 'json'),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 413);
  } finally {
    await Promise.all([jsonServer.close(), csvServer.close()]);
    dbJson.close(); dbCsv.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('nexyra-auditor-upload-'))), forbiddenFilesBefore);
});

test('multipart upload byte limit returns 413 and leaves the database unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-p006-limit-'));
  const db = new AuditorDatabase(join(dir, 'limit.sqlite'));
  const server = await listen(db, 128);
  try {
    const response = await upload(server.base, Buffer.alloc(1024, 0x20), 'too-large.json');
    assert.equal(response.status, 413);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'REQUEST_TOO_LARGE');
    assert.equal(countDatasets(db), 0);

    const malformed = await upload(server.base, '{', 'malformed.json');
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');

    const multipleFiles = new FormData();
    multipleFiles.append('file', new Blob(['{}']), 'one.json');
    multipleFiles.append('file', new Blob(['{}']), 'two.json');
    const multipleResponse = await fetch(`${server.base}/api/v1/imports`, { method: 'POST', body: multipleFiles });
    assert.equal(multipleResponse.status, 413);
    assert.equal((await multipleResponse.json() as { error: { code: string } }).error.code, 'REQUEST_TOO_LARGE');
    assert.equal(countDatasets(db), 0);
  } finally {
    await server.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
