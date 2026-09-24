import type { AnalysisDeviceMeta, AnalysisPolicyMeta, AnalysisRoomMeta, AuditorDatabase, StoredAnalysisInterval } from '../db/database.js';
import { PythonAnalysisClient, type PythonServiceError } from './client.js';
import type { JsonRecord } from './types.js';

const MAX_PYTHON_RECORDS = 2000;
const MAX_GRACE_SECONDS = 3600;
const OWNED_DEVICE_ROWS_PER_BATCH = 1000;
const MAX_MERGED_FINDINGS = 100_000;
const MAX_MERGED_WARNINGS = 100_000;
const MAX_EVIDENCE_INTERVALS_PER_FINDING = 100_000;
const RULE_VERSION = 'vacant-beyond-grace-v1';

export class AnalysisScopeError extends Error {
  constructor(readonly code: 'INSUFFICIENT_DATA' | 'VALIDATION_ERROR', message: string) { super(message); }
}

export interface AnalysisProgress { completed: number; total: number; coverage: { start_utc: string; end_utc: string } | null; }
export interface RunAnalysisOptions {
  batchSize?: number;
  onProgress?: (progress: AnalysisProgress) => Promise<void> | void;
  yieldBetweenBatches?: boolean;
}

interface Contribution {
  interval: JsonRecord; row: StoredAnalysisInterval;
  device: AnalysisDeviceMeta; graceSeconds: number; supported: boolean; start: number; end: number;
  countedFrom: string; onBeyond: number; observedKwh: number | null; expectedKwh: number | null;
}

const toEpoch = (value: string): number => Date.parse(value);
const utc = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

export class AnalysisBatchRunner {
  constructor(private readonly database: AuditorDatabase, private readonly python: PythonAnalysisClient) {}

  estimateBatches(datasetId: string, startUtc: string, endUtc: string, batchSize = OWNED_DEVICE_ROWS_PER_BATCH): number {
    const deviceIds = this.database.getAnalysisDeviceIds(datasetId, startUtc, endUtc);
    return deviceIds.reduce((total, item) => total + Math.ceil(this.database.getAnalysisDeviceStarts(datasetId, item.device_id, startUtc, endUtc).length / batchSize), 0);
  }

