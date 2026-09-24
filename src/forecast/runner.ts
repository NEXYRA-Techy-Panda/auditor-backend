import type { AnalysisDatasetMeta, AnalysisPolicyMeta, AuditorDatabase, ForecastRecordInput, StoredAnalysisInterval } from '../db/database.js';
import { PythonAnalysisClient, PythonServiceError } from '../analysis/client.js';
import type { JsonRecord } from '../analysis/types.js';

export const FORECAST_BASELINE_VERSION = 'hourly-profile-median-v1';
export const FORECAST_HORIZONS = ['next_24h', 'next_7d', 'next_calendar_month'] as const;
export type ForecastHorizon = typeof FORECAST_HORIZONS[number];
const HOUR_MS = 3_600_000;
const MAX_HISTORY_HOURS = 2_160;
const IST_OFFSET_MS = 330 * 60_000;
const SUPPORTED_TIMEZONE = 'Asia/Kolkata';

export class ForecastInputError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'UNSUPPORTED_INPUT', message: string, readonly field?: string) { super(message); }
}

export interface ForecastHistoryPoint { start_utc: string; energy_kwh: number; }
export interface ForecastHistoryBuild {
  points: ForecastHistoryPoint[];
  coverage: JsonRecord;
}

function iso(ms: number): string { return new Date(ms).toISOString().replace('.000Z', 'Z'); }
function validUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && iso(time) === value;
}
function localHourStart(ms: number): number { return Math.floor((ms + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS; }
function ceilLocalHour(ms: number): number { return Math.ceil((ms + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS; }

export function resolveForecastOrigin(meta: AnalysisDatasetMeta, requested?: unknown): string {
  if (meta.timezone !== SUPPORTED_TIMEZONE) {
    throw new ForecastInputError('UNSUPPORTED_INPUT', `Forecasting currently supports ${SUPPORTED_TIMEZONE}; dataset timezone is ${meta.timezone}`, 'timezone');
  }
  const origin = requested === undefined ? iso(ceilLocalHour(Date.parse(meta.end_utc))) : requested;
  if (!validUtc(origin)) throw new ForecastInputError('VALIDATION_ERROR', 'origin_utc must be a real UTC timestamp with second precision', 'origin_utc');
  const time = Date.parse(origin);
  if (localHourStart(time) !== time) throw new ForecastInputError('VALIDATION_ERROR', 'origin_utc must align to a local clock hour in Asia/Kolkata (UTC minute :30)', 'origin_utc');
  if (time < Date.parse(meta.end_utc)) throw new ForecastInputError('VALIDATION_ERROR', 'origin_utc cannot precede the end of the imported dataset', 'origin_utc');
  return origin;
}

export function buildCompleteHourlyHistory(deviceIds: string[], rows: StoredAnalysisInterval[], datasetStartUtc: string,
  originUtc: string, maxHours = MAX_HISTORY_HOURS): ForecastHistoryBuild {
  const origin = Date.parse(originUtc);
  const start = Math.max(origin - maxHours * HOUR_MS, localHourStart(Date.parse(datasetStartUtc)));
  const count = Math.max(0, Math.floor((origin - start) / HOUR_MS));
  const slots = Array.from({ length: count }, (_, index) => ({
    start: start + index * HOUR_MS,
    deviceRows: new Map(deviceIds.map((id) => [id, [] as StoredAnalysisInterval[]])),
    blocked: new Map(deviceIds.map((id) => [id, new Set<string>()])),
  }));
  const indexFor = (slotStart: number) => Math.floor((slotStart - start) / HOUR_MS);
  for (const row of rows) {
    const deviceId = String(row.device_id ?? '');
    if (!deviceIds.includes(deviceId)) continue;
    const rowStart = Date.parse(row.interval_start_utc);
    const rowEnd = Date.parse(row.interval_end_utc);
    const energy = Number(row.energy_kwh);
    if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd) || rowEnd <= rowStart
      || !Number.isFinite(energy) || energy < 0) {
      throw new ForecastInputError('UNSUPPORTED_INPUT', `Stored energy interval for ${deviceId} is invalid`);
    }
    if (rowStart >= origin || rowEnd <= start) continue;
    for (let slotStart = localHourStart(Math.max(rowStart, start)); slotStart < Math.min(rowEnd, origin); slotStart += HOUR_MS) {
      const index = indexFor(slotStart);
      if (index < 0 || index >= slots.length) continue;
      const slot = slots[index]!;
      const slotEnd = slotStart + HOUR_MS;
      if (rowStart < slotStart || rowEnd > slotEnd) slot.blocked.get(deviceId)!.add('CROSSING_HOUR_INTERVAL');
      else slot.deviceRows.get(deviceId)!.push(row);
    }
  }

  const result: ForecastHistoryPoint[] = [];
  const reasons: Record<string, number> = {};
  let trailingIncompleteHours = 0;
  let foundCompleteFromEnd = false;
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]!;
    const energyByDevice = new Map<string, number>();
    let reason: string | undefined;
    if (deviceIds.length === 0) reason = 'NO_EXPECTED_DEVICES';
    for (const deviceId of deviceIds) {
      if (slot.blocked.get(deviceId)!.has('CROSSING_HOUR_INTERVAL')) { reason ??= 'CROSSING_HOUR_INTERVAL'; continue; }
      const segments = slot.deviceRows.get(deviceId)!.slice().sort((a, b) => Date.parse(a.interval_start_utc) - Date.parse(b.interval_start_utc));
      let cursor = slot.start;
      let energy = 0;
      let overlap = false;
      for (const segment of segments) {
        const segmentStart = Date.parse(segment.interval_start_utc);
        const segmentEnd = Date.parse(segment.interval_end_utc);
        if (segmentStart > cursor) reason ??= 'MISSING_DEVICE_COVERAGE';
        if (segmentStart < cursor) { overlap = true; reason ??= 'OVERLAPPING_DEVICE_INTERVALS'; }
        if (!overlap) energy += Number(segment.energy_kwh);
        cursor = Math.max(cursor, segmentEnd);
      }
      if (cursor < slot.start + HOUR_MS) reason ??= 'MISSING_DEVICE_COVERAGE';
      if (!reason && !overlap) energyByDevice.set(deviceId, energy);
    }
    if (!reason && energyByDevice.size === deviceIds.length) {
      const total = [...energyByDevice.values()].reduce((sum, value) => sum + value, 0);
      result.push({ start_utc: iso(slot.start), energy_kwh: total });
      foundCompleteFromEnd = true;
    } else {
      reason ??= 'MISSING_DEVICE_COVERAGE';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (!foundCompleteFromEnd) trailingIncompleteHours++;
    }
  }
  result.reverse();
  const first = result[0];
  const last = result.at(-1);
  const lastEnd = last ? Date.parse(last.start_utc) + HOUR_MS : null;
  const gapBeforeOriginHours = lastEnd === null ? null : Math.max(0, Math.round((origin - lastEnd) / HOUR_MS));
  return { points: result, coverage: {
    timezone: SUPPORTED_TIMEZONE, maximum_history_hours: maxHours, candidate_hours: slots.length,
    observed_complete_hours: result.length, incomplete_hours: slots.length - result.length,
    trailing_incomplete_hours: trailingIncompleteHours,
    incomplete_hours_by_reason: reasons,
    observed_start_utc: first?.start_utc ?? null,
    observed_end_utc: lastEnd === null ? null : iso(lastEnd),
    gap_before_origin_hours: gapBeforeOriginHours,
  } };
}

