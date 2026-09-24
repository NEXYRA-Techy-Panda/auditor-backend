import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { AuditorDatabase } from './database.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const db = new AuditorDatabase(config.databasePath, config.databaseBusyTimeoutMs);
try {
  const applied = db.db.prepare('SELECT version, name, applied_at FROM migration_history ORDER BY version').all();
  console.log(`Database ready at ${db.path}; migrations: ${JSON.stringify(applied)}`);
} finally {
  db.close();
}
