import type { JsonRecord } from './types.js';

export type PythonFailureKind = 'unavailable' | 'timeout' | 'malformed' | 'rejected';
export type PythonServiceOperation = 'analysis' | 'forecast';

export class PythonServiceError extends Error {
  constructor(readonly kind: PythonFailureKind, readonly upstreamCode?: string,
    readonly operation: PythonServiceOperation = 'analysis', readonly upstreamMessage?: string) {
    const subject = operation === 'forecast' ? 'forecast' : 'analysis';
    super(kind === 'timeout' ? `Python ${subject} timed out` : kind === 'unavailable'
      ? `Python ${subject} service is unavailable` : kind === 'malformed'
        ? `Python ${subject} service returned an invalid response` : `Python ${subject} request was rejected`);
  }
}

interface PythonClientOptions { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch; }
const validRequestId = /^[0-9a-f-]{36}$/i;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new PythonServiceError('malformed');
  if (!response.body) throw new PythonServiceError('malformed');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PythonServiceError('malformed');
      }
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally { reader.releaseLock(); }
}

export class PythonAnalysisClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: PythonClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async probe(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/health`, { signal: AbortSignal.timeout(this.options.timeoutMs) });
      const body = await response.json() as unknown;
      if (!response.ok || !isEnvelope(body)) return false;
      const data = body.data as Record<string, unknown>;
      return data.status === 'ok' && typeof data.model_available === 'boolean';
    } catch { return false; }
  }

  async analyze(payload: JsonRecord): Promise<JsonRecord> {
    const requestBody = JSON.stringify(payload);
    if (Buffer.byteLength(requestBody, 'utf8') > 8 * 1024 * 1024) throw new PythonServiceError('rejected', 'REQUEST_TOO_LARGE');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/v1/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: requestBody, signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new PythonServiceError('timeout');
      throw new PythonServiceError('unavailable');
    }

    let body: unknown;
    try {
      const text = await boundedResponseText(response);
      body = JSON.parse(text) as unknown;
    }
    catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new PythonServiceError('timeout');
      throw new PythonServiceError('malformed');
    }
    if (!response.ok) {
      if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
        throw new PythonServiceError('rejected', body.error.code);
      }
      throw new PythonServiceError('malformed');
    }
    if (!isEnvelope(body) || !isAnalysisData(body.data)) throw new PythonServiceError('malformed');
    const data = body.data as JsonRecord;
    const analysis = data.analysis as JsonRecord;
    const requestedWindow = payload.window as Record<string, unknown> | undefined;
    const resultWindow = analysis.window as Record<string, unknown> | undefined;
    const records = analysis.records as Record<string, unknown>;
    const requestedRoomCount = Array.isArray(payload.room_intervals) ? payload.room_intervals.length : 0;
    const requestedDeviceCount = Array.isArray(payload.device_intervals) ? payload.device_intervals.length : 0;
    if (analysis.dataset_id !== payload.dataset_id || analysis.run_id !== payload.run_id
      || !requestedWindow || !resultWindow || resultWindow.start_utc !== requestedWindow.start_utc
      || resultWindow.end_utc !== requestedWindow.end_utc
      || !Number.isInteger(records.room_intervals) || Number(records.room_intervals) > requestedRoomCount
      || !Number.isInteger(records.device_intervals) || Number(records.device_intervals) > requestedDeviceCount
      || Number(records.room_intervals) > 2000 || Number(records.device_intervals) > 2000) throw new PythonServiceError('malformed');
    return data;
  }

  async forecast(payload: JsonRecord): Promise<JsonRecord> {
    const operation: PythonServiceOperation = 'forecast';
    const requestBody = JSON.stringify(payload);
    if (Buffer.byteLength(requestBody, 'utf8') > 8 * 1024 * 1024) throw new PythonServiceError('rejected', 'REQUEST_TOO_LARGE', operation);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/v1/forecast`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: requestBody, signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new PythonServiceError('timeout', undefined, operation);
      throw new PythonServiceError('unavailable', undefined, operation);
    }

    let body: unknown;
    try { body = JSON.parse(await boundedResponseText(response)) as unknown; }
    catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new PythonServiceError('timeout', undefined, operation);
      throw new PythonServiceError('malformed', undefined, operation);
    }
    if (!response.ok) {
      if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
        const message = typeof body.error.message === 'string'
          ? Array.from(body.error.message, (character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127 ? ' ' : character;
          }).join('').slice(0, 512) : undefined;
        throw new PythonServiceError('rejected', body.error.code, operation, message);
      }
      throw new PythonServiceError('malformed', undefined, operation);
    }
    if (!isEnvelope(body) || !isRecord(body.data)) throw new PythonServiceError('malformed', undefined, operation);
    return body.data;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is { data: unknown; meta: { request_id: string } } {
  return isRecord(value) && 'data' in value && isRecord(value.meta)
    && typeof value.meta.request_id === 'string' && validRequestId.test(value.meta.request_id);
}

function isAnalysisData(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.findings) || !Array.isArray(value.warnings) || !isRecord(value.analysis)) return false;
  const analysis = value.analysis;
  return analysis.method === 'rule' && analysis.model_used === false
    && analysis.contract_version === '1.0.1' && isRecord(analysis.window)
    && isRecord(analysis.records) && Array.isArray(analysis.excluded_devices)
    && value.findings.every((finding) => isRecord(finding) && typeof finding.finding_id === 'string'
      && typeof finding.finding_type === 'string' && typeof finding.device_id === 'string'
      && typeof finding.room_id === 'string' && finding.method === 'rule'
      && isRecord(finding.observed) && isRecord(finding.expected)
      && typeof finding.assumptions === 'string' && typeof finding.resolution_limit === 'string'
      && isRecord(finding.evidence) && finding.evidence.rule_version === 'vacant-beyond-grace-v1'
      && Array.isArray(finding.evidence.intervals) && finding.evidence.intervals.every((interval) => isRecord(interval)
        && typeof interval.interval_start_utc === 'string' && typeof interval.interval_end_utc === 'string'
        && typeof interval.counted_from_utc === 'string' && typeof interval.policy_ref === 'string'))
    && value.warnings.every((warning) => isRecord(warning) && typeof warning.code === 'string' && typeof warning.message === 'string');
}
