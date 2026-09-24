import type { Response } from 'express';

/** Stable error codes (contracts/v1/API.md) plus INTERNAL_ERROR for unexpected faults. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_VERSION'
  | 'MODEL_UNAVAILABLE'
  | 'INSUFFICIENT_DATA'
  | 'REQUEST_TOO_LARGE'
  | 'JOB_FAILED'
  | 'INTERNAL_ERROR';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  field?: string;
  row?: number;
}

/** Contract success envelope: { data, meta: { request_id } }. */
export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { request_id: res.locals.requestId as string } });
}

/** Contract error envelope: { error: { code, message, field?, row? } }. */
export function sendError(res: Response, status: number, error: ErrorBody): void {
  res.status(status).json({ error });
}