function calendarPolicyForPython(policy: AnalysisPolicyMeta): JsonRecord {
  return { policy_id: policy.policy_id, version: policy.version, kind: policy.kind,
    rules: policy.rules, applies_to: policy.applies_to, effective_from_utc: policy.effective_from_utc };
}

function expectedHorizon(horizon: ForecastHorizon, origin: string): { start: number; end: number } {
  const originMs = Date.parse(origin);
  if (horizon === 'next_24h') return { start: originMs, end: originMs + 24 * HOUR_MS };
  if (horizon === 'next_7d') return { start: originMs, end: originMs + 168 * HOUR_MS };
  const local = new Date(originMs + IST_OFFSET_MS);
  const year = local.getUTCFullYear(); const month = local.getUTCMonth();
  const start = Date.UTC(year, month + 1, 1) - IST_OFFSET_MS;
  const end = Date.UTC(year, month + 2, 1) - IST_OFFSET_MS;
  return { start, end };
}

export function validatePythonForecast(data: JsonRecord, horizon: ForecastHorizon, origin: string, historyCount: number): JsonRecord {
  const bounds = expectedHorizon(horizon, origin);
  const points = data.points;
  const expectedCount = (bounds.end - bounds.start) / HOUR_MS;
  const minimumHistoryHours = horizon === 'next_24h' ? 168 : horizon === 'next_7d' ? 336 : 672;
  if (data.horizon !== horizon || data.origin_utc !== origin || data.baseline_version !== FORECAST_BASELINE_VERSION
    || data.method !== 'statistical_baseline' || data.model_version !== null || data.timezone !== SUPPORTED_TIMEZONE
    || data.horizon_start_utc !== iso(bounds.start) || data.horizon_end_utc !== iso(bounds.end)
    || data.uncertainty !== 'unavailable' || !Array.isArray(points) || points.length !== expectedCount
    || !Array.isArray(data.warnings) || !Array.isArray(data.limitations) || !Array.isArray(data.assumptions)
    || !data.assumptions_recorded || typeof data.assumptions_recorded !== 'object' || Array.isArray(data.assumptions_recorded)
    || !data.history_coverage || typeof data.history_coverage !== 'object' || Array.isArray(data.history_coverage)) {
    throw new PythonServiceError('malformed', undefined, 'forecast');
  }
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point || typeof point !== 'object' || Array.isArray(point)) throw new PythonServiceError('malformed', undefined, 'forecast');
    const row = point as Record<string, unknown>;
    const energy = Number(row.energy_kwh);
    if (row.start_utc !== iso(bounds.start + i * HOUR_MS) || !Number.isFinite(energy) || energy < 0
      || !Number.isInteger(row.support) || Number(row.support) < 1
      || !['weekday_hour', 'day_class_hour', 'hour_of_day'].includes(String(row.basis))) {
      throw new PythonServiceError('malformed', undefined, 'forecast');
    }
    sum += energy;
  }
  const total = Number(data.total_energy_kwh);
  const coverage = data.history_coverage as Record<string, unknown>;
  if (!Number.isFinite(total) || total < 0 || Math.abs(sum - total) > Math.max(1e-9, Math.abs(sum) * 1e-12)
    || coverage.observed_hours !== historyCount || historyCount < minimumHistoryHours
    || coverage.min_observed_hours_required !== minimumHistoryHours) {
    throw new PythonServiceError('malformed', undefined, 'forecast');
  }
  return data;
}

