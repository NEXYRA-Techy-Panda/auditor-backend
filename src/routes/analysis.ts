import { Router } from 'express';
import type { AnalysisJobManager, AnalysisJobInputError } from '../analysis/jobs.js';
import type { AuditorDatabase } from '../db/database.js';
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
    const data: Record<string, unknown> = {
      job_id: job.job_id, dataset_id: job.dataset_id, status: job.status,
      method: job.method, method_version: job.method_version,
      requested_range: job.requested_start_utc ? { start_utc: job.requested_start_utc, end_utc: job.requested_end_utc } : null,
      actual_coverage: job.actual_start_utc ? { start_utc: job.actual_start_utc, end_utc: job.actual_end_utc } : null,
      progress: { ...job.progress, completed_batches: job.batch_completed, total_batches: job.batch_total },
      created_at: job.created_at, completed_at: job.completed_at,
    };
    if (job.status === 'failed') data.error = { code: job.error_code ?? 'JOB_FAILED', message: job.error_message ?? 'Analysis job failed' };
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
  return router;
}
