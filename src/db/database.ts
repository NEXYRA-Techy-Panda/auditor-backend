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

  createAnalysisJob(input: AnalysisJobInput): void {
    this.connection.prepare('INSERT INTO analysis_jobs(job_id,dataset_id,status,request_json) VALUES (?,?,?,?)')
      .run(input.jobId, input.datasetId, input.status, JSON.stringify(input.request));
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
