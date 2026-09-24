import { aggregateSection, resolutionCandidates, type AggregationReport } from './aggregate.js';
import { AnalysisScopeError, deviceIntervalForPython, roomIntervalForPython } from './batches.js';
import type { PythonAnalysisClient } from './client.js';
import type { AnalysisDeviceMeta, AnalysisPolicyMeta, AnalysisRoomMeta, AuditorDatabase, StoredAnalysisInterval } from '../db/database.js';
import type { JsonRecord } from './types.js';

/**
 * P026 — Node integration for the two additive Python detectors.
 *
 * Python exposes POST /v1/anomalies (P022, `excess-power-mad-v1`) and
 * POST /v1/drift (P024, `gradual-power-trend-v1`). Both take an earlier
 * `reference` section and a later `evaluation` section, each capped at 2,000
 * device and 2,000 room intervals, and neither aggregates nor stitches.
 *
 * This module selects both sections from the auditor's own persisted readings,
 * keeps each device's reference baseline fixed across evaluation batches,
 * aggregates only when the stored resolution cannot fit the bound (see
 * aggregate.ts) and reports every exclusion instead of guessing. It never
 * zero-fills missing readings, never multiplies group power by quantity and
 * never uses fault labels (the auditor does not store them).
 */

/** Python's per-section bound (`MAX_DEVICE_INTERVALS_PER_SECTION` / room equivalent). */
export const MAX_SECTION_RECORDS = 2000;
/** P015-compatible result caps: overflow fails the job instead of truncating silently. */
export const MAX_DETECTOR_FINDINGS = 100_000;
const MAX_DETECTOR_WARNINGS = 100_000;
const MAX_LISTED_EXCLUSIONS = 2_000;
const MAX_EVALUATION_BATCHES_PER_DEVICE = 64;

export type DetectorId = 'excess_consumption' | 'gradual_trend';

export interface DetectorDefinition {
  id: DetectorId;
  label: string;
  method: 'rule';
  /** Python detector version, sent in `detector.version` and stored as method_version. */
  detector_version: string;
  technique: string;
  finding_type: string;
  path: '/v1/anomalies' | '/v1/drift';
  request_format: string;
  /** Frozen detector requirements, mirrored from the Python evidence. */
  requirements: string[];
  /** Python cannot stitch temporal support, so the evaluation section is never split. */
  single_evaluation_section: boolean;
}

export const DETECTORS: Record<DetectorId, DetectorDefinition> = {
  excess_consumption: {
    id: 'excess_consumption', label: 'Excess-consumption deviation versus an earlier comparable reference',
    method: 'rule', detector_version: 'excess-power-mad-v1', technique: 'robust_median_mad',
    finding_type: 'excess_consumption_deviation', path: '/v1/anomalies', request_format: 'excess-power-request-v1',
    requirements: [
      'Fully-on intervals only (on_fraction == 1); off, mixed-duty, duty-unknown and partial intervals are excluded.',
      'At least 12 comparable reference intervals spanning at least 2 hours.',
      'Comfort-dependent devices (ac, refrigerator) need room temperature and occupancy context.',
    ],
    single_evaluation_section: false,
  },
  gradual_trend: {
    id: 'gradual_trend', label: 'Sustained gradual upward power trend under matched observed conditions',
    method: 'rule', detector_version: 'gradual-power-trend-v1', technique: 'theil_sen_context_normalised_daily',
    finding_type: 'sustained_upward_power_trend', path: '/v1/drift', request_format: 'drift-request-v1',
    requirements: [
      'Fully-on intervals only, one resolution and one configuration (policy_ref) per device.',
      'Reference: at least 5 supported days spanning at least 7 days.',
      'Evaluation: at least 10 supported days over at least 14 days with 50% calendar-day coverage; a supported day needs 3 comparable observations and 1 hour fully on.',
    ],
    single_evaluation_section: true,
  },
};

export function isDetectorId(value: unknown): value is DetectorId {
  return value === 'excess_consumption' || value === 'gradual_trend';
}

export interface SectionData {
  device_records: JsonRecord[];
  room_records: JsonRecord[];
  /** Null when the stored resolution itself was sent (no aggregation). */
  aggregation: AggregationReport | null;
}

export interface DetectorWindows { start_utc: string; end_utc: string; }

