export interface Config {
  port: number;
  host: string;
  /** Exact browser origin allowed by CORS. CORS is not authentication. */
  frontendOrigin: string;
  /** Maximum JSON request body, as an Express size string (e.g. "100kb"). */
  jsonBodyLimit: string;
  shutdownTimeoutMs: number;
  /**
   * Origin of the private energy-ml-service (routes such as /health are appended
   * by callers). Configured only; not contacted until F4.
   */
  mlServiceUrl: string;
  databasePath: string;
  databaseBusyTimeoutMs: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function intInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}]; got "${raw}"`);
  }
  return value;
}

/** Accepts an origin only: http(s) scheme + host (+ port); no path, query, fragment or credentials. */
export function parseOrigin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL origin; got "${raw}"`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password || raw.endsWith('/')) {
    throw new ConfigError(`${name} must be an origin only (e.g. http://localhost:3001); got "${raw}"`);
  }
  return url.origin;
}

export function parseSizeLimit(name: string, raw: string): string {
  if (!/^\d+(\.\d+)?\s*(b|kb|mb)?$/i.test(raw)) {
    throw new ConfigError(`${name} must be a size such as "100kb"; got "${raw}"`);
  }
  return raw;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    port: intInRange(env, 'PORT', 4001, 0, 65535),
    host: env.HOST || '127.0.0.1',
    frontendOrigin: parseOrigin('FRONTEND_ORIGIN', env.FRONTEND_ORIGIN || 'http://localhost:3001'),
    jsonBodyLimit: parseSizeLimit('JSON_BODY_LIMIT', env.JSON_BODY_LIMIT || '100kb'),
    shutdownTimeoutMs: intInRange(env, 'SHUTDOWN_TIMEOUT_MS', 10000, 0, 600000),
    mlServiceUrl: parseOrigin('ML_SERVICE_URL', env.ML_SERVICE_URL || 'http://localhost:8000'),
    databasePath: env.DATABASE_PATH || './data/auditor.sqlite',
    databaseBusyTimeoutMs: intInRange(env, 'DATABASE_BUSY_TIMEOUT_MS', 5000, 0, 60000),
  };
}
