import cors from 'cors';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import { errorHandler, notFound } from './http/errors.js';
import { requestId } from './http/requestId.js';
import { healthRouter } from './routes/health.js';
import { importsRouter } from './routes/imports.js';
import type { AuditorDatabase } from './db/database.js';

export function createApp(config: Config, database?: AuditorDatabase): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: config.frontendOrigin }));
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.use('/api/v1', healthRouter());
  if (database) app.use('/api/v1', importsRouter(database, config.uploadMaxBytes));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