export interface DevicePlan {
  device_id: string;
  room_id: string;
  device_type: string;
  /** Null when the device could not be assessed (see `problem`). */
  resolution_seconds: number | null;
  reference: SectionData | null;
  evaluation_batches: SectionData[];
  policies: JsonRecord[];
  /** Node-side structural reason; no Python call is made for a planned problem. */
  problem?: string;
}

export interface RunDetectorOptions {
  onProgress?: (progress: { completed: number; total: number; coverage: { start_utc: string; end_utc: string } | null }) => Promise<void> | void;
}

export interface DetectorRunResult { result: JsonRecord; findings: JsonRecord[]; batches: number; }

function sectionRows(rows: StoredAnalysisInterval[], window: DetectorWindows): StoredAnalysisInterval[] {
  const start = Date.parse(window.start_utc);
  const end = Date.parse(window.end_utc);
  return rows.filter((row) => Date.parse(row.interval_start_utc) >= start && Date.parse(row.interval_end_utc) <= end);
}

function buildSection(deviceRows: StoredAnalysisInterval[], roomRows: StoredAnalysisInterval[], resolutionSeconds: number,
  storedIntervalSeconds: number, window: DetectorWindows): SectionData {
  if (resolutionSeconds === storedIntervalSeconds) {
    const device_records = deviceRows.map(deviceIntervalForPython);
    const starts = new Set(device_records.map((record) => String(record.interval_start_utc)));
    // Room context is only usable (and only meaningful) at a submitted device interval start.
    const room_records = roomRows.filter((row) => starts.has(row.interval_start_utc)).map(roomIntervalForPython);
    return { device_records, room_records, aggregation: null };
  }
  const aggregated = aggregateSection({ deviceRows, roomRows, resolutionSeconds, storedIntervalSeconds,
    windowStartUtc: window.start_utc, windowEndUtc: window.end_utc });
  return { device_records: aggregated.device_intervals, room_records: aggregated.room_intervals, aggregation: aggregated.report };
}

/** Splits an evaluation section only when the detector tolerates a fixed reference across batches. */
function splitEvaluation(section: SectionData, maxRecords: number, allowSplit: boolean): SectionData[] | null {
  if (section.device_records.length <= maxRecords && section.room_records.length <= maxRecords) return [section];
  if (!allowSplit) return null;
  const batches: SectionData[] = [];
  for (let offset = 0; offset < section.device_records.length; offset += maxRecords) {
    const records = section.device_records.slice(offset, offset + maxRecords);
    const first = String(records[0]!.interval_start_utc);
    const last = String(records.at(-1)!.interval_end_utc);
    const rooms = section.room_records.filter((record) => String(record.interval_start_utc) >= first && String(record.interval_start_utc) < last);
    if (records.length > maxRecords || rooms.length > maxRecords) return null;
    batches.push({ device_records: records, room_records: rooms, aggregation: section.aggregation });
  }
  return batches.length === 0 || batches.length > MAX_EVALUATION_BATCHES_PER_DEVICE ? null : batches;
}

function policyRefs(sections: Array<SectionData | null>): Array<{ id: string; version: number }> {
  const refs = new Map<string, { id: string; version: number }>();
  for (const section of sections) {
    for (const record of section?.device_records ?? []) {
      const [id, rawVersion] = String(record.policy_ref).split(':');
      if (!id || !/^\d+$/.test(rawVersion ?? '')) throw new AnalysisScopeError('INSUFFICIENT_DATA', 'A stored policy reference is malformed');
      refs.set(`${id}:${rawVersion}`, { id, version: Number(rawVersion) });
    }
  }
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}

/**
 * Selects the sections a device can be assessed from, reusing the auditor's
 * persisted readings. The finest resolution that fits Python's bound is used,
 * so the stored resolution itself is sent whenever it fits (no aggregation).
 */
export class DeviceDetectorRunner {
  constructor(private readonly database: AuditorDatabase, private readonly python: PythonAnalysisClient,
    private readonly maxSectionRecords: number = MAX_SECTION_RECORDS,
    private readonly maxFindings: number = MAX_DETECTOR_FINDINGS) {}

