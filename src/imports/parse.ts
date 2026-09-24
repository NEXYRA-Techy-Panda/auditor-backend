import { closeSync, createReadStream, openSync, readFileSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import type { DatasetImport } from '../db/database.js';
import { ImportError, type ValidationIssue } from './errors.js';
import { Issues, canonicalJson } from './validate.js';

type Data = DatasetImport['data'];
type Row = Record<string, unknown>;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_CSV_ROWS = 900_000;
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

const HEADER = ['run_id', 'building_id', 'scenario_id', 'interval_start_utc', 'interval_end_utc', 'interval_seconds', 'room_id',
  'room_occupancy_avg', 'room_occupancy_max', 'room_occupied_fraction', 'room_temp_c', 'room_rh_pct', 'device_id', 'avg_power_w',
  'max_power_w', 'energy_kwh', 'cumulative_kwh', 'avg_voltage_v', 'avg_current_a', 'power_factor', 'on_fraction', 'override_seconds',
  'vacant_on_seconds', 'offschedule_on_seconds', 'policy_ref', 'partial', 'meta_run'];

export interface ParsedFile { data: unknown; sourceFormat: 'json' | 'csv'; sourceResolutionSeconds: number; duplicatesDeduped: number; }

function fileError(status: number, code: ImportError['code'], message: string, issue: Omit<ValidationIssue, 'message'>): ImportError {
  const detail: ValidationIssue = issue.row === undefined ? { field: issue.field, message } : { field: issue.field, message, row: issue.row };
  return new ImportError(status, code, message,
    { errors: [detail], warnings: [], duplicates_deduped: 0, additional_errors: false }, issue.field, issue.row);
}

function utf8Guard(): Transform {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { decoder.decode(chunk, { stream: true }); callback(null, chunk); }
      catch { callback(fileError(400, 'VALIDATION_ERROR', 'Upload must be valid UTF-8', { field: 'file' })); }
    },
    flush(callback) {
      try { decoder.decode(); callback(); }
      catch { callback(fileError(400, 'VALIDATION_ERROR', 'Upload ends with invalid UTF-8', { field: 'file' })); }
    },
  });
}

function numberCell(row: string[], index: number, field: string, record: number, optional = false): number | undefined {
  const raw = row[index] ?? '';
  if (optional && raw === '') return undefined;
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
    throw fileError(422, 'VALIDATION_ERROR', 'CSV contains an invalid numeric field', { field, row: record });
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw fileError(422, 'VALIDATION_ERROR', 'CSV numeric values must be finite', { field, row: record });
  return value;
}

function boolCell(row: string[], index: number, field: string, record: number): boolean {
  if (row[index] === 'true') return true;
  if (row[index] === 'false') return false;
  throw fileError(422, 'VALIDATION_ERROR', 'CSV booleans must be lowercase true or false', { field, row: record });
}

function metadata(raw: string, record: number): Data {
  if (!raw) throw fileError(422, 'VALIDATION_ERROR', 'CSV must contain one metadata envelope on its first data row', { field: 'meta_run', row: record });
  if (Buffer.byteLength(raw, 'utf8') > MAX_METADATA_BYTES) throw new ImportError(413, 'REQUEST_TOO_LARGE', 'CSV metadata envelope exceeds 8 MiB',
    { errors: [{ field: 'meta_run', message: 'Metadata envelope exceeds 8 MiB', row: record }], warnings: [], duplicates_deduped: 0, additional_errors: false }, 'meta_run', record);
  let envelope: unknown;
  try { envelope = JSON.parse(raw); }
  catch { throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope is not valid JSON', { field: 'meta_run', row: record }); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope must be a JSON object', { field: 'meta_run', row: record });
  const root = envelope as Row;
  const run = root.run as Row | undefined; const building = root.building as Row | undefined; const exported = root.export as Row | undefined;
  if (!run || typeof run !== 'object' || typeof run.run_id !== 'string' || typeof run.scenario_id !== 'string') {
    throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope is missing required run identity', { field: 'meta_run', row: record });
  }
  if (!building || typeof building !== 'object' || typeof building.building_id !== 'string') {
    throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope is missing required building identity', { field: 'meta_run', row: record });
  }
  if (!exported || typeof exported !== 'object' || typeof exported.interval_seconds !== 'number') {
    throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope is missing export resolution', { field: 'meta_run', row: record });
  }
  return { ...(envelope as Data), room_intervals: [], device_intervals: [] };
}

