import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { AuditorDatabase } from './db/database.js';

// Optional local overrides; variables already set in the environment win.
if (existsSync('.env')) process.loadEnvFile('.env');

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const { host, port, shutdownTimeoutMs } = config;
const database = new AuditorDatabase(config.databasePath, config.databaseBusyTimeoutMs);
const server = createApp(config).listen(port, host, () => {
  console.log(`auditor-backend listening on http://${host}:${port} (health: /api/v1/health, pid ${process.pid})`);
});
server.on('error', (err) => {
  console.error(`Failed to listen on ${host}:${port}: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing server`);
  const timer = setTimeout(() => {
    console.error('Shutdown deadline reached; closing remaining connections');
    server.closeAllConnections();
  }, shutdownTimeoutMs);
  timer.unref();
  server.close((err) => {
    if (err) console.error(err);
    database.close();
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
