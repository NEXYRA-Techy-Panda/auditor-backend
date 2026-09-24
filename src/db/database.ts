import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { migrate } from './migrations.js';

type JsonRecord = Record<string, unknown>;
export interface DatasetImport {
  datasetId: string;
  sourceFormat: 'json' | 'csv';
  sourceResolutionSeconds: number;
  semanticFingerprint: string;
  fileSha256?: string;
  sourceMetadata?: JsonRecord;
  data: JsonRecord & {
    schema_version: string; source: string; synthetic: boolean; synthetic_label?: string;
    building: JsonRecord; run: JsonRecord; export: JsonRecord;
    rooms: JsonRecord[]; devices: JsonRecord[]; policies: JsonRecord[];
    room_intervals: JsonRecord[]; device_intervals: JsonRecord[];
  };
}
export interface AnalysisJobInput { jobId: string; datasetId: string; status: 'queued' | 'running' | 'completed' | 'failed'; request: JsonRecord; }
export interface FindingInput { findingId: string; jobId: string; datasetId: string; scopeType: string; scopeId?: string; findingType: string; severity: string; details: JsonRecord; }
export interface ForecastInput {
  forecastId: string; jobId: string; datasetId: string; targetStartUtc: string; targetEndUtc: string;
  energyKwh: number; assumptions: JsonRecord; tariff?: { userId: string; ratePerKwh: number; currency: string; costAmount: number };
}
export interface ComparisonInput { comparisonId: string; originalDatasetId: string; improvedDatasetId: string; assumptions: JsonRecord; }
export interface AnalysisDatasetMeta {
  dataset_id: string; run_id: string; synthetic: boolean; synthetic_label: string | null;
  timezone: string; start_utc: string; end_utc: string; interval_seconds: number;
}
export interface AnalysisRoomMeta { room_id: string; name: string; capacity: number; room_type: string; floor_area_m2: number | null; }
export interface AnalysisDeviceMeta {
  device_id: string; name: string; room_id: string; device_type: string; always_on: boolean;
  quantity: number; nominal_power_w: number; standby_power_w: number | null; power_factor: number;
  control: string; controls: string[];
}
export interface AnalysisPolicyMeta {
  policy_id: string; version: number; kind: string; rules: JsonRecord; applies_to: string; effective_from_utc: string;
}
export interface StoredAnalysisInterval extends JsonRecord {
  run_id?: string; room_id: string; device_id?: string; policy_id?: string; policy_version?: number;
  interval_start_utc: string; interval_end_utc: string; interval_seconds: number; partial: boolean | number;
  avg_power_w?: number; energy_kwh?: number; vacant_on_seconds?: number; offschedule_on_seconds?: number;
  override_seconds?: number | null; max_power_w?: number | null; cumulative_kwh?: number | null;
  avg_voltage_v?: number | null; avg_current_a?: number | null; power_factor?: number | null; on_fraction?: number | null;
  occupancy_avg?: number; occupancy_max?: number; occupied_fraction?: number; avg_temp_c?: number | null; avg_rh_pct?: number | null;
}
export interface AnalysisJobRecord {
  job_id: string; dataset_id: string; status: 'queued' | 'running' | 'completed' | 'failed';
  request: JsonRecord; method: string | null; method_version: string | null;
  requested_start_utc: string | null; requested_end_utc: string | null;
  actual_start_utc: string | null; actual_end_utc: string | null;
  batch_completed: number; batch_total: number; progress: JsonRecord;
  result: JsonRecord | null; error_code: string | null; error_message: string | null;
  created_at: string; completed_at: string | null;
}
export interface DatasetListItem {
  dataset_id: string; run_id: string; scenario_id: string; interval_seconds: number; imported_utc: string;
}
export interface DatasetSummary {
  dataset_id: string; energy_kwh: number; cost_inr: number | null; tariff_inr_per_kwh: number | null;
  synthetic: boolean; synthetic_label: string | null;
  coverage: { start_utc: string; end_utc: string; device_intervals: number; room_intervals: number };
  gaps: [];
}

