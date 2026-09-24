import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Assigns a server-generated request id, returned in meta.request_id and X-Request-Id. */
export const requestId: RequestHandler = (_req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};
