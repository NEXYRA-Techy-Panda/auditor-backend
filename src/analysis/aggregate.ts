import type { JsonRecord } from './types.js';
import type { StoredAnalysisInterval } from '../db/database.js';

/**
 * Deterministic aggregation for the P022/P024 detectors (P026).
 *
 * Python's /v1/anomalies and /v1/drift accept at most 2,000 device and 2,000
 * room intervals per section and never aggregate themselves. Minute readings
 * therefore exceed the bound for any multi-day window, so the auditor has to
 * send coarser requested intervals.
 *
 * Aggregation is only ever valid when the coarser interval still means exactly
 * what the detector expects. A bin is emitted ONLY when every stored record
 * that makes it up is present, contiguous and non-partial, the device was
 * fully on (`on_fraction == 1`) for the whole bin, the applied policy version
 * is unchanged, and the room context is present for the same bin. Everything
 * else is excluded and counted by reason; nothing is zero-filled, averaged
 * into an apparently comparable fully-on observation, or dropped silently.
 */

/** Contract interval nominals, finest first. Native data is never coarsened upward past these. */
export const AGGREGATION_RESOLUTIONS: readonly number[] = [60, 300, 600, 900, 1800, 3600];

/** Asia/Kolkata (UTC+05:30) is the only building timezone in contract v1. */
export const LOCAL_OFFSET_SECONDS = 19800;

const FULL_ON_TOLERANCE = 1e-9;

export type AggregationExclusionReason =
  | 'missing_device_readings'
  | 'partial_or_incomplete_readings'
  | 'duty_unknown'
  | 'mixed_duty_or_off'
  | 'policy_change'
  | 'missing_room_context';

export interface AggregationReport {
  aggregated: boolean;
  resolution_seconds: number;
  stored_interval_seconds: number;
  window: { start_utc: string; end_utc: string };
  emitted_bins: number;
  emitted_seconds: number;
  /** Device bins that could not be emitted, by reason. Empty when nothing was aggregated. */
  excluded_device_bins: Record<string, number>;
  excluded_device_seconds: number;
}

export interface AggregatedSection {
  device_intervals: JsonRecord[];
  room_intervals: JsonRecord[];
  report: AggregationReport;
}

interface Tiling {
  rows: StoredAnalysisInterval[];
  ok: boolean;
  partial: boolean;
}

const toEpoch = (value: string): number => Date.parse(value);
const utc = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Resolution candidates at or above the stored resolution, finest first. */
export function resolutionCandidates(storedIntervalSeconds: number): number[] {
  return AGGREGATION_RESOLUTIONS.filter((seconds) => seconds >= storedIntervalSeconds && seconds % storedIntervalSeconds === 0);
}

/** Window-anchored bin start for an instant (millisecond epoch); bins never cross the requested window bounds. */
export function binStart(epoch: number, windowStart: number, resolutionSeconds: number): number {
  const resolutionMs = resolutionSeconds * 1000;
  return windowStart + Math.floor((epoch - windowStart) / resolutionMs) * resolutionMs;
}

function tile(rows: StoredAnalysisInterval[], binStartMs: number, binEndMs: number): Tiling {
  if (rows.length === 0) return { rows, ok: false, partial: false };
  const sorted = [...rows].sort((a, b) => toEpoch(a.interval_start_utc) - toEpoch(b.interval_start_utc));
  if (toEpoch(sorted[0]!.interval_start_utc) !== binStartMs) return { rows: sorted, ok: false, partial: false };
  const partial = sorted.some((row) => row.partial === 1 || row.partial === true);
  for (let index = 1; index < sorted.length; index++) {
    if (toEpoch(sorted[index]!.interval_start_utc) !== toEpoch(sorted[index - 1]!.interval_end_utc)) return { rows: sorted, ok: false, partial };
  }
  if (toEpoch(sorted.at(-1)!.interval_end_utc) !== binEndMs) return { rows: sorted, ok: false, partial };
  return { rows: sorted, ok: !partial, partial };
}

function weightedMean(rows: StoredAnalysisInterval[], key: keyof StoredAnalysisInterval): number {
  let total = 0;
  let weight = 0;
  for (const row of rows) {
    const value = Number(row[key]);
    total += value * Number(row.interval_seconds);
    weight += Number(row.interval_seconds);
  }
  return weight === 0 ? 0 : total / weight;
}

const has = (row: StoredAnalysisInterval, key: keyof StoredAnalysisInterval): boolean => row[key] !== null && row[key] !== undefined;

function sumField(rows: StoredAnalysisInterval[], key: keyof StoredAnalysisInterval): number {
  return rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
}

function maxField(rows: StoredAnalysisInterval[], key: keyof StoredAnalysisInterval): number {
  return rows.reduce((max, row) => Math.max(max, Number(row[key])), Number.NEGATIVE_INFINITY);
}

function deviceRecord(binStartMs: number, resolutionSeconds: number, rows: StoredAnalysisInterval[]): JsonRecord {
  const avgPower = weightedMean(rows, 'avg_power_w');
  const record: JsonRecord = {
    run_id: String(rows[0]!.run_id), room_id: String(rows[0]!.room_id), device_id: String(rows[0]!.device_id),
    interval_start_utc: utc(binStartMs), interval_end_utc: utc(binStartMs + resolutionSeconds * 1000),
    interval_seconds: resolutionSeconds,
    // Recomputed from the aggregated average power so Python's 1e-9 kWh
    // consistency check holds exactly. Duration-weighted averaging keeps the
    // underlying energy (sum of sub-interval energy) identical to rounding.
    avg_power_w: avgPower,
    energy_kwh: avgPower * resolutionSeconds / 3_600_000,
    vacant_on_seconds: sumField(rows, 'vacant_on_seconds'),
    offschedule_on_seconds: sumField(rows, 'offschedule_on_seconds'),
    policy_ref: `${String(rows[0]!.policy_id)}:${String(rows[0]!.policy_version)}`,
    on_fraction: 1,
    partial: false,
  };
  if (rows.every((row) => has(row, 'max_power_w'))) record.max_power_w = maxField(rows, 'max_power_w');
  if (rows.every((row) => has(row, 'override_seconds'))) record.override_seconds = sumField(rows, 'override_seconds');
  if (rows.every((row) => has(row, 'avg_voltage_v'))) record.avg_voltage_v = weightedMean(rows, 'avg_voltage_v');
  if (rows.every((row) => has(row, 'avg_current_a'))) record.avg_current_a = weightedMean(rows, 'avg_current_a');
  if (rows.every((row) => has(row, 'power_factor'))) record.power_factor = weightedMean(rows, 'power_factor');
  return record;
}