export interface ForecastExecution { result: JsonRecord; record: Omit<ForecastRecordInput, 'forecastId' | 'jobId' | 'result'>; }

export class ForecastRunner {
  constructor(private readonly database: AuditorDatabase, private readonly python: PythonAnalysisClient) {}

  resolveOrigin(datasetId: string, requested?: unknown): { meta: AnalysisDatasetMeta; originUtc: string } {
    const meta = this.database.getAnalysisDatasetMeta(datasetId);
    if (!meta) throw new ForecastInputError('VALIDATION_ERROR', 'Dataset was not found', 'dataset_id');
    return { meta, originUtc: resolveForecastOrigin(meta, requested) };
  }

  async run(datasetId: string, horizon: ForecastHorizon, originUtc: string): Promise<ForecastExecution> {
    const { meta } = this.resolveOrigin(datasetId, originUtc);
    const policy = this.database.getForecastCalendarPolicy(datasetId, originUtc);
    if (!policy) throw new ForecastInputError('UNSUPPORTED_INPUT', `No office-hours policy is effective at forecast origin ${originUtc}`, 'calendar');
    const rules = policy.rules;
    if (!Array.isArray(rules.working_days_iso) || typeof rules.open_local !== 'string' || typeof rules.close_local !== 'string'
      || typeof rules.overnight !== 'boolean') {
      throw new ForecastInputError('UNSUPPORTED_INPUT', 'The office-hours policy effective at the forecast origin is incomplete', 'calendar');
    }
    const deviceIds = this.database.getForecastDeviceIds(datasetId);
    const historyStart = Math.max(Date.parse(originUtc) - MAX_HISTORY_HOURS * HOUR_MS, localHourStart(Date.parse(meta.start_utc)));
    const history = buildCompleteHourlyHistory(deviceIds,
      this.database.getForecastDeviceIntervals(datasetId, iso(historyStart), originUtc), meta.start_utc, originUtc);
    const payload: JsonRecord = {
      contract_version: '1.0.1', dataset_id: datasetId, origin_utc: originUtc, horizon,
      history_hourly_kwh: history.points,
      calendar: { timezone: meta.timezone, working_days_iso: rules.working_days_iso,
        open_local: rules.open_local, close_local: rules.close_local, overnight: rules.overnight },
      future_assumptions: { schedule: calendarPolicyForPython(policy) },
      model: { version: FORECAST_BASELINE_VERSION },
    };
    const response = validatePythonForecast(await this.python.forecast(payload), horizon, originUtc, history.points.length);
    const bounds = expectedHorizon(horizon, originUtc);
    const warnings = [...response.warnings as JsonRecord[]];
    if (Number(history.coverage.incomplete_hours) > 0) {
      const reasonText = Object.entries(history.coverage.incomplete_hours_by_reason as Record<string, number>)
        .map(([reason, count]) => `${reason}: ${count}`).join(', ');
      warnings.push({ code: 'INCOMPLETE_HISTORY_HOURS', message: `${history.coverage.incomplete_hours} local hour(s) were omitted because complete, non-overlapping energy coverage for every expected device was unavailable (${reasonText}).` });
    }
    if (Number(history.coverage.gap_before_origin_hours) > 0) {
      warnings.push({ code: 'GAP_BEFORE_ORIGIN', message: `${history.coverage.gap_before_origin_hours} local hour(s) separate the last complete observed history hour from the forecast origin; no missing energy was filled with zero.` });
    }
    const result: JsonRecord = {
      ...response, dataset_id: datasetId, synthetic: meta.synthetic, synthetic_label: meta.synthetic_label,
      office_hours_policy: { policy_id: policy.policy_id, version: policy.version, effective_from_utc: policy.effective_from_utc },
      history_coverage: { ...(response.history_coverage as JsonRecord), ...history.coverage },
      warnings,
    };
    const points = response.points as JsonRecord[];
    const assumptions = { calendar: payload.calendar, future_assumptions: payload.future_assumptions,
      model: payload.model, history_coverage: history.coverage };
    return { result, record: {
      datasetId, horizon, originUtc, horizonStartUtc: iso(bounds.start), horizonEndUtc: iso(bounds.end),
      energyKwh: Number(response.total_energy_kwh), method: String(response.method),
      baselineVersion: String(response.baseline_version), modelVersion: null, timezone: meta.timezone,
      synthetic: meta.synthetic, syntheticLabel: meta.synthetic_label, points, assumptions,
      historyStartUtc: (history.coverage.observed_start_utc as string | null),
      historyEndUtc: (history.coverage.observed_end_utc as string | null),
    } };
  }
}