  plan(datasetId: string, detector: DetectorId, reference: DetectorWindows, evaluation: DetectorWindows): DevicePlan[] {
    const definition = DETECTORS[detector];
    const meta = this.database.getAnalysisDatasetMeta(datasetId);
    if (!meta) throw new AnalysisScopeError('VALIDATION_ERROR', 'Dataset was not found');
    const ranges = this.database.getAnalysisDeviceIds(datasetId, evaluation.start_utc, evaluation.end_utc);
    if (!ranges.length) throw new AnalysisScopeError('INSUFFICIENT_DATA', 'The requested evaluation window has no device readings');
    const rooms = new Map(this.database.getAnalysisRooms(datasetId, [...new Set(ranges.map((range) => range.room_id))])
      .map((room) => [room.room_id, room]));
    const devices = new Map(this.database.getAnalysisDevices(datasetId, ranges.map((range) => range.device_id))
      .map((device) => [device.device_id, device]));
    const candidates = resolutionCandidates(meta.interval_seconds);
    const plans: DevicePlan[] = [];

    for (const range of ranges) {
      const device = devices.get(range.device_id);
      const plan: DevicePlan = { device_id: range.device_id, room_id: range.room_id,
        device_type: device?.device_type ?? 'unknown', resolution_seconds: null, reference: null,
        evaluation_batches: [], policies: [] };
      plans.push(plan);
      if (!device) { plan.problem = 'Device metadata is missing for this device.'; continue; }
      if (!rooms.has(range.room_id)) { plan.problem = 'Room metadata is missing for this device.'; continue; }
      const deviceReference = sectionRows(this.database.getAnalysisDeviceIntervals(datasetId, range.device_id, reference.start_utc, reference.end_utc), reference);
      const deviceEvaluation = sectionRows(this.database.getAnalysisDeviceIntervals(datasetId, range.device_id, evaluation.start_utc, evaluation.end_utc), evaluation);
      const roomReference = sectionRows(this.database.getAnalysisRoomIntervals(datasetId, range.room_id, reference.start_utc, reference.end_utc), reference);
      const roomEvaluation = sectionRows(this.database.getAnalysisRoomIntervals(datasetId, range.room_id, evaluation.start_utc, evaluation.end_utc), evaluation);
      if (!deviceReference.length || !deviceEvaluation.length) {
        plan.problem = 'The device has no stored readings inside one of the requested windows.';
        continue;
      }

      const problems: string[] = [];
      for (const resolution of candidates) {
        const referenceSection = buildSection(deviceReference, roomReference, resolution, meta.interval_seconds, reference);
        const evaluationSection = buildSection(deviceEvaluation, roomEvaluation, resolution, meta.interval_seconds, evaluation);
        const batches = splitEvaluation(evaluationSection, this.maxSectionRecords, !definition.single_evaluation_section);
        if (referenceSection.device_records.length === 0) {
          problems.push(`${resolution} s: no comparable fully-on reference observations`);
          continue;
        }
        if (evaluationSection.device_records.length === 0) {
          problems.push(`${resolution} s: no comparable fully-on evaluation observations`);
          continue;
        }
        if (referenceSection.device_records.length > this.maxSectionRecords || referenceSection.room_records.length > this.maxSectionRecords) {
          problems.push(`${resolution} s: reference has ${referenceSection.device_records.length} device and ${referenceSection.room_records.length} room records (bound ${this.maxSectionRecords})`);
          continue;
        }
        if (!batches) {
          problems.push(`${resolution} s: evaluation has ${evaluationSection.device_records.length} device and ${evaluationSection.room_records.length} room records and cannot be split without losing the temporal support this detector requires`);
          continue;
        }
        const policies = this.resolvePolicies(datasetId, [referenceSection, evaluationSection]);
        if (typeof policies === 'string') { problems.push(`${resolution} s: ${policies}`); continue; }
        plan.resolution_seconds = resolution;
        plan.reference = referenceSection;
        plan.evaluation_batches = batches;
        plan.policies = policies;
        break;
      }
      if (plan.resolution_seconds === null) {
        plan.problem = problems.length
          ? `${problems[0]}${problems.length > 1 ? `; also ${problems.slice(1).join('; ')}` : ''}. Request a shorter window or a coarser export.`
          : 'No usable resolution is available for this device.';
      }
    }
    return plans;
  }

