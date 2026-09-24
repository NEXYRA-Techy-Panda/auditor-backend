import type { AuditorDatabase } from '../db/database.js';

const DAY = 86_400_000;
const IST = 330 * 60_000;
const MAX_RANGE_DAYS = 366;

export class HistoricalInputError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'UNSUPPORTED_INPUT', message: string, readonly field?: string) { super(message); }
}

export interface HistoricalWindow { from: number; to: number; fromUtc: string; toUtc: string; }
export interface HistoricalScope { roomId?: string; deviceId?: string; }
interface DatasetRow { dataset_id: string; timezone: string; synthetic: number; synthetic_label: string | null; start_utc: string; end_utc: string; source_resolution_seconds: number; }
interface InventoryDevice { device_id: string; room_id: string; device_name: string; device_type: string; quantity: number; nominal_power_w: number; }
interface InventoryRoom { room_id: string; room_name: string; room_type: string; floor_area_m2: number | null; }
interface EnergyInterval { device_id: string; room_id: string; interval_start_utc: string; interval_end_utc: string; interval_seconds: number; energy_kwh: number; avg_power_w: number; max_power_w: number; partial: number; }

function iso(ms: number): string { return new Date(ms).toISOString(); }
function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}
function parseUtc(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    throw new HistoricalInputError('VALIDATION_ERROR', `${field} must be an ISO UTC timestamp ending in Z`, field);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || iso(ms).slice(0, 19) !== value.slice(0, 19))
    throw new HistoricalInputError('VALIDATION_ERROR', `${field} must be a real UTC timestamp`, field);
  return ms;
}
export function parseWindow(query: Record<string, unknown>, dataset: DatasetRow): HistoricalWindow {
  if (query.from !== undefined && query.from_utc !== undefined) throw new HistoricalInputError('VALIDATION_ERROR', 'Use only one of from or from_utc');
  if (query.to !== undefined && query.to_utc !== undefined) throw new HistoricalInputError('VALIDATION_ERROR', 'Use only one of to or to_utc');
  const fromKey = query.from_utc !== undefined ? 'from_utc' : 'from';
  const toKey = query.to_utc !== undefined ? 'to_utc' : 'to';
  const fromValue = query.from_utc ?? query.from;
  const toValue = query.to_utc ?? query.to;
  const from = fromValue === undefined ? Date.parse(dataset.start_utc) : parseUtc(fromValue, fromKey);
  const to = toValue === undefined ? Date.parse(dataset.end_utc) : parseUtc(toValue, toKey);
  if (from >= to) throw new HistoricalInputError('VALIDATION_ERROR', 'from must be before to');
  const resolution = dataset.source_resolution_seconds * 1000;
  const gridOrigin = Date.parse(dataset.start_utc);
  if ((from - gridOrigin) % resolution !== 0 || (to - gridOrigin) % resolution !== 0)
    throw new HistoricalInputError('UNSUPPORTED_INPUT', `Window boundaries must align to the source interval (${dataset.source_resolution_seconds} seconds); exact proration is unsupported`);
  if (to - from > MAX_RANGE_DAYS * DAY)
    throw new HistoricalInputError('UNSUPPORTED_INPUT', `A single analytics request is limited to ${MAX_RANGE_DAYS} days`);
  return { from, to, fromUtc: iso(from), toUtc: iso(to) };
}

export function getDataset(database: AuditorDatabase, id: string): DatasetRow | undefined {
  return database.db.prepare(`SELECT dataset_id,timezone,synthetic,synthetic_label,source_resolution_seconds,
    json_extract(source_metadata_json,'$.export.export_start_utc') AS start_utc,
    json_extract(source_metadata_json,'$.export.export_end_utc') AS end_utc FROM datasets WHERE dataset_id=?`)
    .get(id) as DatasetRow | undefined;
}

function assertTimezone(dataset: DatasetRow): void {
  if (dataset.timezone !== 'Asia/Kolkata') throw new HistoricalInputError('UNSUPPORTED_INPUT', `Calendar analytics currently support Asia/Kolkata; dataset timezone is ${dataset.timezone}`, 'timezone');
}

