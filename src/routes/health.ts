import { Router } from 'express';
import { CONTRACT_VERSION } from '../contract.js';
import { sendData } from '../http/envelope.js';
import type { PythonAnalysisClient } from '../analysis/client.js';

/**
 * GET /api/v1/health — scaffold stage. The service is reachable; the Python
 * service is NOT probed (interservice connectivity belongs to F4), so
 * ml_reachable stays "not_checked" rather than claiming true/false.
 */
export function healthRouter(python?: PythonAnalysisClient): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const reachable = python ? await python.probe() : 'not_checked';
    sendData(res, {
      status: 'ok',
      contract_version: CONTRACT_VERSION,
      ml_reachable: reachable,
    });
  });
  return router;
}