  /** Policy definitions referenced by the selected sections, including transitive office-hours refs. */
  private resolvePolicies(datasetId: string, sections: SectionData[]): JsonRecord[] | string {
    const refs = policyRefs(sections);
    if (refs.length === 0) return 'no policy reference is available for the selected readings';
    const policies = this.database.getAnalysisPolicies(datasetId, refs);
    if (policies.length !== refs.length) return 'a referenced policy definition is missing from the stored dataset';
    const out = new Map(policies.map((policy) => [`${policy.policy_id}:${policy.version}`, policy]));
    const transitive = new Map<string, { id: string; version: number }>();
    for (const policy of policies) {
      const ref = policy.rules.office_hours_ref;
      if (policy.kind !== 'device_schedule' || typeof ref !== 'string' || out.has(ref)) continue;
      const [id, rawVersion] = ref.split(':');
      if (id && /^\d+$/.test(rawVersion ?? '')) transitive.set(ref, { id, version: Number(rawVersion) });
    }
    for (const policy of this.database.getAnalysisPolicies(datasetId, [...transitive.values()])) {
      out.set(`${policy.policy_id}:${policy.version}`, policy);
    }
    const list = [...out.values()];
    const deviceId = sectionDevice(sections);
    const misapplied = list.find((policy) => policy.applies_to && policy.applies_to !== `device:${deviceId}`);
    if (misapplied) {
      return `policy ${misapplied.policy_id}:${misapplied.version} applies to ${misapplied.applies_to}, and Python requires every policy referenced by a device's intervals to be device-scoped`;
    }
    return list.map(policyForDetector);
  }

  calls(plans: DevicePlan[]): number {
    return plans.reduce((total, plan) => total + plan.evaluation_batches.length, 0);
  }