function assertScope(database: AuditorDatabase, datasetId: string, scope: HistoricalScope): void {
  if (scope.roomId && !database.db.prepare('SELECT 1 FROM rooms WHERE dataset_id=? AND room_id=?').get(datasetId, scope.roomId))
    throw new HistoricalInputError('VALIDATION_ERROR', `Unknown room_id: ${scope.roomId}`, 'room_id');
  if (scope.deviceId && !database.db.prepare('SELECT 1 FROM devices WHERE dataset_id=? AND device_id=?').get(datasetId, scope.deviceId))
    throw new HistoricalInputError('VALIDATION_ERROR', `Unknown device_id: ${scope.deviceId}`, 'device_id');
}

function getInventory(database: AuditorDatabase, datasetId: string, scope: HistoricalScope): { rooms: InventoryRoom[]; devices: InventoryDevice[] } {
  const rooms = database.db.prepare(`SELECT room_id,name AS room_name,room_type,floor_area_m2 FROM rooms
    WHERE dataset_id=? ORDER BY room_id`).all(datasetId) as InventoryRoom[];
  let sql = `SELECT device_id,room_id,name AS device_name,device_type,quantity,nominal_power_w FROM devices WHERE dataset_id=?`;
  const args: (string | number)[] = [datasetId];
  if (scope.roomId !== undefined) { sql += ' AND room_id=?'; args.push(scope.roomId); }
  if (scope.deviceId !== undefined) { sql += ' AND device_id=?'; args.push(scope.deviceId); }
  sql += ' ORDER BY room_id,device_id';
  const devices = database.db.prepare(sql).all(...args) as InventoryDevice[];
  return { rooms: scope.roomId ? rooms.filter((r) => r.room_id === scope.roomId) : rooms, devices };
}

function rows(database: AuditorDatabase, datasetId: string, window: HistoricalWindow, scope: HistoricalScope): EnergyInterval[] {
  let sql = `SELECT di.device_id,di.room_id,di.interval_start_utc,di.interval_end_utc,di.interval_seconds,
      di.energy_kwh,di.avg_power_w,di.max_power_w,di.partial
    FROM device_intervals di WHERE di.dataset_id=? AND di.interval_start_utc<? AND di.interval_end_utc>?`;
  const args: (string | number)[] = [datasetId, window.toUtc, window.fromUtc];
  if (scope.roomId !== undefined) { sql += ' AND di.room_id=?'; args.push(scope.roomId); }
  if (scope.deviceId !== undefined) { sql += ' AND di.device_id=?'; args.push(scope.deviceId); }
  sql += ' ORDER BY di.interval_start_utc,di.device_id,di.room_id';
  const result = database.db.prepare(sql).all(...args) as EnergyInterval[];
  if (result.some((row) => Date.parse(row.interval_start_utc) < window.from || Date.parse(row.interval_end_utc) > window.to))
    throw new HistoricalInputError('UNSUPPORTED_INPUT', 'A source interval crosses the requested window boundary; choose aligned from/to values that contain whole source intervals');
  return result;
}