function text(row: string[], index: number): string { return row[index] ?? ''; }
function sourceRow<T extends Row>(row: T, recordNo: number): T {
  Object.defineProperty(row, '__source_row', { value: recordNo, enumerable: false });
  return row;
}

export async function parseCsv(path: string): Promise<ParsedFile> {
  const parser = parse({ bom: true, max_record_size: MAX_RECORD_BYTES });
  const done = pipeline(createReadStream(path), utf8Guard(), parser);
  let recordNo = 0; let dataRows = 0; let data: Data | undefined;
  const roomRecords = new Map<string, Row>();
  const issues = new Issues();
  let duplicates = 0;
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      recordNo++;
      if (recordNo === 1) {
        if (record.length !== HEADER.length || record.some((value, i) => value !== HEADER[i])) {
          throw fileError(422, 'VALIDATION_ERROR', 'CSV header does not match contract 1.0.1', { field: 'header', row: 1 });
        }
        continue;
      }
      dataRows++;
      if (dataRows > MAX_CSV_ROWS) throw new ImportError(413, 'REQUEST_TOO_LARGE', `CSV exceeds ${MAX_CSV_ROWS.toLocaleString()} data rows`,
        { errors: [], warnings: [], duplicates_deduped: duplicates, additional_errors: false });
      if (record.length !== HEADER.length) throw fileError(422, 'VALIDATION_ERROR', 'CSV row does not have 27 fields', { field: 'row', row: recordNo });
      const meta = text(record, 26);
      if (dataRows === 1) data = metadata(meta, recordNo);
      else if (meta !== '') throw fileError(422, 'VALIDATION_ERROR', 'meta_run must be empty after the first data row', { field: 'meta_run', row: recordNo });
      if (!data) throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope is missing', { field: 'meta_run', row: recordNo });

      if (text(record, 0) !== data.run.run_id) throw fileError(422, 'VALIDATION_ERROR', 'run_id differs from the metadata envelope', { field: 'run_id', row: recordNo });
      if (text(record, 1) !== data.building.building_id) throw fileError(422, 'VALIDATION_ERROR', 'building_id differs from the metadata envelope', { field: 'building_id', row: recordNo });
      if (text(record, 2) !== data.run.scenario_id) throw fileError(422, 'VALIDATION_ERROR', 'scenario_id differs from the metadata envelope', { field: 'scenario_id', row: recordNo });

      const intervalStart = text(record, 3); const intervalEnd = text(record, 4);
      const intervalSeconds = numberCell(record, 5, 'interval_seconds', recordNo)!;
      const roomId = text(record, 6);
      const room: Row = sourceRow({
        run_id: text(record, 0), room_id: roomId, interval_start_utc: intervalStart, interval_end_utc: intervalEnd,
        interval_seconds: intervalSeconds, occupancy_avg: numberCell(record, 7, 'room_occupancy_avg', recordNo)!,
        occupancy_max: numberCell(record, 8, 'room_occupancy_max', recordNo)!, occupied_fraction: numberCell(record, 9, 'room_occupied_fraction', recordNo)!,
        avg_temp_c: numberCell(record, 10, 'room_temp_c', recordNo)!, avg_rh_pct: numberCell(record, 11, 'room_rh_pct', recordNo)!,
        partial: boolCell(record, 25, 'partial', recordNo),
      }, recordNo);
      const roomKey = `${room.run_id}\u0000${room.room_id}\u0000${room.interval_start_utc}`;
      const previousRoom = roomRecords.get(roomKey);
      if (previousRoom) {
        if (canonicalJson(previousRoom) !== canonicalJson(room)) issues.add(`room_intervals.${roomId}`, 'Conflicting repeated room readings', recordNo);
        else duplicates++;
      } else roomRecords.set(roomKey, room);

      const device: Row = sourceRow({
        run_id: text(record, 0), room_id: roomId, device_id: text(record, 12),
        interval_start_utc: intervalStart, interval_end_utc: intervalEnd, interval_seconds: intervalSeconds,
        avg_power_w: numberCell(record, 13, 'avg_power_w', recordNo)!, max_power_w: numberCell(record, 14, 'max_power_w', recordNo)!,
        energy_kwh: numberCell(record, 15, 'energy_kwh', recordNo)!, cumulative_kwh: numberCell(record, 16, 'cumulative_kwh', recordNo)!,
        power_factor: numberCell(record, 19, 'power_factor', recordNo)!, on_fraction: numberCell(record, 20, 'on_fraction', recordNo)!,
        override_seconds: numberCell(record, 21, 'override_seconds', recordNo)!, vacant_on_seconds: numberCell(record, 22, 'vacant_on_seconds', recordNo)!,
        offschedule_on_seconds: numberCell(record, 23, 'offschedule_on_seconds', recordNo)!, policy_ref: text(record, 24),
        partial: boolCell(record, 25, 'partial', recordNo),
      }, recordNo);
      const voltage = numberCell(record, 17, 'avg_voltage_v', recordNo, true);
      const current = numberCell(record, 18, 'avg_current_a', recordNo, true);
      if (voltage !== undefined) device.avg_voltage_v = voltage;
      if (current !== undefined) device.avg_current_a = current;
      data.device_intervals.push(device);
    }
    await done;
  } catch (error) {
    parser.destroy(error instanceof Error ? error : new Error('CSV import aborted'));
    await done.catch(() => undefined);
    if (error instanceof ImportError) throw error;
    throw fileError(400, 'VALIDATION_ERROR', 'CSV could not be parsed as valid UTF-8 RFC 4180 data', recordNo ? { field: 'file', row: recordNo } : { field: 'file' });
  }
  if (!data) throw fileError(422, 'VALIDATION_ERROR', 'CSV metadata envelope is missing', { field: 'meta_run', row: 2 });
  issues.throwIfAny(duplicates);
  data.room_intervals = [...roomRecords.values()];
  return { data, sourceFormat: 'csv', sourceResolutionSeconds: Number(data.export.interval_seconds), duplicatesDeduped: duplicates };
}