  async run(datasetId: string, detector: DetectorId, reference: DetectorWindows, evaluation: DetectorWindows,
    options: RunDetectorOptions = {}): Promise<DetectorRunResult> {
    const definition = DETECTORS[detector];
    const meta = this.database.getAnalysisDatasetMeta(datasetId);
    if (!meta) throw new AnalysisScopeError('VALIDATION_ERROR', 'Dataset was not found');
    const plans = this.plan(datasetId, detector, reference, evaluation);
    const total = this.calls(plans);
    const rooms = new Map(this.database.getAnalysisRooms(datasetId, [...new Set(plans.map((plan) => plan.room_id))])
      .map((room) => [room.room_id, room]));
    const devices = new Map(this.database.getAnalysisDevices(datasetId, plans.map((plan) => plan.device_id))
      .map((device) => [device.device_id, device]));
    const findings: JsonRecord[] = [];
    const otherChanges: JsonRecord[] = [];
    const seenFindings = new Set<string>();
    const warnings = new Map<string, JsonRecord>();
    const exclusions: JsonRecord[] = [];
    const devicesOut: JsonRecord[] = [];
    const resolutionsByDevice: Record<string, number | string> = {};
    const emittedBinsByDevice: Record<string, number> = {};
    const excludedBinsByDevice: Record<string, Record<string, number>> = {};
    const detectorCoverage: Record<string, unknown> = {};
    let detectorParameters: JsonRecord | null = null;
    let completed = 0;

    const addWarning = (warning: JsonRecord): void => {
      warnings.set(JSON.stringify(warning), warning);
      if (warnings.size > MAX_DETECTOR_WARNINGS) {
        throw new AnalysisScopeError('INSUFFICIENT_DATA', `Merged detector output exceeds the ${MAX_DETECTOR_WARNINGS} warning result bound; narrow the requested windows`);
      }
    };

    for (const plan of plans) {
      const device = devices.get(plan.device_id);
      const room = rooms.get(plan.room_id);
      if (plan.resolution_seconds === null || !plan.reference || !plan.policies.length || !device || !room) {
        resolutionsByDevice[plan.device_id] = 'not_assessed';
        devicesOut.push({ device_id: plan.device_id, room_id: plan.room_id, device_type: plan.device_type,
          status: 'unsupported_aggregation', assessment_source: 'auditor_precheck',
          reason: plan.problem ?? 'The device could not be prepared for the detector.' });
        continue;
      }
      resolutionsByDevice[plan.device_id] = plan.resolution_seconds;
      const aggregationReports = [plan.reference.aggregation, plan.evaluation_batches[0]?.aggregation ?? null].filter((report): report is AggregationReport => report !== null);
      if (aggregationReports.length) {
        const emitted = aggregationReports.reduce((sum, report) => sum + report.emitted_bins, 0);
        emittedBinsByDevice[plan.device_id] = emitted;
        const excluded: Record<string, number> = {};
        for (const report of aggregationReports) {
          for (const [reason, count] of Object.entries(report.excluded_device_bins)) excluded[reason] = (excluded[reason] ?? 0) + count;
        }
        if (Object.keys(excluded).length) excludedBinsByDevice[plan.device_id] = excluded;
      }

      for (const batch of plan.evaluation_batches) {
        const payload: JsonRecord = {
          contract_version: '1.0.1', dataset_id: datasetId, run_id: meta.run_id,
          rooms: [roomForDetector(room)], devices: [deviceForDetector(device)], policies: plan.policies,
          detector: { version: definition.detector_version },
          reference: { window: { start_utc: reference.start_utc, end_utc: reference.end_utc },
            room_intervals: plan.reference.room_records, device_intervals: plan.reference.device_records },
          evaluation: { window: { start_utc: evaluation.start_utc, end_utc: evaluation.end_utc },
            room_intervals: batch.room_records, device_intervals: batch.device_records },
        };
        const data = detector === 'excess_consumption'
          ? await this.python.anomalies(payload)
          : await this.python.drift(payload);
        detectorParameters ??= ((data.detector as JsonRecord).parameters as JsonRecord | undefined) ?? null;
        for (const warning of data.warnings as JsonRecord[]) addWarning(warning);
        for (const item of data.exclusions as JsonRecord[]) {
          if (exclusions.length < MAX_LISTED_EXCLUSIONS) exclusions.push(item);
        }
        for (const entry of data.devices as JsonRecord[]) devicesOut.push({ ...entry, assessment_source: 'detector' });
        for (const change of (data.other_changes as JsonRecord[] | undefined) ?? []) {
          otherChanges.push({ ...change, detector_id: detector });
        }
        mergeCoverage(detectorCoverage, data.coverage as JsonRecord);
        for (const finding of data.findings as JsonRecord[]) {
          const id = String(finding.finding_id);
          if (seenFindings.has(id)) continue;
          seenFindings.add(id);
          findings.push({ ...finding, detector_id: detector });
          if (findings.length > this.maxFindings) {
            throw new AnalysisScopeError('INSUFFICIENT_DATA', `Result has more than ${this.maxFindings} findings; narrow the requested windows`);
          }
        }
        completed++;
        const first = batch.device_records[0];
        const last = batch.device_records.at(-1);
        await options.onProgress?.({ completed, total,
          coverage: first && last ? { start_utc: String(first.interval_start_utc), end_utc: String(last.interval_end_utc) } : null });
      }
    }

    const unsupported = devicesOut.filter((entry) => entry.assessment_source === 'auditor_precheck');
    const aggregated = Object.values(resolutionsByDevice).some((value) => typeof value === 'number' && value !== meta.interval_seconds);
    if (aggregated) {
      addWarning({ code: 'AGGREGATED_INTERVALS', message: 'Stored readings were aggregated onto requested contract intervals because the stored resolution exceeds the detector record bound. Only bins whose readings are contiguous, non-partial, fully on, under a single policy version and covered by room context were sent; every other bin is reported under aggregation.excluded_device_bins.' });
    }
    if (unsupported.length) {
      addWarning({ code: 'DEVICES_NOT_ASSESSED', message: `${unsupported.length} device(s) were not sent to the detector; each carries its own reason. They are not evaluated-no-findings.` });
    }
    if (detector === 'excess_consumption') {
      addWarning({ code: 'NOT_AVOIDABLE_SAVINGS', message: 'energy_above_baseline_kwh is energy above the reference median over flagged intervals, not a guaranteed avoidable amount, and is not added to vacancy avoidable-energy totals.' });
    }

    const result: JsonRecord = {
      status: detectorStatus(detector, findings.length, devicesOut),
      dataset_id: datasetId, run_id: meta.run_id, synthetic: meta.synthetic, synthetic_label: meta.synthetic_label,
      detector: { id: detector, method: 'rule', method_version: definition.detector_version, technique: definition.technique,
        request_format: definition.request_format, model_used: false, parameters: detectorParameters },
      windows: { reference, evaluation },
      coverage: {
        start_utc: evaluation.start_utc, end_utc: evaluation.end_utc,
        devices: plans.length, unsupported_devices: unsupported.length,
        detector_calls: completed, max_section_records: this.maxSectionRecords,
      },
      detector_coverage: detectorCoverage,
      totals: { findings: findings.length, other_changes: otherChanges.length,
        exclusions_listed: exclusions.length,
        exclusions_total: countExclusions(detectorCoverage) + Object.values(excludedBinsByDevice).reduce((sum, bins) => sum + Object.values(bins).reduce((inner, count) => inner + count, 0), 0) },
      devices: devicesOut,
      aggregation: { stored_interval_seconds: meta.interval_seconds, max_section_records: this.maxSectionRecords,
        resolutions_by_device: resolutionsByDevice, emitted_bins_by_device: emittedBinsByDevice, excluded_device_bins: excludedBinsByDevice },
      warnings: [...warnings.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))),
      exclusions,
      limitations: [
        'Detector output is a statistical deviation under the stated comparability rules; it is not a confirmed malfunction and not an efficiency diagnosis.',
        'Excess-consumption and trend magnitudes are not guaranteed avoidable energy and are never added to vacancy avoidable-energy totals.',
        'Assessment is limited to fully-on comparable observations; a device without them is reported as not assessed rather than as evaluated with no findings.',
      ],
    };
    if (detector === 'gradual_trend') {
      result.other_changes = otherChanges.sort((a, b) => String(a.device_id).localeCompare(String(b.device_id))
        || String(a.classification).localeCompare(String(b.classification)));
    }
    return { result, findings: findings.sort((a, b) => String(a.finding_id).localeCompare(String(b.finding_id))), batches: completed };
  }
}