function roomRecord(binStartMs: number, resolutionSeconds: number, rows: StoredAnalysisInterval[]): JsonRecord {
  const record: JsonRecord = {
    run_id: String(rows[0]!.run_id), room_id: String(rows[0]!.room_id),
    interval_start_utc: utc(binStartMs), interval_end_utc: utc(binStartMs + resolutionSeconds * 1000),
    interval_seconds: resolutionSeconds,
    occupancy_avg: weightedMean(rows, 'occupancy_avg'),
    occupancy_max: maxField(rows, 'occupancy_max'),
    occupied_fraction: weightedMean(rows, 'occupied_fraction'),
    partial: false,
  };
  if (rows.every((row) => has(row, 'avg_temp_c'))) record.avg_temp_c = weightedMean(rows, 'avg_temp_c');
  if (rows.every((row) => has(row, 'avg_rh_pct'))) record.avg_rh_pct = weightedMean(rows, 'avg_rh_pct');
  return record;
}

export interface AggregateSectionInput {
  deviceRows: StoredAnalysisInterval[];
  roomRows: StoredAnalysisInterval[];
  resolutionSeconds: number;
  storedIntervalSeconds: number;
  windowStartUtc: string;
  windowEndUtc: string;
}

/**
 * Aggregates one detector section (one device's readings plus its room context)
 * onto a resolution grid anchored at the section window start.
 */
export function aggregateSection(input: AggregateSectionInput): AggregatedSection {
  const windowStart = toEpoch(input.windowStartUtc);
  const windowEnd = toEpoch(input.windowEndUtc);
  const excluded: Record<string, number> = {};
  let excludedSeconds = 0;
  const exclude = (reason: AggregationExclusionReason, seconds: number): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
    excludedSeconds += seconds;
  };
  const deviceRows = input.deviceRows.filter((row) => {
    const start = toEpoch(row.interval_start_utc);
    return start >= windowStart && toEpoch(row.interval_end_utc) <= windowEnd;
  });
  const roomRows = input.roomRows.filter((row) => {
    const start = toEpoch(row.interval_start_utc);
    return start >= windowStart && toEpoch(row.interval_end_utc) <= windowEnd;
  });

  const byBin = new Map<number, StoredAnalysisInterval[]>();
  for (const row of deviceRows) {
    const start = binStart(toEpoch(row.interval_start_utc), windowStart, input.resolutionSeconds);
    const bucket = byBin.get(start);
    if (bucket) bucket.push(row);
    else byBin.set(start, [row]);
  }
  const roomByBin = new Map<number, StoredAnalysisInterval[]>();
  for (const row of roomRows) {
    const start = binStart(toEpoch(row.interval_start_utc), windowStart, input.resolutionSeconds);
    const bucket = roomByBin.get(start);
    if (bucket) bucket.push(row);
    else roomByBin.set(start, [row]);
  }

  const deviceIntervals: JsonRecord[] = [];
  const roomIntervals: JsonRecord[] = [];
  let emittedSeconds = 0;
  for (let start = windowStart; start + input.resolutionSeconds * 1000 <= windowEnd; start += input.resolutionSeconds * 1000) {
    const end = start + input.resolutionSeconds * 1000;
    const seconds = input.resolutionSeconds;
    const rows = byBin.get(start) ?? [];
    if (rows.length === 0) { exclude('missing_device_readings', seconds); continue; }
    const device = tile(rows, start, end);
    if (!device.ok) { exclude('partial_or_incomplete_readings', seconds); continue; }
    if (rows.some((row) => !has(row, 'on_fraction'))) { exclude('duty_unknown', seconds); continue; }
    if (rows.some((row) => Number(row.on_fraction) < 1 - FULL_ON_TOLERANCE)) { exclude('mixed_duty_or_off', seconds); continue; }
    if (new Set(rows.map((row) => `${String(row.policy_id)}:${String(row.policy_version)}`)).size > 1) {
      exclude('policy_change', seconds); continue;
    }
    const rooms = roomByBin.get(start) ?? [];
    const room = tile(rooms, start, end);
    if (!room.ok) { exclude('missing_room_context', seconds); continue; }
    deviceIntervals.push(deviceRecord(start, input.resolutionSeconds, rows));
    roomIntervals.push(roomRecord(start, input.resolutionSeconds, room.rows));
    emittedSeconds += seconds;
  }

  return {
    device_intervals: deviceIntervals,
    room_intervals: roomIntervals,
    report: {
      aggregated: true, resolution_seconds: input.resolutionSeconds,
      stored_interval_seconds: input.storedIntervalSeconds,
      window: { start_utc: input.windowStartUtc, end_utc: input.windowEndUtc },
      emitted_bins: deviceIntervals.length, emitted_seconds: emittedSeconds,
      excluded_device_bins: excluded, excluded_device_seconds: excludedSeconds,
    },
  };
}