export async function parseJson(path: string): Promise<ParsedFile> {
  let content: string;
  try {
    const bytes = readFileSync(path);
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0));
  } catch {
    throw fileError(400, 'VALIDATION_ERROR', 'JSON upload must be valid UTF-8', { field: 'file' });
  }
  let data: unknown;
  try { data = JSON.parse(content); }
  catch { throw fileError(400, 'VALIDATION_ERROR', 'Upload is not valid JSON', { field: 'file' }); }
  const root = data as Row;
  const exp = root?.export as Row | undefined;
  if (!exp || typeof exp.interval_seconds !== 'number') throw fileError(422, 'VALIDATION_ERROR', 'JSON export metadata is missing', { field: 'export.interval_seconds' });
  return { data, sourceFormat: 'json', sourceResolutionSeconds: exp.interval_seconds, duplicatesDeduped: 0 };
}

export function sniffFormat(path: string, originalName: string): 'csv' | 'json' {
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  const fd = openSync(path, 'r');
  const bytes = Buffer.alloc(512);
  let bytesRead: number;
  try { bytesRead = readSync(fd, bytes, 0, bytes.length, 0); }
  finally { closeSync(fd); }
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytesRead && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i]!)) i++;
  if (bytes[i] === 0x7b) return 'json';
  if (bytes[i] !== undefined) return 'csv';
  throw fileError(400, 'VALIDATION_ERROR', 'Upload is empty or unsupported', { field: 'file' });
}
