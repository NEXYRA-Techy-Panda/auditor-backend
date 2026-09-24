import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { AuditorDatabase, ReportEvidenceSnapshot } from '../db/database.js';
import { sendData, sendError } from '../http/envelope.js';
import { calculateEconomics, createRecommendation, detectOverlaps, rankRecommendations,
  type EconomicsInput, type ExtrapolationRule, type RankedRecommendation, type Recommendation } from '../reporting/economics.js';

const MAX_FINDINGS = 50;
const ALLOWED_BODY_KEYS = new Set(['dataset_id', 'job_id', 'finding_ids', 'economics']);
const ALLOWED_ECONOMICS_KEYS = new Set(['implementation_cost_inr', 'recurring_cost_inr', 'recurring_cost_period_months',
  'projection_period_days', 'projection_period_months', 'extrapolation', 'supported_gross_recurring_savings_inr_per_month']);
type Json = Record<string, unknown>;

interface ValidEconomics {
  implementation_cost_inr: number | null;
  recurring_cost_inr: number | null;
  recurring_cost_period_months: number | null;
  projection_period_days: number | null;
  projection_period_months: number | null;
  extrapolation: ExtrapolationRule | null;
  supported_gross_recurring_savings_inr_per_month: number | null;
}

function object(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validAmount(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function optionalAmount(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (!validAmount(value)) throw new ReportInputError(`${field} must be finite and nonnegative`, field);
  return value;
}
class ReportInputError extends Error {
  constructor(message: string, readonly field?: string, readonly code: 'VALIDATION_ERROR' | 'UNSUPPORTED_INPUT' = 'VALIDATION_ERROR') { super(message); }
}

function parseEconomics(value: unknown): ValidEconomics {
  if (value === undefined) return { implementation_cost_inr: null, recurring_cost_inr: null,
    recurring_cost_period_months: null, projection_period_days: null, projection_period_months: null,
    extrapolation: null, supported_gross_recurring_savings_inr_per_month: null };
  if (!object(value)) throw new ReportInputError('economics must be an object', 'economics');
  if (Object.keys(value).some((key) => !ALLOWED_ECONOMICS_KEYS.has(key))) {
    throw new ReportInputError('economics contains unsupported fields', 'economics');
  }
  const days = value.projection_period_days;
  const months = value.projection_period_months;
  if ((days === undefined) !== (months === undefined)) throw new ReportInputError('projection_period_days and projection_period_months must be supplied together', 'economics');
  if (days !== undefined && (typeof days !== 'number' || !Number.isFinite(days) || days <= 0)) throw new ReportInputError('projection_period_days must be finite and positive', 'economics.projection_period_days');
  if (months !== undefined && (typeof months !== 'number' || !Number.isFinite(months) || months <= 0)) throw new ReportInputError('projection_period_months must be finite and positive', 'economics.projection_period_months');
  if (typeof days === 'number' && typeof months === 'number' && Math.abs(months - days / 30) > Math.max(1e-9, days / 30 * 1e-9)) {
    throw new ReportInputError('projection_period_months must equal projection_period_days / 30', 'economics.projection_period_months');
  }
  const recurring = optionalAmount(value.recurring_cost_inr, 'economics.recurring_cost_inr');
  const recurringPeriod = value.recurring_cost_period_months;
  if ((recurring === null) !== (recurringPeriod === undefined)) throw new ReportInputError('recurring_cost_inr and recurring_cost_period_months must be supplied together', 'economics.recurring_cost_period_months');
  if (recurringPeriod !== undefined && (typeof recurringPeriod !== 'number' || !Number.isFinite(recurringPeriod) || recurringPeriod <= 0)) {
    throw new ReportInputError('recurring_cost_period_months must be finite and positive', 'economics.recurring_cost_period_months');
  }
  let extrapolation: ExtrapolationRule | null = null;
  if (value.extrapolation !== undefined) {
    if (!object(value.extrapolation) || Object.keys(value.extrapolation).some((key) => !['source_period_days', 'multiplier', 'assumption'].includes(key))) {
      throw new ReportInputError('extrapolation must contain source_period_days, multiplier and assumption only', 'economics.extrapolation');
    }
    const rule = value.extrapolation;
    if (typeof rule.source_period_days !== 'number' || !Number.isFinite(rule.source_period_days) || rule.source_period_days <= 0
      || !validAmount(rule.multiplier) || typeof rule.assumption !== 'string' || !rule.assumption.trim()) {
      throw new ReportInputError('extrapolation requires a positive source period, nonnegative multiplier and written assumption', 'economics.extrapolation');
    }
    extrapolation = { source_period_days: rule.source_period_days, multiplier: rule.multiplier, assumption: rule.assumption.trim() };
  }
  const grossRecurring = optionalAmount(value.supported_gross_recurring_savings_inr_per_month,
    'economics.supported_gross_recurring_savings_inr_per_month');
  return { implementation_cost_inr: optionalAmount(value.implementation_cost_inr, 'economics.implementation_cost_inr'),
    recurring_cost_inr: recurring, recurring_cost_period_months: recurringPeriod === undefined ? null : recurringPeriod,
    projection_period_days: days === undefined ? null : days, projection_period_months: months === undefined ? null : months,
    extrapolation, supported_gross_recurring_savings_inr_per_month: grossRecurring };
}

function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function evidenceError(res: Parameters<typeof sendError>[0], error: ReportInputError): void {
  sendError(res, error.code === 'UNSUPPORTED_INPUT' ? 422 : 422,
    { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
}

type CompleteReportSnapshot = ReportEvidenceSnapshot & {
  dataset: NonNullable<ReportEvidenceSnapshot['dataset']>;
  job: NonNullable<ReportEvidenceSnapshot['job']>;
};

function prepare(snapshot: CompleteReportSnapshot, economics: ValidEconomics) {
  const findings = snapshot.findings;
  const unsupported = findings.find(({ details }) => details.finding_type !== 'vacant_but_on'
    || typeof details.avoidable_energy_kwh !== 'number' || !Number.isFinite(details.avoidable_energy_kwh)
    || !object(details.observed) || details.observed.unit !== 'kWh'
    || typeof details.device_id !== 'string' || typeof details.room_id !== 'string'
    || typeof details.window_start_utc !== 'string' || typeof details.window_end_utc !== 'string'
    || typeof details.method !== 'string' || typeof details.assumptions !== 'string');
  if (unsupported) throw new ReportInputError('Selected finding is not a supported persisted vacancy energy finding', 'finding_ids', 'UNSUPPORTED_INPUT');

  const recommendations: Recommendation[] = findings.map(({ details }) => createRecommendation({
    recommendation_id: String(details.finding_id),
    suggested_action: String(details.suggested_action ?? 'Review the persisted vacancy finding'),
    evidence_type: 'vacancy_estimate', method: String(details.method),
    references: [{ dataset_id: snapshot.dataset.dataset_id, run_id: snapshot.dataset.run_id, job_id: snapshot.job.job_id,
      finding_id: String(details.finding_id), device_id: String(details.device_id), room_id: String(details.room_id),
      start_utc: String(details.window_start_utc), end_utc: String(details.window_end_utc) }],
    assumptions: [String(details.assumptions)], coverage_limitations: [String(details.resolution_limit ?? 'Finding resolution limits apply')],
    synthetic: snapshot.dataset.synthetic, savings_estimate_kwh: Number(details.avoidable_energy_kwh),
    savings_period_days: (Date.parse(String(details.window_end_utc)) - Date.parse(String(details.window_start_utc))) / 86_400_000,
    savings_basis: `${String(details.finding_id)} persisted avoidable_energy_kwh`,
  }));
  const overlapPairs = detectOverlaps(recommendations);
  const overlapById = new Map<string, string>();
  for (const pair of overlapPairs) {
    const left = pair[0]!; const right = pair[1]!;
    const group = [left, right].sort().join('|'); overlapById.set(left, group); overlapById.set(right, group);
  }
  const assumptionFingerprint = createHash('sha256').update(JSON.stringify({ economics, tariff: snapshot.tariff_inr_per_kwh })).digest('hex');
  const results = recommendations.map((recommendation) => {
    const reference = recommendation.references[0]!;
    const sourceDays = recommendation.savings_period_days!;
    const projectionDays = economics.projection_period_days ?? sourceDays;
    // The module accepts days and months to enforce comparable ranking bases. When the
    // user does not provide an economics horizon, this is only a derived unit conversion.
    const projectionMonths = economics.projection_period_months ?? projectionDays / 30;
    const input: EconomicsInput = { supported_energy_reduction_kwh: recommendation.savings_estimate_kwh,
      source_period_days: sourceDays, projection_period_days: projectionDays, projection_period_months: projectionMonths,
      tariff_inr_per_kwh: snapshot.tariff_inr_per_kwh, implementation_cost_inr: economics.implementation_cost_inr,
      recurring_cost_inr: economics.recurring_cost_inr, recurring_cost_period_months: economics.recurring_cost_period_months,
      extrapolation: economics.extrapolation,
      supported_gross_recurring_savings_inr_per_month: economics.supported_gross_recurring_savings_inr_per_month };
    const result = calculateEconomics(input);
    const rankInput: RankedRecommendation = { recommendation_id: recommendation.recommendation_id,
      savings_supported: true, simple_payback_months: result.simple_payback_months,
      upfront_cost_inr: result.implementation_cost_inr, projection_period_days: projectionDays,
      projection_period_months: projectionMonths, currency: 'INR', assumptions_fingerprint: assumptionFingerprint,
      overlap_group: overlapById.get(recommendation.recommendation_id) ?? null };
    return { recommendation, economics: result, rankInput, calculation_input: input, evidence_ref: reference };
  });
  const ranking = rankRecommendations(results.map((item) => item.rankInput));
  return { results, overlapPairs, ranking };
}

export function reportsRouter(database: AuditorDatabase): Router {
  const router = Router();
  router.post('/reports/preview', (req, res) => {
    if (!object(req.body) || Object.keys(req.body).some((key) => !ALLOWED_BODY_KEYS.has(key))) {
      sendError(res, 422, { code: 'VALIDATION_ERROR', message: 'Body must contain dataset_id, job_id, finding_ids and optional economics only' }); return;
    }
    const { dataset_id: datasetId, job_id: jobId, finding_ids: findingIds } = req.body;
    if (!validIdentity(datasetId)) { sendError(res, 422, { code: 'VALIDATION_ERROR', message: 'dataset_id is required', field: 'dataset_id' }); return; }
    if (!validIdentity(jobId)) { sendError(res, 422, { code: 'VALIDATION_ERROR', message: 'job_id is required', field: 'job_id' }); return; }
    if (!Array.isArray(findingIds) || findingIds.length < 1 || findingIds.length > MAX_FINDINGS
      || findingIds.some((id) => !validIdentity(id)) || new Set(findingIds).size !== findingIds.length) {
      sendError(res, 422, { code: 'VALIDATION_ERROR', message: `finding_ids must contain 1-${MAX_FINDINGS} unique persisted finding IDs`, field: 'finding_ids' }); return;
    }
    let assumptions: ValidEconomics;
    try { assumptions = parseEconomics(req.body.economics); }
    catch (error) { evidenceError(res, error instanceof ReportInputError ? error : new ReportInputError('Invalid economics assumptions', 'economics')); return; }

    const snapshot = database.getReportEvidenceSnapshot(datasetId, jobId, findingIds);
    if (!snapshot?.dataset) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return; }
    if (!snapshot.job) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Analysis job was not found' }); return; }
    if (snapshot.job.dataset_id !== datasetId) { sendError(res, 422, { code: 'VALIDATION_ERROR', message: 'Analysis job does not belong to dataset_id', field: 'job_id' }); return; }
    if (snapshot.job.job_type !== 'analysis' || snapshot.job.status !== 'completed') {
      sendError(res, 422, { code: 'UNSUPPORTED_INPUT', message: 'A completed analysis job is required', field: 'job_id' }); return;
    }
    if (snapshot.job.method !== 'rule' || snapshot.job.method_version !== 'vacant-beyond-grace-v1'
      || (snapshot.job.request.detector !== undefined && snapshot.job.request.detector !== 'vacancy')) {
      sendError(res, 422, { code: 'UNSUPPORTED_INPUT', message: 'Only completed vacancy analysis jobs support avoidable-energy reports', field: 'job_id' }); return;
    }
    if (snapshot.findings.length !== findingIds.length) {
      sendError(res, 404, { code: 'NOT_FOUND', message: 'One or more finding IDs were not found in this dataset and job', field: 'finding_ids' }); return;
    }
    try {
      const { results, overlapPairs, ranking } = prepare(snapshot as CompleteReportSnapshot, assumptions);
      const generatedUtc = new Date().toISOString();
      sendData(res, { dataset_id: datasetId, run_id: snapshot.dataset.run_id, job_id: jobId,
        evidence: { source: 'persisted_completed_vacancy_findings', synthetic: snapshot.dataset.synthetic,
          synthetic_label: snapshot.dataset.synthetic_label, coverage: { start_utc: snapshot.dataset.start_utc,
            end_utc: snapshot.dataset.end_utc }, finding_count: results.length },
        tariff: { inr_per_kwh: snapshot.tariff_inr_per_kwh, currency: snapshot.tariff_currency,
          provenance: snapshot.tariff_currency === null ? 'unset' : 'current_saved_local_tariff' },
        generated_utc: generatedUtc,
        recommendations: results.map(({ recommendation, economics, calculation_input, evidence_ref }) => ({
          recommendation_id: recommendation.recommendation_id, suggested_action: recommendation.suggested_action,
          evidence_type: recommendation.evidence_type, method: recommendation.method,
          evidence: { reference: evidence_ref, finding_assumptions: recommendation.assumptions,
            coverage_limitations: recommendation.coverage_limitations, synthetic: recommendation.synthetic,
            avoidable_energy_kwh: recommendation.savings_estimate_kwh,
            source_period_days: recommendation.savings_period_days, savings_basis: recommendation.savings_basis,
            energy_provenance: 'measured_and_derived_from_persisted_finding' },
          economics: { ...economics, currency: 'INR', tariff_inr_per_kwh: snapshot.tariff_inr_per_kwh,
            calculation_input, assumptions_provenance: assumptions.projection_period_days === null
              && assumptions.implementation_cost_inr === null && assumptions.recurring_cost_inr === null
              && assumptions.supported_gross_recurring_savings_inr_per_month === null
              ? 'no_user_economics_assumptions' : 'user_supplied_economics_assumptions' },
          overlap_excluded_from_ranking: overlapPairs.some((pair) => pair.includes(recommendation.recommendation_id)),
        })),
        ranking: { ...ranking, meaning: 'Only comparable recommendations with supported payback and known upfront cost are ranked; this is not a verified outcome.' },
        overlap_conflicts: overlapPairs.map((ids) => ({ recommendation_ids: ids,
          handling: 'Individual evidence is shown; conflicting recommendations are excluded from ranking and are not summed.' })),
        scenario_comparison: { status: 'unverified', reason: 'Persisted external-input provenance does not establish matched scenarios' },
      });
    } catch (error) {
      if (error instanceof ReportInputError) evidenceError(res, error);
      else if (error instanceof RangeError) sendError(res, 422, { code: 'VALIDATION_ERROR', message: error.message, field: 'economics' });
      else throw error;
    }
  });
  return router;
}
