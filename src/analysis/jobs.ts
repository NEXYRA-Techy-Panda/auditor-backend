import { randomUUID } from 'node:crypto';
import type { AnalysisDatasetMeta, AuditorDatabase } from '../db/database.js';
import { AnalysisBatchRunner, AnalysisScopeError, pythonFailureSafeMessage } from './batches.js';
import { PythonServiceError } from './client.js';
import { DeviceDetectorRunner, DETECTORS, isDetectorId, type DetectorId, type DetectorWindows } from './detectors.js';
import type { JsonRecord } from './types.js';
import { FORECAST_BASELINE_VERSION, FORECAST_HORIZONS, ForecastInputError, ForecastRunner, type ForecastHorizon } from '../forecast/runner.js';

const MAX_QUEUED_JOBS = 4;
const MAX_STORED_FINDINGS_PER_JOB = 100_000;

export class AnalysisJobInputError extends Error {
  constructor(readonly status: number, readonly code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'UNSUPPORTED_INPUT' | 'CONFLICT', message: string, readonly field?: string) { super(message); }
}

/** Validates one detector window: shape, real UTC seconds, dataset range and interval alignment. */
function resolveDetectorWindow(meta: AnalysisDatasetMeta, value: unknown, field: string): DetectorWindows {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', `${field} must be an object with start_utc and end_utc`, field);
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'start_utc' && key !== 'end_utc')) {
    throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', `${field} accepts only start_utc and end_utc`, field);
  }
  if (!validUtc(raw.start_utc)) throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', `${field}.start_utc must be a real UTC timestamp with second precision`, `${field}.start_utc`);
  if (!validUtc(raw.end_utc)) throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', `${field}.end_utc must be a real UTC timestamp with second precision`, `${field}.end_utc`);
  const from = raw.start_utc;
  const to = raw.end_utc;
  if (from >= to || from < meta.start_utc || to > meta.end_utc) {
    throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', `${field} must be ordered and within the dataset export range`, `${field}.start_utc`);
  }
  const step = meta.interval_seconds * 1000;
  if ((Date.parse(to) - Date.parse(from)) % step !== 0 || (Date.parse(from) - Date.parse(meta.start_utc)) % step !== 0) {
    throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', `${field} must align to imported interval boundaries`, `${field}.start_utc`);
  }
  return { start_utc: from, end_utc: to };
}

function validUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().replace('.000Z', 'Z') === value;
}

export class AnalysisJobManager {
  private active = false;
  private readonly queue: string[] = [];
  private readonly detectorRunner: DeviceDetectorRunner;
  constructor(private readonly database: AuditorDatabase, private readonly runner: AnalysisBatchRunner,
    private readonly forecastRunner?: ForecastRunner) {
    this.detectorRunner = new DeviceDetectorRunner(database, runner.client);
  }

  recoverAfterRestart(): number { return this.database.markInterruptedAnalysisJobs(); }