  async run(datasetId: string, startUtc: string, endUtc: string, options: RunAnalysisOptions = {}): Promise<JsonRecord> {
    const batchSize = options.batchSize ?? OWNED_DEVICE_ROWS_PER_BATCH;
    const meta = this.database.getAnalysisDatasetMeta(datasetId);
    if (!meta) throw new AnalysisScopeError('VALIDATION_ERROR', 'Dataset was not found');
    const deviceRanges = this.database.getAnalysisDeviceIds(datasetId, startUtc, endUtc);
    if (!deviceRanges.length) throw new AnalysisScopeError('INSUFFICIENT_DATA', 'The requested range has no device readings');
    const roomsAll = new Set<string>();
    const devicesAll = new Set<string>();
    const startsByDevice = new Map<string, string[]>();
    for (const range of deviceRanges) {
      roomsAll.add(range.room_id); devicesAll.add(range.device_id);
      startsByDevice.set(range.device_id, this.database.getAnalysisDeviceStarts(datasetId, range.device_id, startUtc, endUtc));
    }
    const rooms = this.database.getAnalysisRooms(datasetId, [...roomsAll]);
    const devices = this.database.getAnalysisDevices(datasetId, [...devicesAll]);
    const roomById = new Map(rooms.map((room) => [room.room_id, room]));
    const deviceById = new Map(devices.map((device) => [device.device_id, device]));
    const batchesTotal = [...startsByDevice.values()].reduce((sum, starts) => sum + Math.ceil(starts.length / batchSize), 0);
    const findings: JsonRecord[] = [];
    const warnings = new Map<string, JsonRecord>();
    const excluded = new Map<string, JsonRecord>();
    let batchesCompleted = 0;

    for (const range of deviceRanges) {
      const device = deviceById.get(range.device_id);
      const room = roomById.get(range.room_id);
      const starts = startsByDevice.get(range.device_id) ?? [];
      if (!device || !room || starts.length === 0) continue;
      const contributions: Contribution[] = [];
      for (let offset = 0; offset < starts.length; offset += batchSize) {
        const ownedStarts = starts.slice(offset, offset + batchSize);
        const ownedStart = ownedStarts[0]!;
        const finalStart = ownedStarts.at(-1)!;
        const finalInterval = this.database.getAnalysisDeviceIntervalAt(datasetId, range.device_id, finalStart);
        if (!finalInterval) throw new AnalysisScopeError('INSUFFICIENT_DATA', `Readings ended before the owned batch for ${range.device_id}`);
        const ownedEnd = finalInterval.interval_end_utc;
        const contextStart = utc(Math.max(toEpoch(meta.start_utc), toEpoch(ownedStart) - (MAX_GRACE_SECONDS + meta.interval_seconds) * 1000));
        const roomRows = this.database.getAnalysisRoomIntervals(datasetId, range.room_id, contextStart, ownedEnd)
          .filter((row) => row.interval_start_utc < ownedEnd);
        const deviceRows = this.database.getAnalysisDeviceIntervals(datasetId, range.device_id, contextStart, ownedEnd)
          .filter((row) => row.interval_start_utc < ownedEnd);
        const roomIntervals = roomRows.map(roomIntervalForPython);
        const deviceIntervals = deviceRows.map(deviceIntervalForPython);
        if (roomIntervals.length > MAX_PYTHON_RECORDS || deviceIntervals.length > MAX_PYTHON_RECORDS) {
          throw new AnalysisScopeError('INSUFFICIENT_DATA', `Preceding room history for ${range.device_id} cannot fit Python's 2,000-record bound while preserving the 3,600-second maximum vacancy grace`);
        }
        if (!roomIntervals.length || !deviceIntervals.length) throw new AnalysisScopeError('INSUFFICIENT_DATA', `No readings are available for ${range.device_id} in a required analysis window`);

        const policyRefs = [...new Map(deviceIntervals.map((row) => {
          const [id, rawVersion] = String(row.policy_ref).split(':');
          if (!id || !/^\d+$/.test(rawVersion ?? '')) throw new AnalysisScopeError('INSUFFICIENT_DATA', 'A stored policy reference is malformed');
          return [`${id}:${rawVersion}`, { id, version: Number(rawVersion) }] as const;
        })).values()];
        const policies = this.database.getAnalysisPolicies(datasetId, policyRefs);
        if (policies.length !== policyRefs.length) throw new AnalysisScopeError('INSUFFICIENT_DATA', `A referenced policy definition is missing for ${range.device_id}`);
        const policyByRef = new Map(policies.map((policy) => [`${policy.policy_id}:${policy.version}`, policy]));
        const requestStart = roomRows[0]!.interval_start_utc < deviceRows[0]!.interval_start_utc
          ? roomRows[0]!.interval_start_utc : deviceRows[0]!.interval_start_utc;
        const requestEnd = roomRows.at(-1)!.interval_end_utc > deviceRows.at(-1)!.interval_end_utc
          ? roomRows.at(-1)!.interval_end_utc : deviceRows.at(-1)!.interval_end_utc;
        const response = await this.python.analyze({
          contract_version: '1.0.1', dataset_id: datasetId, run_id: meta.run_id,
          window: { start_utc: requestStart, end_utc: requestEnd },
          rooms: [roomForPython(room)], devices: [deviceForPython(device)],
          policies: policies.map(policyForPython), room_intervals: roomIntervals, device_intervals: deviceIntervals,
        });
        const owns = (value: unknown): value is string => typeof value === 'string' && value >= ownedStart && value < ownedEnd;
        for (const rawWarning of response.warnings as JsonRecord[]) {
          const start = rawWarning.window_start_utc;
          if (typeof start === 'string' && !owns(start)) continue;
          warnings.set(JSON.stringify(rawWarning), rawWarning);
          if (warnings.size > MAX_MERGED_WARNINGS) {
            throw new AnalysisScopeError('INSUFFICIENT_DATA', `Merged analysis exceeds the ${MAX_MERGED_WARNINGS} warning result bound; narrow the requested range`);
          }
        }
        const analysis = response.analysis as JsonRecord;
        for (const item of analysis.excluded_devices as JsonRecord[]) excluded.set(String(item.device_id), item);
        const byKey = new Map(deviceRows.map((row) => [`${row.device_id}|${row.interval_start_utc}`, row]));
        for (const rawFinding of response.findings as JsonRecord[]) {
          const evidence = rawFinding.evidence as JsonRecord;
          for (const rawInterval of evidence.intervals as JsonRecord[]) {
            if (!owns(rawInterval.interval_start_utc)) continue;
            const row = byKey.get(`${range.device_id}|${String(rawInterval.interval_start_utc)}`);
            if (!row) throw new Error('Python evidence references an interval absent from the submitted batch');
            const startUtc = String(rawInterval.interval_start_utc);
            const endUtc = String(rawInterval.interval_end_utc);
            const countedFrom = String(rawInterval.counted_from_utc);
            const within = Math.max(0, (toEpoch(countedFrom) - toEpoch(startUtc)) / 1000);
            const beyond = Math.max(0, (toEpoch(endUtc) - Math.max(toEpoch(startUtc), toEpoch(countedFrom))) / 1000);
            const onBeyond = Math.max(0, Math.min(Number(row.vacant_on_seconds), Number(row.interval_seconds)) - within);
            const supported = (rawFinding.observed as JsonRecord).unit === 'kWh';
            let observedKwh: number | null = null;
            let expectedKwh: number | null = null;
            if (supported) {
              observedKwh = within === 0 ? Number(row.energy_kwh)
                : Number(row.vacant_on_seconds) >= Number(row.interval_seconds)
                  ? Number(row.avg_power_w) * beyond / 3_600_000 : null;
              expectedKwh = within === 0
                ? (device.standby_power_w ?? 0) * Number(row.interval_seconds) / 3_600_000
                : (device.standby_power_w ?? 0) * beyond / 3_600_000;
              if (observedKwh === null) throw new Error('Python marked an unsupported partial interval as supported');
            }
            if (onBeyond <= 0 || beyond <= 0) continue;
            const policy = policyByRef.get(String(rawInterval.policy_ref));
            if (!policy) throw new AnalysisScopeError('INSUFFICIENT_DATA', `Policy ${String(rawInterval.policy_ref)} was not supplied to Python`);
            contributions.push({ interval: rawInterval, row, device,
              graceSeconds: Number(policy.rules.vacancy_grace_seconds ?? 0), supported,
              start: toEpoch(countedFrom), end: toEpoch(endUtc), countedFrom, onBeyond, observedKwh, expectedKwh });
          }
        }

        batchesCompleted++;
        await options.onProgress?.({ completed: batchesCompleted, total: batchesTotal,
          coverage: { start_utc: ownedStart, end_utc: ownedEnd } });
        if (options.yieldBetweenBatches !== false) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      findings.push(...mergeContributions(contributions));
      if (findings.length > MAX_MERGED_FINDINGS) {
        throw new AnalysisScopeError('INSUFFICIENT_DATA', `Merged analysis exceeds the ${MAX_MERGED_FINDINGS} finding result bound; narrow the requested range`);
      }
    }

    const actual = this.database.getAnalysisCoverage(datasetId, startUtc, endUtc);
    const expectedIntervals = Math.max(0, Math.round((toEpoch(endUtc) - toEpoch(startUtc)) / (meta.interval_seconds * 1000)));
    const complete = actual.start_utc === startUtc && actual.end_utc === endUtc
      && actual.device_intervals === expectedIntervals * devicesAll.size
      && actual.room_intervals === expectedIntervals * roomsAll.size;
    return {
      dataset_id: datasetId, run_id: meta.run_id, synthetic: meta.synthetic, synthetic_label: meta.synthetic_label,
      method: 'rule', method_version: RULE_VERSION, model_used: false,
      requested_range: { start_utc: startUtc, end_utc: endUtc },
      coverage: { start_utc: actual.start_utc, end_utc: actual.end_utc, device_intervals: actual.device_intervals,
        room_intervals: actual.room_intervals, complete },
      findings, warnings: [...warnings.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      excluded_devices: [...excluded.values()].sort((a, b) => String(a.device_id).localeCompare(String(b.device_id))),
      batches: { completed: batchesCompleted, total: batchesTotal, max_device_intervals: MAX_PYTHON_RECORDS,
        max_room_intervals: MAX_PYTHON_RECORDS },
    };
  }
}

function roomForPython(room: AnalysisRoomMeta): JsonRecord {
  return { room_id: room.room_id, name: room.name, capacity: room.capacity, room_type: room.room_type,
    ...(room.floor_area_m2 === null ? {} : { floor_area_m2: room.floor_area_m2 }) };
}
function deviceForPython(device: AnalysisDeviceMeta): JsonRecord {
  return { device_id: device.device_id, name: device.name, room_id: device.room_id, device_type: device.device_type,
    always_on: device.always_on, quantity: device.quantity, nominal_power_w: device.nominal_power_w,
    standby_power_w: device.standby_power_w, power_factor: device.power_factor, control: device.control,
    controls: device.controls };
}
function policyForPython(policy: AnalysisPolicyMeta): JsonRecord {
  return { policy_id: policy.policy_id, version: policy.version, kind: policy.kind,
    applies_to: policy.applies_to, effective_from_utc: policy.effective_from_utc, rules: policy.rules };
}
function roomIntervalForPython(row: StoredAnalysisInterval): JsonRecord {
  return { room_id: row.room_id, interval_start_utc: row.interval_start_utc, interval_end_utc: row.interval_end_utc,
    interval_seconds: row.interval_seconds, occupancy_avg: row.occupancy_avg, occupancy_max: row.occupancy_max,
    occupied_fraction: row.occupied_fraction, ...(row.avg_temp_c === null ? {} : { avg_temp_c: row.avg_temp_c }),
    ...(row.avg_rh_pct == null ? {} : { avg_rh_pct: row.avg_rh_pct }), partial: row.partial === 1 || row.partial === true };
}
function deviceIntervalForPython(row: StoredAnalysisInterval): JsonRecord {
  return { run_id: row.run_id, room_id: row.room_id, device_id: row.device_id,
    interval_start_utc: row.interval_start_utc, interval_end_utc: row.interval_end_utc,
    interval_seconds: row.interval_seconds, avg_power_w: row.avg_power_w, energy_kwh: row.energy_kwh,
    vacant_on_seconds: row.vacant_on_seconds, offschedule_on_seconds: row.offschedule_on_seconds,
    policy_ref: `${row.policy_id}:${row.policy_version}`,
    ...(row.max_power_w === null ? {} : { max_power_w: row.max_power_w }),
    ...(row.cumulative_kwh === null ? {} : { cumulative_kwh: row.cumulative_kwh }),
    ...(row.avg_voltage_v === null ? {} : { avg_voltage_v: row.avg_voltage_v }),
    ...(row.avg_current_a === null ? {} : { avg_current_a: row.avg_current_a }),
    ...(row.power_factor === null ? {} : { power_factor: row.power_factor }),
    ...(row.on_fraction === null ? {} : { on_fraction: row.on_fraction }),
    ...(row.override_seconds == null ? {} : { override_seconds: row.override_seconds }), partial: row.partial === 1 || row.partial === true };
}

function mergeContributions(portions: Contribution[]): JsonRecord[] {
  portions.sort((a, b) => a.device.device_id.localeCompare(b.device.device_id) || a.start - b.start);
  const groups: Contribution[][] = [];
  for (const portion of portions) {
    const prior = groups.at(-1);
    const last = prior?.at(-1);
    if (last && last.device.device_id === portion.device.device_id && last.end === portion.start && last.supported === portion.supported) prior!.push(portion);
    else groups.push([portion]);
  }
  if (groups.some((group) => group.length > MAX_EVIDENCE_INTERVALS_PER_FINDING)) {
    throw new AnalysisScopeError('INSUFFICIENT_DATA', `A merged finding exceeds the ${MAX_EVIDENCE_INTERVALS_PER_FINDING} interval-evidence bound; narrow the requested range`);
  }
  return groups.map((group) => {
    const first = group[0]!; const last = group.at(-1)!;
    const refs = [...new Set(group.map((item) => String(item.interval.policy_ref)))].sort();
    const graces = [...new Set(group.map((item) => item.graceSeconds))].sort((a, b) => a - b);
    const intervalSeconds = [...new Set(group.map((item) => Number(item.row.interval_seconds)))].sort((a, b) => a - b);
    const onSeconds = group.reduce((sum, item) => sum + item.onBeyond, 0);
    const observed = group.reduce((sum, item) => sum + (item.supported ? item.observedKwh ?? 0 : item.onBeyond), 0);
    const expected = group.reduce((sum, item) => sum + (item.expectedKwh ?? 0), 0);
    const finding: JsonRecord = {
      finding_id: `vacant_but_on:${first.device.device_id}:${first.countedFrom}`,
      finding_type: 'vacant_but_on', room_id: first.device.room_id, device_id: first.device.device_id,
      window_start_utc: first.countedFrom, window_end_utc: utc(last.end),
      observed: { value: observed, unit: first.supported ? 'kWh' : 's' },
      expected: { value: first.supported ? expected : 0, unit: first.supported ? 'kWh' : 's' },
      method: 'rule', suggested_action: `Switch off ${first.device.name} (${first.device.device_id}) in the room when it is vacant, after its applicable vacancy grace period; review its schedule or occupancy-based control.`,
      assumptions: [
        'Vacancy is established only from matching room intervals with occupancy_max = 0; a missing interval breaks continuity, and no vacancy is assumed before supplied evidence.',
        `Applied policy version(s) ${refs.join(', ')} use vacancy grace ${graces.map((value) => `${value} s`).join(', ')}.`,
        first.supported
          ? `Avoidable energy compares observed energy with the off-state draw (${first.device.standby_power_w ?? 'unknown'} W standby) over supported time. When grace expires inside an interval, average power is assumed constant only when the device was on throughout that interval.`
          : 'Energy for unsupported sub-intervals or unknown standby remains unknown; the result reports guaranteed operating seconds only.',
        group.some((item) => Number(item.row.override_seconds ?? 0) > 0)
          ? `Manual override is described, not judged (${group.reduce((sum, item) => sum + Number(item.row.override_seconds ?? 0), 0)} seconds in these intervals).` : '',
      ].filter(Boolean).join(' '),
      resolution_limit: `${intervalSeconds.join('/')} second intervals; sub-interval occupancy and switching times are not visible.`,
      evidence: { rule_version: RULE_VERSION, policy_refs: refs, vacant_on_seconds_beyond_grace: onSeconds,
        intervals: group.map((item) => ({ ...item.interval })) },
    };
    if (first.supported) {
      finding.avoidable_energy_kwh = Math.max(0, observed - expected);
    }
    return finding;
  });
}

export function pythonFailureSafeMessage(error: PythonServiceError): string {
  return error.kind === 'timeout' ? 'Python analysis timed out'
    : error.kind === 'unavailable' ? 'Python analysis service is unavailable'
      : error.kind === 'malformed' ? 'Python analysis service returned an invalid response'
        : `Python analysis rejected the request${error.upstreamCode ? ` (${error.upstreamCode})` : ''}`;
}