const str = (row: JsonRecord, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`Expected ${key} to be a string`);
  return value;
};
const num = (row: JsonRecord, key: string): number => {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Expected ${key} to be a finite number`);
  return value;
};
const bool = (row: JsonRecord, key: string): number => row[key] === true ? 1 : row[key] === false ? 0 : (() => { throw new TypeError(`Expected ${key} to be a boolean`); })();
const optionalNum = (row: JsonRecord, key: string): number | null => row[key] === undefined ? null : num(row, key);

export class AuditorDatabase {
  readonly path: string;
  private readonly connection: InstanceType<typeof BetterSqlite3>;
  private closed = false;

  constructor(path: string, busyTimeoutMs = 5000) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.connection = new BetterSqlite3(this.path);
    this.connection.pragma('foreign_keys = ON');
    this.connection.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    this.connection.pragma(`journal_mode = ${this.path === ':memory:' ? 'MEMORY' : 'WAL'}`);
    try { migrate(this.connection); } catch (error) { this.connection.close(); throw error; }
  }

  get db(): BetterSqlite3.Database { return this.connection; }

  transaction<T>(work: () => T): T {
    if (this.closed) throw new Error('Database is closed');
    return this.connection.transaction(work)();
  }

  storeDataset(input: DatasetImport): { datasetId: string; inserted: boolean } {
    if (!input.semanticFingerprint.trim()) throw new TypeError('semanticFingerprint must be non-empty');
    if (!input.datasetId.trim()) throw new TypeError('datasetId must be non-empty');
    const data = input.data;
    return this.transaction(() => {
      const existing = this.connection.prepare(`SELECT dataset_id, semantic_fingerprint FROM datasets
        WHERE source = ? AND simulator_run_id = ? AND export_id = ?`)
        .get(str(data, 'source'), str(data.run, 'run_id'), str(data.export, 'export_id')) as
        { dataset_id: string; semantic_fingerprint: string } | undefined;
      if (existing) {
        if (existing.semantic_fingerprint !== input.semanticFingerprint) {
          throw new Error('Export identity conflict: semantic content differs from the stored dataset');
        }
        return { datasetId: existing.dataset_id, inserted: false };
      }
      this.connection.prepare(`INSERT INTO datasets (
        dataset_id, source, source_format, source_resolution_seconds, timezone, synthetic, synthetic_label,
        building_id, building_name, simulator_run_id, export_id, semantic_fingerprint, file_sha256, source_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.datasetId, str(data, 'source'), input.sourceFormat, input.sourceResolutionSeconds,
        str(data.building, 'timezone'), bool(data, 'synthetic'), data.synthetic_label ?? null,
        str(data.building, 'building_id'), str(data.building, 'name'), str(data.run, 'run_id'),
        str(data.export, 'export_id'), input.semanticFingerprint, input.fileSha256 ?? null,
        JSON.stringify(input.sourceMetadata ?? { schema_version: data.schema_version, source: data.source,
          synthetic: data.synthetic, synthetic_label: data.synthetic_label ?? null, created_note: data.created_note ?? null,
          run: data.run, export: data.export }),
      );
      this.connection.prepare('INSERT INTO buildings(dataset_id, building_id, name, timezone) VALUES (?, ?, ?, ?)')
        .run(input.datasetId, str(data.building, 'building_id'), str(data.building, 'name'), str(data.building, 'timezone'));
      const room = this.connection.prepare(`INSERT INTO rooms(dataset_id, room_id, name, room_type, capacity, floor_area_m2)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const row of data.rooms) room.run(input.datasetId, str(row, 'room_id'), str(row, 'name'), str(row, 'room_type'), num(row, 'capacity'), optionalNum(row, 'floor_area_m2'));
      const device = this.connection.prepare(`INSERT INTO devices(dataset_id, device_id, room_id, name, device_type, quantity,
        nominal_power_w, standby_power_w, power_factor, always_on, control, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of data.devices) device.run(input.datasetId, str(row, 'device_id'), str(row, 'room_id'), str(row, 'name'), str(row, 'device_type'), num(row, 'quantity'), num(row, 'nominal_power_w'), optionalNum(row, 'standby_power_w'), num(row, 'power_factor'), bool(row, 'always_on'), str(row, 'control'), JSON.stringify(row));
      const policy = this.connection.prepare(`INSERT INTO policy_versions(dataset_id, policy_id, version, applies_to, kind, effective_from_utc, rules_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const row of data.policies) policy.run(input.datasetId, str(row, 'policy_id'), num(row, 'version'), str(row, 'applies_to'), str(row, 'kind'), str(row, 'effective_from_utc'), JSON.stringify(row.rules));
      const roomInterval = this.connection.prepare(`INSERT INTO room_intervals(dataset_id, run_id, room_id, interval_start_utc, interval_end_utc,
        interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of data.room_intervals) roomInterval.run(input.datasetId, str(row, 'run_id'), str(row, 'room_id'), str(row, 'interval_start_utc'), str(row, 'interval_end_utc'), num(row, 'interval_seconds'), num(row, 'occupancy_avg'), num(row, 'occupancy_max'), num(row, 'occupied_fraction'), num(row, 'avg_temp_c'), num(row, 'avg_rh_pct'), bool(row, 'partial'));
      const deviceInterval = this.connection.prepare(`INSERT INTO device_intervals(dataset_id, run_id, room_id, device_id, interval_start_utc,
        interval_end_utc, interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a,
        power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds, policy_id, policy_version, partial)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of data.device_intervals) {
        const [policyId, version] = str(row, 'policy_ref').split(':');
        deviceInterval.run(input.datasetId, str(row, 'run_id'), str(row, 'room_id'), str(row, 'device_id'), str(row, 'interval_start_utc'), str(row, 'interval_end_utc'), num(row, 'interval_seconds'), num(row, 'avg_power_w'), num(row, 'max_power_w'), num(row, 'energy_kwh'), num(row, 'cumulative_kwh'), optionalNum(row, 'avg_voltage_v'), optionalNum(row, 'avg_current_a'), num(row, 'power_factor'), num(row, 'on_fraction'), num(row, 'override_seconds'), num(row, 'vacant_on_seconds'), num(row, 'offschedule_on_seconds'), policyId, Number(version), bool(row, 'partial'));
      }
      return { datasetId: input.datasetId, inserted: true };
    });
  }

  setTariff(userId: string, ratePerKwh: number, currency = 'INR'): void {
    this.connection.prepare(`INSERT INTO user_tariff_settings(user_id, currency, rate_per_kwh) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET currency=excluded.currency, rate_per_kwh=excluded.rate_per_kwh,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(userId, currency, ratePerKwh);
  }

  hasDataset(datasetId: string): boolean {
    return Boolean(this.connection.prepare('SELECT 1 FROM datasets WHERE dataset_id=?').get(datasetId));
  }

  listDatasets(): DatasetListItem[] {
    return this.connection.prepare(`SELECT dataset_id,
      json_extract(source_metadata_json,'$.run.run_id') AS run_id,
      json_extract(source_metadata_json,'$.run.scenario_id') AS scenario_id,
      source_resolution_seconds AS interval_seconds, imported_at AS imported_utc
      FROM datasets ORDER BY imported_at DESC, dataset_id`).all() as DatasetListItem[];
  }

  listDatasetsPage(page: number, pageSize: number): { items: DatasetListItem[]; total: number } {
    const total = (this.connection.prepare('SELECT count(*) AS count FROM datasets').get() as { count: number }).count;
    const items = this.connection.prepare(`SELECT dataset_id,
      json_extract(source_metadata_json,'$.run.run_id') AS run_id,
      json_extract(source_metadata_json,'$.run.scenario_id') AS scenario_id,
      source_resolution_seconds AS interval_seconds, imported_at AS imported_utc
      FROM datasets ORDER BY imported_at DESC, dataset_id LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as DatasetListItem[];
    return { items, total };
  }

  getDatasetSummary(datasetId: string, userId = 'local'): DatasetSummary | undefined {
    const dataset = this.connection.prepare(`SELECT dataset_id,synthetic,synthetic_label,
      json_extract(source_metadata_json,'$.export.export_start_utc') AS start_utc,
      json_extract(source_metadata_json,'$.export.export_end_utc') AS end_utc
      FROM datasets WHERE dataset_id=?`).get(datasetId) as
      { dataset_id: string; synthetic: number; synthetic_label: string | null; start_utc: string; end_utc: string } | undefined;
    if (!dataset) return undefined;
    const energy = (this.connection.prepare('SELECT coalesce(sum(energy_kwh),0) AS value FROM device_intervals WHERE dataset_id=?').get(datasetId) as { value: number }).value;
    const rate = this.connection.prepare('SELECT rate_per_kwh AS value FROM user_tariff_settings WHERE user_id=?').get(userId) as { value: number } | undefined;
    const deviceIntervals = (this.connection.prepare('SELECT count(*) AS value FROM device_intervals WHERE dataset_id=?').get(datasetId) as { value: number }).value;
    const roomIntervals = (this.connection.prepare('SELECT count(*) AS value FROM room_intervals WHERE dataset_id=?').get(datasetId) as { value: number }).value;
    return {
      dataset_id: dataset.dataset_id, energy_kwh: energy,
      cost_inr: rate ? energy * rate.value : null, tariff_inr_per_kwh: rate?.value ?? null,
      synthetic: dataset.synthetic === 1, synthetic_label: dataset.synthetic_label,
      coverage: { start_utc: dataset.start_utc, end_utc: dataset.end_utc, device_intervals: deviceIntervals, room_intervals: roomIntervals },
      gaps: [],
    };
  }

  getAnalysisDatasetMeta(datasetId: string): AnalysisDatasetMeta | undefined {
    const row = this.connection.prepare(`SELECT d.dataset_id, json_extract(d.source_metadata_json,'$.run.run_id') AS run_id,
      d.synthetic, d.synthetic_label, d.timezone,
      json_extract(d.source_metadata_json,'$.export.export_start_utc') AS start_utc,
      json_extract(d.source_metadata_json,'$.export.export_end_utc') AS end_utc,
      d.source_resolution_seconds AS interval_seconds
      FROM datasets d WHERE d.dataset_id=?`).get(datasetId) as (Omit<AnalysisDatasetMeta, 'synthetic'> & { synthetic: number }) | undefined;
    return row ? { ...row, synthetic: row.synthetic === 1 } : undefined;
  }

  getAnalysisRooms(datasetId: string, roomIds: string[]): AnalysisRoomMeta[] {
    if (roomIds.length === 0) return [];
    const marks = roomIds.map(() => '?').join(',');
    return this.connection.prepare(`SELECT room_id,name,capacity,room_type,floor_area_m2 FROM rooms
      WHERE dataset_id=? AND room_id IN (${marks}) ORDER BY room_id`).all(datasetId, ...roomIds) as AnalysisRoomMeta[];
  }

  getAnalysisDevices(datasetId: string, deviceIds: string[]): AnalysisDeviceMeta[] {
    if (deviceIds.length === 0) return [];
    const marks = deviceIds.map(() => '?').join(',');
    const rows = this.connection.prepare(`SELECT device_id,name,room_id,device_type,always_on,quantity,nominal_power_w,
      standby_power_w,power_factor,control,metadata_json FROM devices
      WHERE dataset_id=? AND device_id IN (${marks}) ORDER BY room_id,device_id`).all(datasetId, ...deviceIds) as
      (Omit<AnalysisDeviceMeta, 'always_on' | 'controls'> & { always_on: number; metadata_json: string })[];
    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata_json) as JsonRecord;
      return { ...row, always_on: row.always_on === 1, controls: Array.isArray(metadata.controls) ? metadata.controls as string[] : [] };
    });
  }

  getAnalysisPolicies(datasetId: string, refs: Array<{ id: string; version: number }>): AnalysisPolicyMeta[] {
    if (refs.length === 0) return [];
    const conditions = refs.map(() => '(policy_id=? AND version=?)').join(' OR ');
    const params = refs.flatMap((ref) => [ref.id, ref.version]);
    const rows = this.connection.prepare(`SELECT policy_id,version,kind,rules_json,applies_to,effective_from_utc
      FROM policy_versions WHERE dataset_id=? AND (${conditions}) ORDER BY policy_id,version`)
      .all(datasetId, ...params) as (Omit<AnalysisPolicyMeta, 'rules'> & { rules_json: string })[];
    return rows.map(({ rules_json, ...row }) => ({ ...row, rules: JSON.parse(rules_json) as JsonRecord }));
  }

  getAnalysisDeviceIds(datasetId: string, fromUtc: string, toUtc: string): Array<{ device_id: string; room_id: string }> {
    return this.connection.prepare(`SELECT DISTINCT di.device_id,di.room_id FROM device_intervals di
      WHERE di.dataset_id=? AND di.interval_start_utc>=? AND di.interval_end_utc<=? ORDER BY di.room_id,di.device_id`)
      .all(datasetId, fromUtc, toUtc) as Array<{ device_id: string; room_id: string }>;
  }

  getAnalysisDeviceStarts(datasetId: string, deviceId: string, fromUtc: string, toUtc: string): string[] {
    return (this.connection.prepare(`SELECT interval_start_utc FROM device_intervals WHERE dataset_id=? AND device_id=?
      AND interval_start_utc>=? AND interval_start_utc<? ORDER BY interval_start_utc`)
      .all(datasetId, deviceId, fromUtc, toUtc) as Array<{ interval_start_utc: string }>).map((row) => row.interval_start_utc);
  }

  getAnalysisDeviceIntervalAt(datasetId: string, deviceId: string, startUtc: string): StoredAnalysisInterval | undefined {
    return this.connection.prepare(`SELECT run_id,room_id,device_id,interval_start_utc,interval_end_utc,interval_seconds,
      avg_power_w,energy_kwh,vacant_on_seconds,offschedule_on_seconds,policy_id,policy_version,override_seconds,
      max_power_w,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,partial
      FROM device_intervals WHERE dataset_id=? AND device_id=? AND interval_start_utc=?`)
      .get(datasetId, deviceId, startUtc) as StoredAnalysisInterval | undefined;
  }

  getAnalysisCoverage(datasetId: string, fromUtc: string, toUtc: string): { device_intervals: number; room_intervals: number; start_utc: string | null; end_utc: string | null } {
    const row = this.connection.prepare(`SELECT count(*) AS device_intervals,min(interval_start_utc) AS start_utc,max(interval_end_utc) AS end_utc
      FROM device_intervals WHERE dataset_id=? AND interval_start_utc>=? AND interval_end_utc<=?`)
      .get(datasetId, fromUtc, toUtc) as { device_intervals: number; start_utc: string | null; end_utc: string | null };
    const rooms = (this.connection.prepare(`SELECT count(*) AS count FROM room_intervals
      WHERE dataset_id=? AND interval_start_utc>=? AND interval_end_utc<=?`).get(datasetId, fromUtc, toUtc) as { count: number }).count;
    return { ...row, room_intervals: rooms };
  }

  getAnalysisEnergy(datasetId: string, fromUtc: string, toUtc: string): number {
    return (this.connection.prepare(`SELECT coalesce(sum(energy_kwh),0) AS energy FROM device_intervals
      WHERE dataset_id=? AND interval_start_utc>=? AND interval_end_utc<=?`).get(datasetId, fromUtc, toUtc) as { energy: number }).energy;
  }

  getAnalysisDeviceIntervals(datasetId: string, deviceId: string, fromUtc: string, toUtc: string): StoredAnalysisInterval[] {
    return this.connection.prepare(`SELECT run_id,room_id,device_id,interval_start_utc,interval_end_utc,interval_seconds,
      avg_power_w,energy_kwh,vacant_on_seconds,offschedule_on_seconds,policy_id,policy_version,override_seconds,
      max_power_w,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,partial
      FROM device_intervals WHERE dataset_id=? AND device_id=? AND interval_start_utc>=? AND interval_start_utc<?
      ORDER BY interval_start_utc`).all(datasetId, deviceId, fromUtc, toUtc) as StoredAnalysisInterval[];
  }

  getAnalysisRoomIntervals(datasetId: string, roomId: string, fromUtc: string, toUtc: string): StoredAnalysisInterval[] {
    return this.connection.prepare(`SELECT run_id,room_id,interval_start_utc,interval_end_utc,interval_seconds,
      occupancy_avg,occupancy_max,occupied_fraction,avg_temp_c,avg_rh_pct,partial FROM room_intervals
      WHERE dataset_id=? AND room_id=? AND interval_start_utc>=? AND interval_start_utc<?
      ORDER BY interval_start_utc`).all(datasetId, roomId, fromUtc, toUtc) as StoredAnalysisInterval[];
  }

  createAnalysisJob(input: AnalysisJobInput): void {
    this.connection.prepare(`INSERT INTO analysis_jobs(job_id,dataset_id,status,request_json,requested_start_utc,requested_end_utc)
      VALUES (?,?,?,?,?,?)`).run(input.jobId, input.datasetId, input.status, JSON.stringify(input.request),
      input.request.start_utc ?? null, input.request.end_utc ?? null);
  }

  pendingAnalysisJobs(): number {
    return (this.connection.prepare("SELECT count(*) AS count FROM analysis_jobs WHERE status IN ('queued','running')")
      .get() as { count: number }).count;
  }

  markInterruptedAnalysisJobs(): number {
    return this.connection.prepare(`UPDATE analysis_jobs SET status='failed',error_code='JOB_INTERRUPTED',
      error_message='Analysis was interrupted by a service restart',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status IN ('queued','running')`).run().changes;
  }

  startAnalysisJob(jobId: string, method: string, version: string, batchTotal: number): void {
    this.connection.prepare(`UPDATE analysis_jobs SET status='running',method=?,method_version=?,batch_total=?,
      batch_completed=0,progress_json=?,error_code=NULL,error_message=NULL
      WHERE job_id=? AND status='queued'`).run(method, version, batchTotal, JSON.stringify({ completed_batches: 0, total_batches: batchTotal }), jobId);
  }

  updateAnalysisJobProgress(jobId: string, completed: number, total: number, coverage: { start_utc: string; end_utc: string } | null): void {
    this.connection.prepare(`UPDATE analysis_jobs SET batch_completed=?,batch_total=?,
      actual_start_utc=CASE WHEN actual_start_utc IS NULL OR actual_start_utc>? THEN ? ELSE actual_start_utc END,
      actual_end_utc=CASE WHEN actual_end_utc IS NULL OR actual_end_utc<? THEN ? ELSE actual_end_utc END,
      progress_json=? WHERE job_id=? AND status='running'`)
      .run(completed, total, coverage?.start_utc ?? null, coverage?.start_utc ?? null,
        coverage?.end_utc ?? null, coverage?.end_utc ?? null,
        JSON.stringify({ completed_batches: completed, total_batches: total, ...(coverage ? { last_batch_coverage: coverage } : {}) }), jobId);
  }

  completeAnalysisJob(jobId: string, result: JsonRecord, findings: Array<{ findingId: string; datasetId: string; scopeId: string; findingType: string; severity: string; details: JsonRecord }>): void {
    this.transaction(() => {
      const add = this.connection.prepare(`INSERT INTO findings(finding_id,job_id,dataset_id,scope_type,scope_id,finding_type,severity,details_json)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const finding of findings) add.run(`${jobId}:${finding.findingId}`, jobId, finding.datasetId, 'device', finding.scopeId,
        finding.findingType, finding.severity, JSON.stringify(finding.details));
      this.connection.prepare(`UPDATE analysis_jobs SET status='completed',result_json=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        actual_end_utc=json_extract(?,'$.coverage.end_utc') WHERE job_id=? AND status='running'`)
        .run(JSON.stringify(result), JSON.stringify(result), jobId);
    });
  }

  failAnalysisJob(jobId: string, code: string, message: string): void {
    this.connection.prepare(`UPDATE analysis_jobs SET status='failed',error_code=?,error_message=?,
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=? AND status IN ('queued','running')`)
      .run(code, message, jobId);
  }

  getAnalysisJob(jobId: string): AnalysisJobRecord | undefined {
    const row = this.connection.prepare(`SELECT job_id,dataset_id,status,request_json,method,method_version,
      requested_start_utc,requested_end_utc,actual_start_utc,actual_end_utc,batch_completed,batch_total,progress_json,
      result_json,error_code,error_message,created_at,completed_at FROM analysis_jobs WHERE job_id=?`).get(jobId) as
      (Omit<AnalysisJobRecord, 'status' | 'request' | 'progress' | 'result'> & { status: AnalysisJobRecord['status']; request_json: string; progress_json: string; result_json: string | null }) | undefined;
    if (!row) return undefined;
    const { request_json, progress_json, result_json, ...fields } = row;
    return { ...fields, request: JSON.parse(request_json) as JsonRecord, progress: JSON.parse(progress_json) as JsonRecord,
      result: result_json ? JSON.parse(result_json) as JsonRecord : null };
  }

  getAnalysisFindings(jobId: string, limit: number, offset: number): { items: JsonRecord[]; total: number } {
    const total = (this.connection.prepare('SELECT count(*) AS count FROM findings WHERE job_id=?').get(jobId) as { count: number }).count;
    const rows = this.connection.prepare(`SELECT details_json FROM findings WHERE job_id=? ORDER BY finding_id LIMIT ? OFFSET ?`)
      .all(jobId, limit, offset) as Array<{ details_json: string }>;
    return { items: rows.map((row) => JSON.parse(row.details_json) as JsonRecord), total };
  }

  getCurrentTariff(userId = 'local'): number | null {
    const row = this.connection.prepare('SELECT rate_per_kwh FROM user_tariff_settings WHERE user_id=?').get(userId) as { rate_per_kwh: number } | undefined;
    return row?.rate_per_kwh ?? null;
  }

  addFinding(input: FindingInput): void {
    this.connection.prepare(`INSERT INTO findings(finding_id,job_id,dataset_id,scope_type,scope_id,finding_type,severity,details_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(input.findingId, input.jobId, input.datasetId, input.scopeType, input.scopeId ?? null,
      input.findingType, input.severity, JSON.stringify(input.details));
  }

  addForecast(input: ForecastInput): void {
    const tariff = input.tariff;
    this.connection.prepare(`INSERT INTO forecast_records(forecast_id,job_id,dataset_id,target_start_utc,target_end_utc,
      energy_kwh,tariff_user_id,tariff_rate_per_kwh,currency,cost_amount,assumptions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.forecastId, input.jobId, input.datasetId, input.targetStartUtc, input.targetEndUtc, input.energyKwh,
        tariff?.userId ?? null, tariff?.ratePerKwh ?? null, tariff?.currency ?? null, tariff?.costAmount ?? null,
        JSON.stringify(input.assumptions));
  }

  addComparison(input: ComparisonInput): void {
    this.connection.prepare(`INSERT INTO comparison_records(comparison_id,original_dataset_id,improved_dataset_id,assumptions_json)
      VALUES (?,?,?,?)`).run(input.comparisonId, input.originalDatasetId, input.improvedDatasetId, JSON.stringify(input.assumptions));
  }

  close(): void {
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
  }
}

export function resolveDatabasePath(path: string, cwd = process.cwd()): string {
  return path === ':memory:' || isAbsolute(path) ? path : resolve(cwd, path);
}
