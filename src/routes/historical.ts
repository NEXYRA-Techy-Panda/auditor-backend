import { Router } from 'express';
import type { AuditorDatabase } from '../db/database.js';
import { sendData, sendError } from '../http/envelope.js';
import { getBreakdown, getDataset, getTimeseries, getWeekdays, HistoricalInputError, parseWindow } from '../analytics/historical.js';

function pageParam(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new HistoricalInputError('VALIDATION_ERROR', `${field} must be a positive integer`, field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new HistoricalInputError('VALIDATION_ERROR', `${field} must be between 1 and 1000000`, field);
  return value;
}

function scopeFrom(query: Record<string, unknown>, kind: 'rooms' | 'devices' | 'timeseries' | 'weekday') {
  const allowed = new Set(kind === 'rooms' ? ['from', 'to', 'from_utc', 'to_utc', 'page', 'page_size']
    : kind === 'devices' ? ['from', 'to', 'from_utc', 'to_utc', 'room_id', 'page', 'page_size']
      : kind === 'timeseries' ? ['from', 'to', 'from_utc', 'to_utc', 'room_id', 'device_id', 'bucket_seconds', 'page', 'page_size']
        : ['from', 'to', 'from_utc', 'to_utc', 'room_id', 'device_id']);
  const unknown = Object.keys(query).find((key) => !allowed.has(key));
  if (unknown) throw new HistoricalInputError('VALIDATION_ERROR', `Unsupported query parameter: ${unknown}`, unknown);
  const roomId = query.room_id;
  const deviceId = query.device_id;
  if (roomId !== undefined && (typeof roomId !== 'string' || !roomId.trim())) throw new HistoricalInputError('VALIDATION_ERROR', 'room_id must be a non-empty string', 'room_id');
  if (deviceId !== undefined && (typeof deviceId !== 'string' || !deviceId.trim())) throw new HistoricalInputError('VALIDATION_ERROR', 'device_id must be a non-empty string', 'device_id');
  if (roomId !== undefined && deviceId !== undefined) throw new HistoricalInputError('VALIDATION_ERROR', 'Specify room_id or device_id, not both');
  return { ...(roomId ? { roomId } : {}), ...(deviceId ? { deviceId } : {}) };
}

function run(res: import('express').Response, work: () => unknown): void {
  try { const result = work(); if (result !== undefined) sendData(res, result); }
  catch (error) {
    if (error instanceof HistoricalInputError) {
      sendError(res, 422, { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
    } else throw error;
  }
}

export function historicalRouter(database: AuditorDatabase): Router {
  const router = Router();
  router.get('/imports/:id/rooms', (req, res) => run(res, () => {
    const dataset = getDataset(database, req.params.id!);
    if (!dataset) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return undefined; }
    const scope = scopeFrom(req.query as Record<string, unknown>, 'rooms');
    const window = parseWindow(req.query as Record<string, unknown>, dataset);
    const page = pageParam(req.query.page, 1, 'page'); const pageSize = pageParam(req.query.page_size, 50, 'page_size');
    if (pageSize > 2_000) throw new HistoricalInputError('VALIDATION_ERROR', 'page_size must be between 1 and 2000', 'page_size');
    return getBreakdown(database, dataset, window, scope, 'rooms', page, pageSize);
  }));
  router.get('/imports/:id/devices', (req, res) => run(res, () => {
    const dataset = getDataset(database, req.params.id!);
    if (!dataset) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return undefined; }
    const scope = scopeFrom(req.query as Record<string, unknown>, 'devices');
    const window = parseWindow(req.query as Record<string, unknown>, dataset);
    const page = pageParam(req.query.page, 1, 'page'); const pageSize = pageParam(req.query.page_size, 50, 'page_size');
    if (pageSize > 2_000) throw new HistoricalInputError('VALIDATION_ERROR', 'page_size must be between 1 and 2000', 'page_size');
    return getBreakdown(database, dataset, window, scope, 'devices', page, pageSize);
  }));
  router.get('/imports/:id/timeseries', (req, res) => run(res, () => {
    const dataset = getDataset(database, req.params.id!);
    if (!dataset) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return undefined; }
    const scope = scopeFrom(req.query as Record<string, unknown>, 'timeseries');
    const window = parseWindow(req.query as Record<string, unknown>, dataset);
    const page = pageParam(req.query.page, 1, 'page'); const pageSize = pageParam(req.query.page_size, 500, 'page_size');
    if (pageSize > 2_000) throw new HistoricalInputError('VALIDATION_ERROR', 'page_size must be between 1 and 2000', 'page_size');
    const raw = req.query.bucket_seconds;
    const bucket = raw === undefined ? dataset.source_resolution_seconds : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(bucket)) throw new HistoricalInputError('VALIDATION_ERROR', 'bucket_seconds must be an integer', 'bucket_seconds');
    return getTimeseries(database, dataset, window, scope, bucket, page, pageSize);
  }));
  router.get('/imports/:id/weekday-analytics', (req, res) => run(res, () => {
    const dataset = getDataset(database, req.params.id!);
    if (!dataset) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return undefined; }
    const scope = scopeFrom(req.query as Record<string, unknown>, 'weekday');
    const window = parseWindow(req.query as Record<string, unknown>, dataset);
    return getWeekdays(database, dataset, window, scope);
  }));
  return router;
}
