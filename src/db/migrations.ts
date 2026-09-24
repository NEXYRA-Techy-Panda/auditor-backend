import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [{
  version: 1,
  name: 'auditor_persistence_foundation',
  sql: `
    CREATE TABLE datasets (
      dataset_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_format TEXT NOT NULL,
      source_resolution_seconds INTEGER NOT NULL CHECK (source_resolution_seconds > 0),
      timezone TEXT NOT NULL,
      synthetic INTEGER NOT NULL CHECK (synthetic IN (0,1)),
      synthetic_label TEXT,
      building_id TEXT NOT NULL,
      building_name TEXT NOT NULL,
      simulator_run_id TEXT NOT NULL,
      export_id TEXT NOT NULL,
      semantic_fingerprint TEXT NOT NULL,
      file_sha256 TEXT,
      source_metadata_json TEXT NOT NULL CHECK (json_valid(source_metadata_json)),
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (source, simulator_run_id, export_id)
    );
    CREATE INDEX datasets_semantic_fingerprint_idx ON datasets(semantic_fingerprint);

    CREATE TABLE buildings (
      dataset_id TEXT NOT NULL,
      building_id TEXT NOT NULL,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      PRIMARY KEY (dataset_id, building_id),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );
    CREATE TABLE rooms (
      dataset_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      room_type TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      floor_area_m2 REAL,
      PRIMARY KEY (dataset_id, room_id),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );
    CREATE TABLE devices (
      dataset_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      device_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      nominal_power_w REAL NOT NULL,
      standby_power_w REAL,
      power_factor REAL NOT NULL,
      always_on INTEGER NOT NULL CHECK (always_on IN (0,1)),
      control TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      PRIMARY KEY (dataset_id, device_id),
      UNIQUE (dataset_id, device_id, room_id),
      FOREIGN KEY (dataset_id, room_id) REFERENCES rooms(dataset_id, room_id),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );
    CREATE TABLE policy_versions (
      dataset_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      applies_to TEXT NOT NULL,
      kind TEXT NOT NULL,
      effective_from_utc TEXT NOT NULL,
      rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
      PRIMARY KEY (dataset_id, policy_id, version),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );
    CREATE TABLE room_intervals (
      dataset_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      interval_start_utc TEXT NOT NULL,
      interval_end_utc TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      occupancy_avg REAL NOT NULL,
      occupancy_max INTEGER NOT NULL,
      occupied_fraction REAL NOT NULL,
      avg_temp_c REAL NOT NULL,
      avg_rh_pct REAL NOT NULL,
      partial INTEGER NOT NULL CHECK (partial IN (0,1)),
      PRIMARY KEY (dataset_id, run_id, room_id, interval_start_utc),
      FOREIGN KEY (dataset_id, room_id) REFERENCES rooms(dataset_id, room_id),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );
    CREATE TABLE device_intervals (
      dataset_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      interval_start_utc TEXT NOT NULL,
      interval_end_utc TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      avg_power_w REAL NOT NULL,
      max_power_w REAL NOT NULL,
      energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0),
      cumulative_kwh REAL NOT NULL,
      avg_voltage_v REAL,
      avg_current_a REAL,
      power_factor REAL NOT NULL,
      on_fraction REAL NOT NULL,
      override_seconds REAL NOT NULL,
      vacant_on_seconds REAL NOT NULL,
      offschedule_on_seconds REAL NOT NULL,
      policy_id TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      partial INTEGER NOT NULL CHECK (partial IN (0,1)),
      PRIMARY KEY (dataset_id, run_id, device_id, interval_start_utc),
      FOREIGN KEY (dataset_id, room_id) REFERENCES rooms(dataset_id, room_id),
      FOREIGN KEY (dataset_id, device_id, room_id) REFERENCES devices(dataset_id, device_id, room_id),
      FOREIGN KEY (dataset_id, policy_id, policy_version) REFERENCES policy_versions(dataset_id, policy_id, version),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );
    CREATE INDEX device_intervals_energy_idx ON device_intervals(dataset_id, device_id, interval_start_utc);

    CREATE TABLE user_tariff_settings (
      user_id TEXT PRIMARY KEY,
      currency TEXT NOT NULL DEFAULT 'INR',
      rate_per_kwh REAL NOT NULL CHECK (rate_per_kwh >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE analysis_jobs (
      job_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT,
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id)
    );
    CREATE TABLE findings (
      finding_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      finding_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK (json_valid(details_json)),
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(job_id),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id)
    );
    CREATE TABLE forecast_records (
      forecast_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      target_start_utc TEXT NOT NULL,
      target_end_utc TEXT NOT NULL,
      energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0),
      tariff_user_id TEXT,
      tariff_rate_per_kwh REAL CHECK (tariff_rate_per_kwh IS NULL OR tariff_rate_per_kwh >= 0),
      currency TEXT,
      cost_amount REAL,
      assumptions_json TEXT NOT NULL CHECK (json_valid(assumptions_json)),
      CHECK ((tariff_rate_per_kwh IS NULL AND cost_amount IS NULL) OR
             (tariff_rate_per_kwh IS NOT NULL AND cost_amount IS NOT NULL)),
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(job_id),
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id),
      FOREIGN KEY (tariff_user_id) REFERENCES user_tariff_settings(user_id)
    );
    CREATE TABLE comparison_records (
      comparison_id TEXT PRIMARY KEY,
      original_dataset_id TEXT NOT NULL,
      improved_dataset_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      assumptions_json TEXT NOT NULL CHECK (json_valid(assumptions_json)),
      FOREIGN KEY (original_dataset_id) REFERENCES datasets(dataset_id),
      FOREIGN KEY (improved_dataset_id) REFERENCES datasets(dataset_id)
    );
  `,
}, {
  version: 2,
  name: 'analysis_job_execution_and_results',
  sql: `
    ALTER TABLE analysis_jobs ADD COLUMN method TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN method_version TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN requested_start_utc TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN requested_end_utc TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN actual_start_utc TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN actual_end_utc TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN batch_completed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE analysis_jobs ADD COLUMN batch_total INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE analysis_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json));
    ALTER TABLE analysis_jobs ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
    ALTER TABLE analysis_jobs ADD COLUMN error_code TEXT;
    ALTER TABLE analysis_jobs ADD COLUMN error_message TEXT;
    CREATE INDEX analysis_jobs_status_idx ON analysis_jobs(status, created_at);
    CREATE INDEX findings_job_idx ON findings(job_id, finding_id);
  `,
}, {
  version: 3,
  name: 'forecast_jobs_and_hourly_results',
  sql: `
    ALTER TABLE analysis_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'analysis'
      CHECK (job_type IN ('analysis','forecast'));
    ALTER TABLE forecast_records ADD COLUMN horizon TEXT;
    ALTER TABLE forecast_records ADD COLUMN origin_utc TEXT;
    ALTER TABLE forecast_records ADD COLUMN method TEXT;
    ALTER TABLE forecast_records ADD COLUMN baseline_version TEXT;
    ALTER TABLE forecast_records ADD COLUMN model_version TEXT;
    ALTER TABLE forecast_records ADD COLUMN timezone TEXT;
    ALTER TABLE forecast_records ADD COLUMN synthetic INTEGER CHECK (synthetic IS NULL OR synthetic IN (0,1));
    ALTER TABLE forecast_records ADD COLUMN synthetic_label TEXT;
    ALTER TABLE forecast_records ADD COLUMN points_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(points_json));
    ALTER TABLE forecast_records ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json));
    CREATE INDEX forecast_records_job_idx ON forecast_records(job_id);
  `,
}];

export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migration_history (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = db.prepare('SELECT version, name FROM migration_history ORDER BY version').all() as { version: number; name: string }[];
  for (const row of applied) {
    const migration = migrations.find((item) => item.version === row.version);
    if (!migration || migration.name !== row.name) throw new Error(`Unknown or mismatched database migration ${row.version} (${row.name})`);
  }
  for (const migration of migrations) {
    if (applied.some((row) => row.version === migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO migration_history(version, name) VALUES (?, ?)').run(migration.version, migration.name);
    })();
  }
}
