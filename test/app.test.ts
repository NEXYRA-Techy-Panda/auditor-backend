import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';

const config = loadConfig({ JSON_BODY_LIMIT: '1kb' });
interface Envelope {
  data?: unknown;
  meta?: { request_id: string };
  error?: { code: string; message: string };
}
const readJson = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

let server: Server;
let base: string;

before(async () => {
  server = createApp(config).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('GET /api/v1/health', () => {
  it('reports ok with ml_reachable not_checked in the success envelope', async () => {
    const res = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'http://localhost:3001' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3001');
    const body = await readJson(res);
    assert.deepEqual(body.data, {
      status: 'ok',
      contract_version: '1.0.1',
      ml_reachable: 'not_checked',
    });
    assert.match(body.meta?.request_id ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get('x-request-id'), body.meta?.request_id);
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND for unknown routes', async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await readJson(res), {
      error: { code: 'NOT_FOUND', message: 'No route for GET /api/v1/does-not-exist' },
    });
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const res = await fetch(`${base}/api/v1/health`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await readJson(res)).error?.code, 'VALIDATION_ERROR');
  });

  it('returns REQUEST_TOO_LARGE above the JSON body limit', async () => {
    const res = await fetch(`${base}/api/v1/health`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(2048) }),
    });
    assert.equal(res.status, 413);
    assert.equal((await readJson(res)).error?.code, 'REQUEST_TOO_LARGE');
  });

  it('does not grant CORS to other origins', async () => {
    const res = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'http://evil.example' } });
    assert.notEqual(res.headers.get('access-control-allow-origin'), 'http://evil.example');
  });
});

describe('config', () => {
  it('uses the documented defaults', () => {
    assert.deepEqual(loadConfig({}), {
      port: 4001, host: '127.0.0.1', frontendOrigin: 'http://localhost:3001',
      jsonBodyLimit: '100kb', shutdownTimeoutMs: 10000, mlServiceUrl: 'http://localhost:8000',
      mlTimeoutMs: 10000,
      databasePath: './data/auditor.sqlite', databaseBusyTimeoutMs: 5000,
      uploadMaxBytes: 536870912,
    });
  });

  it('rejects non-origin URLs and invalid ports', () => {
    assert.throws(() => loadConfig({ FRONTEND_ORIGIN: 'http://localhost:3000/app' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ JSON_BODY_LIMIT: 'lots' }), ConfigError);
  });
});