function coverageByDevice(intervals: EnergyInterval[], devices: InventoryDevice[], window: HistoricalWindow) {
  const expectedPerDevice = Math.max(0, (window.to - window.from) / 1000);
  const result = new Map<string, { seconds: number; partial: boolean; overlap: boolean; energy: number; avgPowerNumerator: number; peakPower: number | null; intervalCount: number }>();
  for (const device of devices) result.set(device.device_id, { seconds: 0, partial: false, overlap: false, energy: 0, avgPowerNumerator: 0, peakPower: null, intervalCount: 0 });
  const ordered = [...intervals].sort((a, b) => a.device_id.localeCompare(b.device_id) || a.interval_start_utc.localeCompare(b.interval_start_utc) || a.interval_end_utc.localeCompare(b.interval_end_utc));
  const cursor = new Map<string, number>();
  for (const row of ordered) {
    const target = result.get(row.device_id);
    if (!target) continue;
    const start = Date.parse(row.interval_start_utc); const end = Date.parse(row.interval_end_utc);
    const last = cursor.get(row.device_id);
    if (last !== undefined && start < last) target.overlap = true;
    const uniqueSeconds = Math.max(0, (end - Math.max(start, last ?? start)) / 1000);
    target.seconds += uniqueSeconds;
    cursor.set(row.device_id, Math.max(end, last ?? end));
    target.energy += row.energy_kwh;
    target.avgPowerNumerator += row.avg_power_w * uniqueSeconds;
    target.peakPower = target.peakPower === null ? row.max_power_w : Math.max(target.peakPower, row.max_power_w);
    target.partial ||= row.partial === 1;
    target.intervalCount++;
  }
  const deviceRows = devices.map((device) => {
    const item = result.get(device.device_id)!;
    const complete = expectedPerDevice > 0 && item.seconds === expectedPerDevice && !item.partial && !item.overlap;
    return { device, ...item, expectedSeconds: expectedPerDevice, complete };
  });
  return { deviceRows, expectedSeconds: expectedPerDevice * devices.length,
    coveredSeconds: deviceRows.reduce((n, item) => n + item.seconds, 0),
    complete: devices.length > 0 && deviceRows.every((item) => item.complete) };
}

function tariff(database: AuditorDatabase): number | null {
  const row = database.db.prepare('SELECT rate_per_kwh FROM user_tariff_settings WHERE user_id=?').get('local') as { rate_per_kwh: number } | undefined;
  return row?.rate_per_kwh ?? null;
}