  submit(body: unknown): { job_id: string; status: 'queued'; detector: 'vacancy' | DetectorId } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnalysisJobInputError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
    const input = body as Record<string, unknown>;
    if (typeof input.dataset_id !== 'string' || input.dataset_id.length === 0) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'dataset_id is required', 'dataset_id');
    }
    const meta = this.database.getAnalysisDatasetMeta(input.dataset_id);
    if (!meta) throw new AnalysisJobInputError(404, 'NOT_FOUND', 'Dataset was not found', 'dataset_id');
    const detector = input.detector ?? 'vacancy';
    if (detector !== 'vacancy' && !isDetectorId(detector)) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'detector must be vacancy, excess_consumption or gradual_trend', 'detector');
    }
    if (detector !== 'vacancy') return this.submitDetector(meta, detector, input);
    const from = input.from_utc === undefined ? meta.start_utc : input.from_utc;
    const to = input.to_utc === undefined ? meta.end_utc : input.to_utc;
    if (!validUtc(from)) throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'from_utc must be a real UTC timestamp with second precision', 'from_utc');
    if (!validUtc(to)) throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'to_utc must be a real UTC timestamp with second precision', 'to_utc');
    if (from >= to || from < meta.start_utc || to > meta.end_utc) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'Requested range must be ordered and within the dataset export range', 'from_utc');
    }
    const durationMs = Date.parse(to) - Date.parse(from);
    if (durationMs % (meta.interval_seconds * 1000) !== 0
      || (Date.parse(from) - Date.parse(meta.start_utc)) % (meta.interval_seconds * 1000) !== 0) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'Requested range must align to imported interval boundaries', 'from_utc');
    }
    const pending = this.database.pendingAnalysisJobs();
    if (pending >= MAX_QUEUED_JOBS + 1) throw new AnalysisJobInputError(503, 'CONFLICT', 'Analysis queue is full; retry after a job completes');
    const jobId = randomUUID();
    this.database.createAnalysisJob({ jobId, datasetId: meta.dataset_id, status: 'queued', request: { dataset_id: meta.dataset_id, start_utc: from, end_utc: to } });
    this.queue.push(jobId);
    setImmediate(() => { void this.pump(); });
    return { job_id: jobId, status: 'queued', detector: 'vacancy' };
  }

  /**
   * P026 detector job: an explicit earlier reference window and a later
   * evaluation window, selected on the persisted dataset. Python owns both
   * detectors' comparability rules and thresholds; the auditor only selects,
   * validates and bounds the sections.
   */
  private submitDetector(meta: AnalysisDatasetMeta, detector: DetectorId, input: Record<string, unknown>): { job_id: string; status: 'queued'; detector: DetectorId } {
    const reference = resolveDetectorWindow(meta, input.reference_window, 'reference_window');
    const evaluation = resolveDetectorWindow(meta, input.evaluation_window, 'evaluation_window');
    if (reference.end_utc > evaluation.start_utc) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'reference_window must end at or before evaluation_window starts', 'reference_window');
    }
    if (this.database.pendingAnalysisJobs() >= MAX_QUEUED_JOBS + 1) {
      throw new AnalysisJobInputError(503, 'CONFLICT', 'Analysis queue is full; retry after a job completes');
    }
    const jobId = randomUUID();
    const request = { detector, dataset_id: meta.dataset_id, reference_window: reference, evaluation_window: evaluation,
      start_utc: evaluation.start_utc, end_utc: evaluation.end_utc };
    this.database.createAnalysisJob({ jobId, datasetId: meta.dataset_id, status: 'queued', request });
    this.queue.push(jobId);
    setImmediate(() => { void this.pump(); });
    return { job_id: jobId, status: 'queued', detector };
  }

  submitForecast(body: unknown): { forecast_id: string; job_id: string; status: 'queued'; horizon: ForecastHorizon; origin_utc: string; synthetic: boolean; synthetic_label: string | null } {
    if (!this.forecastRunner) throw new AnalysisJobInputError(503, 'CONFLICT', 'Forecast service is not configured');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnalysisJobInputError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['dataset_id', 'horizon', 'origin_utc'].includes(key))) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'Only dataset_id, horizon and optional origin_utc are accepted');
    }
    if (typeof input.dataset_id !== 'string' || input.dataset_id.length === 0) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'dataset_id is required', 'dataset_id');
    }
    if (typeof input.horizon !== 'string' || !FORECAST_HORIZONS.includes(input.horizon as ForecastHorizon)) {
      throw new AnalysisJobInputError(422, 'VALIDATION_ERROR', 'horizon must be next_24h, next_7d or next_calendar_month', 'horizon');
    }
    let resolved: ReturnType<ForecastRunner['resolveOrigin']>;
    try { resolved = this.forecastRunner.resolveOrigin(input.dataset_id, input.origin_utc); }
    catch (error) {
      if (error instanceof ForecastInputError) throw new AnalysisJobInputError(422, error.code, error.message, error.field);
      throw error;
    }
    if (this.database.pendingAnalysisJobs() >= MAX_QUEUED_JOBS + 1) {
      throw new AnalysisJobInputError(503, 'CONFLICT', 'Analysis and forecast queue is full; retry after a job completes');
    }
    const jobId = randomUUID();
    const request = { job_type: 'forecast', dataset_id: input.dataset_id, horizon: input.horizon, origin_utc: resolved.originUtc };
    this.database.createAnalysisJob({ jobId, datasetId: resolved.meta.dataset_id, status: 'queued', request, jobType: 'forecast' });
    this.queue.push(jobId);
    setImmediate(() => { void this.pump(); });
    return { forecast_id: jobId, job_id: jobId, status: 'queued', horizon: input.horizon as ForecastHorizon,
      origin_utc: resolved.originUtc, synthetic: resolved.meta.synthetic, synthetic_label: resolved.meta.synthetic_label };
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        const jobId = this.queue.shift()!;
        const job = this.database.getAnalysisJob(jobId);
        if (!job || job.status !== 'queued') continue;
        try {
          if (job.job_type === 'forecast') {
            if (!this.forecastRunner) throw new AnalysisJobInputError(503, 'CONFLICT', 'Forecast service is not configured');
            const horizon = String(job.request.horizon) as ForecastHorizon;
            const origin = String(job.request.origin_utc);
            this.database.startAnalysisJob(jobId, 'statistical_baseline', FORECAST_BASELINE_VERSION, 1);
            const execution = await this.forecastRunner.run(job.dataset_id, horizon, origin);
            const result = { ...execution.result, forecast_id: jobId } as JsonRecord;
            this.database.completeForecastJob({ forecastId: jobId, jobId, ...execution.record, result });
            continue;
          }
          if (isDetectorId(job.request.detector)) {
            const detector = job.request.detector;
            const reference = job.request.reference_window as DetectorWindows;
            const evaluation = job.request.evaluation_window as DetectorWindows;
            const definition = DETECTORS[detector];
            const total = this.detectorRunner.calls(this.detectorRunner.plan(job.dataset_id, detector, reference, evaluation));
            this.database.startAnalysisJob(jobId, definition.method, definition.detector_version, total);
            const execution = await this.detectorRunner.run(job.dataset_id, detector, reference, evaluation, {
              onProgress: (progress) => this.database.updateAnalysisJobProgress(jobId, progress.completed, progress.total,
                progress.coverage?.start_utc && progress.coverage.end_utc ? progress.coverage : null),
            });
            if (execution.findings.length > MAX_STORED_FINDINGS_PER_JOB) {
              throw new AnalysisScopeError('INSUFFICIENT_DATA', `Result has more than ${MAX_STORED_FINDINGS_PER_JOB} findings; narrow the requested windows`);
            }
            const findingRows = execution.findings.map((finding) => ({ findingId: String(finding.finding_id), datasetId: job.dataset_id,
              scopeId: String(finding.device_id), findingType: String(finding.finding_type), severity: 'warning', details: finding }));
            this.database.completeAnalysisJob(jobId, execution.result, findingRows);
            continue;
          }
          const startUtc = String(job.request.start_utc);
          const endUtc = String(job.request.end_utc);
          const total = this.runner.estimateBatches(job.dataset_id, startUtc, endUtc);
          this.database.startAnalysisJob(jobId, 'rule', 'vacant-beyond-grace-v1', total);
          const result = await this.runner.run(job.dataset_id, startUtc, endUtc, {
            onProgress: (progress) => this.database.updateAnalysisJobProgress(jobId, progress.completed, progress.total, progress.coverage),
          });
          const coverage = result.coverage as JsonRecord;
          const datasetEnergy = this.database.getAnalysisEnergy(job.dataset_id, startUtc, endUtc);
          const findings = result.findings as JsonRecord[];
          if (findings.length > MAX_STORED_FINDINGS_PER_JOB) throw new AnalysisScopeError('INSUFFICIENT_DATA', `Result has more than ${MAX_STORED_FINDINGS_PER_JOB} findings; narrow the requested range`);
          const avoidable = findings.filter((finding) => typeof finding.avoidable_energy_kwh === 'number')
            .reduce((sum, finding) => sum + Number(finding.avoidable_energy_kwh), 0);
          const resultHeader: JsonRecord = { ...result, findings: undefined,
            totals: { dataset_energy_kwh: datasetEnergy, avoidable_energy_kwh: avoidable,
              unknown_avoidable_findings: findings.filter((finding) => finding.avoidable_energy_kwh === undefined).length },
          };
          delete resultHeader.findings;
          const findingRows = findings.map((finding) => ({ findingId: String(finding.finding_id), datasetId: job.dataset_id,
            scopeId: String(finding.device_id), findingType: String(finding.finding_type), severity: 'warning', details: finding }));
          this.database.completeAnalysisJob(jobId, resultHeader, findingRows);
          void coverage;
        } catch (error) {
          let code = 'JOB_FAILED';
          let message = 'Analysis job failed';
          if (error instanceof PythonServiceError) {
            code = error.upstreamCode && ['REQUEST_TOO_LARGE', 'INSUFFICIENT_DATA', 'VALIDATION_ERROR', 'UNSUPPORTED_INPUT', 'UNSUPPORTED_VERSION', 'MODEL_UNAVAILABLE'].includes(error.upstreamCode)
              ? error.upstreamCode : `PYTHON_${error.kind.toUpperCase()}`;
            message = pythonFailureSafeMessage(error);
          } else if (error instanceof AnalysisScopeError) {
            code = error.code; message = error.message;
          } else if (error instanceof ForecastInputError) {
            code = error.code; message = error.message;
          } else if (error instanceof AnalysisJobInputError) {
            code = error.code; message = error.message;
          }
          if (!(error instanceof PythonServiceError) && !(error instanceof AnalysisScopeError)
            && !(error instanceof ForecastInputError) && !(error instanceof AnalysisJobInputError)) console.error('Analysis or forecast job failed unexpectedly');
          this.database.failAnalysisJob(jobId, code, message);
        }
      }
    } finally {
      this.active = false;
      if (this.queue.length) setImmediate(() => { void this.pump(); });
    }
  }

  get(jobId: string, limit = 100, offset = 0): { job: ReturnType<AuditorDatabase['getAnalysisJob']>; findings?: { items: JsonRecord[]; total: number } } {
    const job = this.database.getAnalysisJob(jobId);
    if (!job) return { job: undefined };
    return job.status === 'completed' ? { job, findings: this.database.getAnalysisFindings(jobId, limit, offset) } : { job };
  }
}
