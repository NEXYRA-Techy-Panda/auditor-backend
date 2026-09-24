import cors from 'cors';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import { errorHandler, notFound } from './http/errors.js';
import { requestId } from './http/requestId.js';
import { healthRouter } from './routes/health.js';
import { importsRouter } from './routes/imports.js';
import type { AuditorDatabase } from './db/database.js';
import { analysisRouter } from './routes/analysis.js';
import type { AnalysisJobManager } from './analysis/jobs.js';
import type { PythonAnalysisClient } from './analysis/client.js';
import { forecastsRouter } from './routes/forecasts.js';

export function createApp(config: Config, database?: AuditorDatabase, services: { python?: PythonAnalysisClient; jobs?: AnalysisJobManager } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: config.frontendOrigin }));
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.use('/api/v1', healthRouter(services.python));
  if (database) app.use('/api/v1', importsRouter(database, config.uploadMaxBytes));
  if (database && services.jobs) {
    app.use('/api/v1', analysisRouter(services.jobs, database));
    app.use('/api/v1', forecastsRouter(services.jobs, database));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