export function getBreakdown(database: AuditorDatabase, dataset: DatasetRow, window: HistoricalWindow, scope: HistoricalScope, kind: 'rooms' | 'devices', page: number, pageSize: number) {
  assertTimezone(dataset);
  assertScope(database, dataset.dataset_id, scope);
  const inventory = getInventory(database, dataset.dataset_id, scope);
  const intervals = rows(database, dataset.dataset_id, window, scope);
  const coverage = coverageByDevice(intervals, inventory.devices, window);
  const rate = tariff(database);
  const grouped = new Map<string, typeof coverage.deviceRows>();
  for (const item of coverage.deviceRows) {
    const key = kind === 'rooms' ? item.device.room_id : item.device.device_id;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  let entities: Array<Record<string, unknown>>;
  if (kind === 'devices') {
    entities = coverage.deviceRows.map((item) => ({
      device_id: item.device.device_id, room_id: item.device.room_id, name: item.device.device_name,
      device_type: item.device.device_type, quantity: item.device.quantity,
      nominal_rated_power_w: item.device.nominal_power_w,
      observed_energy_kwh: item.intervalCount ? item.energy : null,
      observed_cost_inr: item.intervalCount && rate !== null ? item.energy * rate : null,
      observed_average_power_w: item.seconds ? item.avgPowerNumerator / item.seconds : null,
      observed_peak_power_w: item.intervalCount ? item.peakPower : null,
      coverage: { expected_seconds: item.expectedSeconds, covered_seconds: item.seconds,
        status: item.complete ? 'complete' : item.seconds ? 'partial' : 'missing', interval_count: item.intervalCount,
        source_partial: item.partial, overlap_detected: item.overlap },
    }));
  } else {
    const roomMetadata = inventory.rooms;
    entities = roomMetadata.map((room) => {
      const group = grouped.get(room.room_id) ?? [];
      const observed = group.reduce((sum, item) => sum + item.energy, 0);
      const intervalCount = group.reduce((sum, item) => sum + item.intervalCount, 0);
      const expected = group.reduce((sum, item) => sum + item.expectedSeconds, 0);
      const covered = group.reduce((sum, item) => sum + item.seconds, 0);
      const complete = group.length > 0 && group.every((item) => item.complete);
      const powerNumerator = group.reduce((sum, item) => sum + item.avgPowerNumerator, 0);
      return { room_id: room.room_id, name: room.room_name, room_type: room.room_type, floor_area_m2: room.floor_area_m2,
        observed_energy_kwh: intervalCount ? observed : null,
        observed_cost_inr: intervalCount && rate !== null ? observed * rate : null,
        observed_average_power_w: covered ? powerNumerator / covered : null,
        observed_peak_power_w: intervalCount ? Math.max(...group.map((item) => item.peakPower ?? 0)) : null,
        coverage: { expected_device_count: group.length, expected_seconds: expected, covered_seconds: covered,
          status: complete ? 'complete' : covered ? 'partial' : 'missing', interval_count: intervalCount,
          partial_device_count: group.filter((item) => !item.complete && item.seconds > 0).length,
          missing_device_count: group.filter((item) => !item.seconds).length },
      };
    });
  }
  const total = entities.length;
  const offset = (page - 1) * pageSize;
  const pageItems = entities.slice(offset, offset + pageSize);
  const energyOf = (entity: Record<string, unknown>) => typeof entity.observed_energy_kwh === 'number' ? entity.observed_energy_kwh : null;
  const fullFilteredEnergy = sumKnown(entities.map(energyOf));
  const pageEnergy = sumKnown(pageItems.map(energyOf));
  return { items: pageItems, total, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    dataset_id: dataset.dataset_id, provenance: { synthetic: dataset.synthetic === 1, synthetic_label: dataset.synthetic_label },
    window: { from_utc: window.fromUtc, to_utc: window.toUtc }, tariff_inr_per_kwh: rate,
    full_filtered_observed_energy_kwh: fullFilteredEnergy,
    full_filtered_observed_cost_inr: fullFilteredEnergy !== null && rate !== null ? fullFilteredEnergy * rate : null,
    full_filtered_complete: entities.length > 0 && entities.every((entity) => (entity.coverage as { status: string }).status === 'complete'),
    page_observed_energy_kwh: pageEnergy,
    page_observed_cost_inr: pageEnergy !== null && rate !== null ? pageEnergy * rate : null,
    aggregation: 'sum of persisted device interval energy_kwh; room energy is the sum of its device intervals; quantity is not applied' };
}

export function getTimeseries(database: AuditorDatabase, dataset: DatasetRow, window: HistoricalWindow, scope: HistoricalScope,
  bucketSeconds: number, page: number, pageSize: number) {
  assertTimezone(dataset);
  assertScope(database, dataset.dataset_id, scope);
  const resolution = dataset.source_resolution_seconds;
  if (!Number.isSafeInteger(bucketSeconds) || bucketSeconds < resolution || bucketSeconds % resolution !== 0
    || ![60, 300, 600, 900, 1800, 3600, 86_400].includes(bucketSeconds))
    throw new HistoricalInputError('UNSUPPORTED_INPUT', `bucket_seconds must be one of 60, 300, 600, 900, 1800, 3600, 86400 and a multiple of source resolution (${resolution})`, 'bucket_seconds');
  const bucketOffset = IST;
  if ((window.from + bucketOffset) % (bucketSeconds * 1000) !== 0 || (window.to + bucketOffset) % (bucketSeconds * 1000) !== 0)
    throw new HistoricalInputError('UNSUPPORTED_INPUT', 'Window boundaries must align to the selected bucket; choose a compatible from_utc/to_utc or bucket_seconds', 'bucket_seconds');
  const inventory = getInventory(database, dataset.dataset_id, scope);
  const intervals = rows(database, dataset.dataset_id, window, scope);
  const rate = tariff(database);
  const offset = IST;
  const startBucket = Math.floor((window.from + offset) / (bucketSeconds * 1000)) * bucketSeconds * 1000 - offset;
  const count = Math.round((window.to - window.from) / (bucketSeconds * 1000));
  const offsetPage = (page - 1) * pageSize;
  const pageEnd = offsetPage + pageSize;
  const pageItems: Array<Record<string, unknown>> = [];
  let totalEnergy: number | null = null;
  let pageEnergy: number | null = null;
  let allComplete = count > 0;
  const byKey = new Map<string, EnergyInterval[]>();
  for (const row of intervals) {
    const start = Date.parse(row.interval_start_utc); const end = Date.parse(row.interval_end_utc);
    const key = String(Math.floor((start + offset) / (bucketSeconds * 1000)) * bucketSeconds * 1000 - offset);
    if (end > Number(key) + bucketSeconds * 1000)
      throw new HistoricalInputError('UNSUPPORTED_INPUT', 'A persisted interval crosses the selected bucket boundary and cannot be prorated; choose a bucket that contains the source interval');
    const bucketRows = byKey.get(key);
    if (bucketRows) bucketRows.push(row); else byKey.set(key, [row]);
  }
  for (let index = 0; index < count; index++) {
    const start = startBucket + index * bucketSeconds * 1000;
    const end = start + bucketSeconds * 1000;
    if (start < window.from || end > window.to) throw new HistoricalInputError('UNSUPPORTED_INPUT', 'Window boundaries do not contain complete selected buckets');
    const expectedStart = Math.max(start, window.from);
    const expectedEnd = Math.min(end, window.to);
    const expectedPerDevice = Math.max(0, (expectedEnd - expectedStart) / 1000);
    const bucketRows = byKey.get(String(start)) ?? [];
    const bucketWindow = { ...window, fromUtc: iso(start), toUtc: iso(end), from: start, to: end };
    const covered = coverageByDevice(bucketRows, inventory.devices, bucketWindow);
    const status = covered.complete ? 'complete' : covered.coveredSeconds ? 'partial' : 'missing';
    const energy = bucketRows.length ? bucketRows.reduce((sum, row) => sum + row.energy_kwh, 0) : null;
    if (energy !== null) totalEnergy = (totalEnergy ?? 0) + energy;
    if (status !== 'complete') allComplete = false;
    if (index >= offsetPage && index < pageEnd) {
      if (energy !== null) pageEnergy = (pageEnergy ?? 0) + energy;
      pageItems.push({ start_utc: iso(start), end_utc: iso(end), energy_kwh: energy,
        cost_inr: energy !== null && rate !== null ? energy * rate : null,
      coverage: { status, expected_seconds: expectedPerDevice * inventory.devices.length,
        covered_seconds: covered.coveredSeconds, expected_device_count: inventory.devices.length,
        covered_device_count: covered.deviceRows.filter((item) => item.seconds > 0).length,
        partial_source_intervals: bucketRows.filter((row) => row.partial === 1).length },
      });
    }
  }
  return { dataset_id: dataset.dataset_id, timezone: dataset.timezone,
    provenance: { synthetic: dataset.synthetic === 1, synthetic_label: dataset.synthetic_label },
    window: { from_utc: window.fromUtc, to_utc: window.toUtc },
    bucket_seconds: bucketSeconds, scope: scope.deviceId ? { type: 'device', device_id: scope.deviceId }
      : scope.roomId ? { type: 'room', room_id: scope.roomId } : { type: 'office' },
    tariff_inr_per_kwh: rate, full_period_observed_energy_kwh: totalEnergy,
    full_period_observed_cost_inr: totalEnergy !== null && rate !== null ? totalEnergy * rate : null,
    full_period_complete: allComplete,
    items: pageItems,
    pagination: { page, page_size: pageSize, total: count, total_pages: Math.ceil(count / pageSize) },
    page_observed_energy_kwh: pageEnergy,
    page_observed_cost_inr: pageEnergy !== null && rate !== null ? pageEnergy * rate : null,
  };
}

export function getWeekdays(database: AuditorDatabase, dataset: DatasetRow, window: HistoricalWindow, scope: HistoricalScope) {
  assertTimezone(dataset);
  assertScope(database, dataset.dataset_id, scope);
  const inventory = getInventory(database, dataset.dataset_id, scope);
  const intervals = rows(database, dataset.dataset_id, window, scope);
  if (intervals.some((row) => Math.floor((Date.parse(row.interval_start_utc) + IST) / DAY)
    !== Math.floor((Date.parse(row.interval_end_utc) - 1 + IST) / DAY)))
    throw new HistoricalInputError('UNSUPPORTED_INPUT', 'A source interval crosses a local calendar-day boundary and cannot be assigned exactly to one weekday');
  const byDay = new Map<number, EnergyInterval[]>();
  for (const row of intervals) {
    const localDay = Math.floor((Date.parse(row.interval_start_utc) + IST) / DAY);
    const dayRows = byDay.get(localDay);
    if (dayRows) dayRows.push(row); else byDay.set(localDay, [row]);
  }
  const firstDay = Math.floor((window.from + IST) / DAY);
  const lastDay = Math.floor((window.to - 1 + IST) / DAY);
  const days: Array<{ weekday: number; energy: number; complete: boolean; observed: boolean }> = [];
  const weekdayTotals = Array.from({ length: 7 }, () => ({ energy: 0, completeDays: 0, partialDays: 0, completeEnergy: 0, observedDays: 0 }));
  for (let day = firstDay; day <= lastDay; day++) {
    const start = day * DAY - IST; const end = start + DAY;
    const dayWindow = { ...window, from: start, to: end, fromUtc: iso(start), toUtc: iso(end) };
    const expectedStart = Math.max(start, window.from, Date.parse(dataset.start_utc));
    const expectedEnd = Math.min(end, window.to, Date.parse(dataset.end_utc));
    const allExpectedDeviceSeconds = Math.max(0, (expectedEnd - expectedStart) / 1000) * inventory.devices.length;
    const covered = coverageByDevice(byDay.get(day) ?? [], inventory.devices, dayWindow);
    const dayRows = byDay.get(day) ?? [];
    const observed = dayRows.length > 0;
    const complete = allExpectedDeviceSeconds === 86_400 * inventory.devices.length
      && start >= window.from && end <= window.to && covered.complete;
    const weekday = new Date(day * DAY).getUTCDay();
    const group = weekdayTotals[weekday]!;
    if (observed) { group.energy += dayRows.reduce((sum, row) => sum + row.energy_kwh, 0); group.observedDays++; }
    if (complete) { group.completeDays++; group.completeEnergy += dayRows.reduce((sum, row) => sum + row.energy_kwh, 0); }
    else if (observed) group.partialDays++;
    days.push({ weekday, energy: dayRows.reduce((sum, row) => sum + row.energy_kwh, 0), complete, observed });
  }
  const rate = tariff(database);
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
    const value = weekdayTotals[weekday]!;
    return { weekday: names[weekday], weekday_number_iso: weekday === 0 ? 7 : weekday,
      observed_energy_total_kwh: value.observedDays ? value.energy : null,
      observed_cost_inr: value.observedDays && rate !== null ? value.energy * rate : null,
      complete_day_count: value.completeDays, partial_day_count: value.partialDays,
      mean_energy_per_complete_day_kwh: value.completeDays ? value.completeEnergy / value.completeDays : null,
      coverage_note: 'Calendar weekdays in Asia/Kolkata; partial and missing days are excluded from complete-day mean. Office-hours policy is not applied.' };
  });
  return { dataset_id: dataset.dataset_id, timezone: dataset.timezone,
    provenance: { synthetic: dataset.synthetic === 1, synthetic_label: dataset.synthetic_label }, calendar: 'calendar_weekday_only',
    window: { from_utc: window.fromUtc, to_utc: window.toUtc }, tariff_inr_per_kwh: rate, weekdays,
    coverage: { complete_day_count: days.filter((day) => day.complete).length,
      partial_day_count: days.filter((day) => !day.complete && day.observed).length,
      missing_day_count: days.filter((day) => !day.observed).length,
      note: 'A complete local calendar day requires every expected device to cover the entire expected export period without partial or overlapping source intervals.' } };
}
