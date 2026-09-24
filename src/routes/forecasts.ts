import { Router } from 'express';
import type { AnalysisJobManager, AnalysisJobInputError } from '../analysis/jobs.js';
import type { AuditorDatabase } from '../db/database.js';
import { sendData, sendError } from '../http/envelope.js';

export function forecastsRouter(jobs: AnalysisJobManager, database: AuditorDatabase): Router {
  const router = Router();
  router.post('/forecasts', (req, res) => {
    try { sendData(res, jobs.submitForecast(req.body), 202); }
    catch (error) {
      const issue = error as AnalysisJobInputError;
      if (issue && typeof issue.status === 'number') {
        sendError(res, issue.status, { code: issue.code, message: issue.message, ...(issue.field ? { field: issue.field } : {}) });
      } else sendError(res, 500, { code: 'INTERNAL_ERROR', message: 'Could not create forecast job' });
    }
  });

  router.get('/forecasts/:id', (req, res) => {
    const job = jobs.get(req.params.id!, 1, 0).job;
    if (!job || job.job_type !== 'forecast') { sendError(res, 404, { code: 'NOT_FOUND', message: 'Forecast was not found' }); return; }
    const request = job.request;
    const data: Record<string, unknown> = {
      forecast_id: job.job_id, job_id: job.job_id, dataset_id: job.dataset_id, status: job.status,
      horizon: request.horizon, origin_utc: request.origin_utc,
      method: job.method, baseline_version: job.method_version,
      progress: { completed: job.batch_completed, total: job.batch_total },
      created_at: job.created_at, completed_at: job.completed_at,
    };
    if (job.status === 'failed') data.error = { code: job.error_code ?? 'JOB_FAILED', message: job.error_message ?? 'Forecast failed' };
    if (job.status === 'completed' && job.result) {
      const tariff = database.getCurrentTariff();
      const totalEnergy = Number(job.result.total_energy_kwh);
      data.result = { ...job.result, tariff_inr_per_kwh: tariff,
        forecast_cost_inr: tariff === null ? null : totalEnergy * tariff };
    }
    sendData(res, data);
  });
  return router;
}