/** Sums additive Python coverage counters and merges exclusion maps across per-device calls. */
function mergeCoverage(target: Record<string, unknown>, source: JsonRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') {
      target[key] = Number(target[key] ?? 0) + value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const bucket = (target[key] ??= {}) as Record<string, number>;
      for (const [innerKey, innerValue] of Object.entries(value as JsonRecord)) {
        if (typeof innerValue === 'number') bucket[innerKey] = (bucket[innerKey] ?? 0) + innerValue;
      }
    }
  }
}

function countExclusions(coverage: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(coverage)) {
    if (!key.includes('excluded') || !value || typeof value !== 'object') continue;
    for (const count of Object.values(value as Record<string, unknown>)) {
      if (typeof count === 'number') total += count;
    }
  }
  return total;
}

function sectionDevice(sections: SectionData[]): string {
  for (const section of sections) {
    const record = section.device_records[0];
    if (record && typeof record.device_id === 'string') return record.device_id;
  }
  return '';
}

/**
 * Overall job status from the per-device entries, following each Python
 * detector's own precedence. Python reports `/v1/drift` device statuses as
 * `evaluated`, while `/v1/anomalies` reports `evaluated_no_deviation`, so both
 * vocabularies are translated here; `unsupported_aggregation` is the auditor's
 * own precheck state and stays distinguishable from every detector state.
 */
function overallStatus(detector: DetectorId, devices: JsonRecord[]): string {
  const statuses = new Set(devices.map((entry) => String(entry.status)));
  const mapping: Array<[string, string]> = detector === 'excess_consumption'
    ? [['evaluated_no_deviation', 'evaluated_no_deviation'], ['insufficient_reference', 'insufficient_reference'],
      ['unsupported_context', 'unsupported_context'], ['unsupported_aggregation', 'unsupported_aggregation']]
    : [['evaluated', 'evaluated_no_gradual_trend'], ['insufficient_history', 'insufficient_history'],
      ['unsupported_context', 'unsupported_context'], ['unsupported_aggregation', 'unsupported_aggregation']];
  for (const [deviceStatus, overall] of mapping) if (statuses.has(deviceStatus)) return overall;
  return 'no_comparable_observations';
}

export function detectorStatus(detector: DetectorId, findings: number, devices: JsonRecord[]): string {
  return findings > 0 ? 'findings_detected' : overallStatus(detector, devices);
}

function roomForDetector(room: AnalysisRoomMeta): JsonRecord {
  return { room_id: room.room_id, name: room.name, capacity: room.capacity, room_type: room.room_type,
    ...(room.floor_area_m2 === null ? {} : { floor_area_m2: room.floor_area_m2 }) };
}

function deviceForDetector(device: AnalysisDeviceMeta): JsonRecord {
  return { device_id: device.device_id, name: device.name, room_id: device.room_id, device_type: device.device_type,
    always_on: device.always_on, quantity: device.quantity, nominal_power_w: device.nominal_power_w,
    standby_power_w: device.standby_power_w, power_factor: device.power_factor, control: device.control,
    controls: device.controls };
}

function policyForDetector(policy: AnalysisPolicyMeta): JsonRecord {
  return { policy_id: policy.policy_id, version: policy.version, kind: policy.kind,
    applies_to: policy.applies_to, effective_from_utc: policy.effective_from_utc, rules: policy.rules };
}
