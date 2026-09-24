import { Router } from 'express';
import type { AnalysisJobManager, AnalysisJobInputError } from '../analysis/jobs.js';
import type { AuditorDatabase } from '../db/database.js';
import { AGGREGATION_RESOLUTIONS } from '../analysis/aggregate.js';
import { DETECTORS, MAX_DETECTOR_FINDINGS, MAX_SECTION_RECORDS, isDetectorId } from '../analysis/detectors.js';
import { sendData, sendError } from '../http/envelope.js';

function pageParam(raw: unknown, fallback: number, max: number): number | undefined {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
}

export function analysisRouter(jobs: AnalysisJobManager, database: AuditorDatabase): Router {
  const router = Router();
  router.post('/analysis/jobs', (req, res) => {
    try { sendData(res, jobs.submit(req.body), 202); }
    catch (error) {
      const issue = error as AnalysisJobInputError;
      if (issue && typeof issue.status === 'number') {
        sendError(res, issue.status, { code: issue.code, message: issue.message, ...(issue.field ? { field: issue.field } : {}) });
      } else sendError(res, 500, { code: 'INTERNAL_ERROR', message: 'Could not create analysis job' });
    }
  });

  router.get('/analysis/jobs/:id', (req, res) => {
    const page = pageParam(req.query.page, 1, 1_000_000);
    const pageSize = pageParam(req.query.page_size, 100, 500);
    if (!page || !pageSize) { sendError(res, 422, { code: 'VALIDATION_ERROR', message: 'page must be positive and page_size must be between 1 and 500' }); return; }
    const result = jobs.get(req.params.id!, pageSize, (page - 1) * pageSize);
    const job = result.job;
    if (!job || job.job_type !== 'analysis') { sendError(res, 404, { code: 'NOT_FOUND', message: 'Analysis job was not found' }); return; }
    const detectorId = isDetectorId(job.request.detector) ? job.request.detector : null;
    const data: Record<string, unknown> = {
      job_id: job.job_id, dataset_id: job.dataset_id, status: job.status,
      method: job.method, method_version: job.method_version,
      requested_range: job.requested_start_utc ? { start_utc: job.requested_start_utc, end_utc: job.requested_end_utc } : null,
      actual_coverage: job.actual_start_utc ? { start_utc: job.actual_start_utc, end_utc: job.actual_end_utc } : null,
      progress: { ...job.progress, completed_batches: job.batch_completed, total_batches: job.batch_total },
      created_at: job.created_at, completed_at: job.completed_at,
    };
    if (job.status === 'failed') data.error = { code: job.error_code ?? 'JOB_FAILED', message: job.error_message ?? 'Analysis job failed' };
    if (detectorId) {
      // P026 detector job: no tariff-derived cost is exposed, because a power
      // deviation or trend is never a guaranteed avoidable amount.
      const definition = DETECTORS[detectorId];
      data.detector = { id: detectorId, label: definition.label, method: definition.method,
        method_version: definition.detector_version, technique: definition.technique,
        finding_type: definition.finding_type, request_format: definition.request_format };
      data.windows = job.result?.windows ?? { reference: job.request.reference_window ?? null, evaluation: job.request.evaluation_window ?? null };
      if (job.status === 'completed' && job.result) {
        const findings = result.findings!;
        data.result = { ...job.result,
          findings: findings.items,
          findings_pagination: { page, page_size: pageSize, total: findings.total },
        };
      }
      sendData(res, data);
      return;
    }
    if (job.status === 'completed' && job.result) {
      const tariff = database.getCurrentTariff();
      const findings = result.findings!;
      const totals = job.result.totals as Record<string, unknown>;
      const datasetEnergy = Number(totals.dataset_energy_kwh);
      const avoidableEnergy = Number(totals.avoidable_energy_kwh);
      data.result = { ...job.result,
        totals: { ...totals, tariff_inr_per_kwh: tariff,
          dataset_cost_inr: tariff === null ? null : datasetEnergy * tariff,
          avoidable_cost_inr: tariff === null ? null : avoidableEnergy * tariff },
        findings: findings.items.map((finding) => ({ ...finding,
          ...(tariff === null || typeof finding.avoidable_energy_kwh !== 'number' ? {} : { avoidable_cost_inr: Number(finding.avoidable_energy_kwh) * tariff }),
        })),
        findings_pagination: { page, page_size: pageSize, total: findings.total },
      };
    }
    sendData(res, data);
  });

  // Detector catalogue for the frontend: which detectors exist, what each needs
  // and how the auditor bounds and aggregates the sections it selects.
  router.get('/detectors', (_req, res) => {
    sendData(res, {
      detectors: [
        { id: 'vacancy', label: 'Vacant-but-on (contract rule)', method: 'rule',
          method_version: 'vacant-beyond-grace-v1', technique: null, finding_type: 'vacant_but_on',
          request: { endpoint: 'POST /api/v1/analysis/jobs', body: { dataset_id: 'required', detector: 'vacancy (default)', from_utc: 'optional', to_utc: 'optional' } },
          section_bounds: null, requirements: ['Readings with matching room intervals; the vacancy grace comes from the applied policy version.'] },
        ...Object.values(DETECTORS).map((definition) => ({
          id: definition.id, label: definition.label, method: definition.method,
          method_version: definition.detector_version, technique: definition.technique,
          finding_type: definition.finding_type, request_format: definition.request_format,
          request: { endpoint: 'POST /api/v1/analysis/jobs',
            body: { dataset_id: 'required', detector: definition.id,
              reference_window: { start_utc: 'required', end_utc: 'required' },
              evaluation_window: { start_utc: 'required', end_utc: 'required' } } },
          section_bounds: { device_intervals: MAX_SECTION_RECORDS, room_intervals: MAX_SECTION_RECORDS },
          single_evaluation_section: definition.single_evaluation_section,
          requirements: definition.requirements,
        })),
      ],
      limits: { max_section_records: MAX_SECTION_RECORDS, max_findings_per_job: MAX_DETECTOR_FINDINGS },
      aggregation: { requested_interval_nominals_seconds: [...AGGREGATION_RESOLUTIONS],
        semantics: 'Stored readings are sent unchanged when they fit the section bound. Otherwise they are aggregated onto requested contract intervals; only bins whose readings are contiguous, non-partial, fully on, under one policy version and covered by room context are sent, and every other bin is reported under excluded_device_bins.' },
      notes: ['result.status distinguishes findings_detected, evaluated_no_deviation / evaluated_no_gradual_trend, insufficient_reference / insufficient_history, unsupported_context, unsupported_aggregation and no_comparable_observations.',
        'Detector findings are deviations, not confirmed malfunctions or efficiency loss, and are never added to vacancy avoidable-energy totals.',
        'Tariff changes never rerun a detector and add no cost to detector results.'],
    });
  });
  return router;
}
