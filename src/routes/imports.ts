import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import multer from 'multer';
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import type { AuditorDatabase } from '../db/database.js';
import { sendData, sendError } from '../http/envelope.js';
import { ImportError } from '../imports/errors.js';
import { MAX_FILE_BYTES, parseCsv, parseJson, sniffFormat } from '../imports/parse.js';
import { validateAndFingerprint } from '../imports/validate.js';

const LOCAL_USER_ID = 'local';

declare module 'express-serve-static-core' {
  interface Request { uploadTempDir?: string; }
}

function cleanup(req: Request): void {
  const directory = req.uploadTempDir;
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    delete req.uploadTempDir;
  }
}

function uploadSingleFile(maxBytes: number): RequestHandler {
  const storage = multer.diskStorage({
    destination(req, _file, callback) {
      try {
        const directory = mkdtempSync(join(tmpdir(), 'nexyra-auditor-upload-'));
        req.uploadTempDir = directory;
        callback(null, directory);
      } catch (error) { callback(error as Error, ''); }
    },
    filename(_req, _file, callback) { callback(null, randomUUID()); },
  });
  const parser = multer({ storage, limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 } }).single('file');
  const middleware: RequestHandler = (req, res, next) => {
    parser(req, res, (error: unknown) => {
      if (error) {
        cleanup(req);
        const code = (error as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
          sendError(res, 413, { code: 'REQUEST_TOO_LARGE', message: `Upload exceeds ${maxBytes} bytes` });
          return;
        }
        if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT') {
          sendError(res, 413, { code: 'REQUEST_TOO_LARGE', message: 'Upload must contain exactly one file and no form fields' });
          return;
        }
        sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Expected one multipart file in field "file" and no other fields' });
        return;
      }
      next();
    });
  };
  return middleware;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sendImportError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ImportError) {
    sendError(res, error.status, { code: error.code, message: error.message,
      ...(error.field ? { field: error.field } : {}), ...(error.row ? { row: error.row } : {}),
      ...(error.report ? { details: error.report } : {}) });
  } else if (error instanceof Error && error.message.startsWith('Export identity conflict:')) {
    sendError(res, 409, { code: 'CONFLICT', message: error.message });
  } else next(error);
}

export function importsRouter(database: AuditorDatabase, maxUploadBytes = MAX_FILE_BYTES): Router {
  const router = Router();
  const upload = uploadSingleFile(maxUploadBytes);

  router.post('/imports', upload, async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Multipart field "file" is required', field: 'file' });
        return;
      }
      const sourceFormat = sniffFormat(file.path, file.originalname);
      const parsed = sourceFormat === 'csv' ? await parseCsv(file.path) : await parseJson(file.path);
      const validated = validateAndFingerprint(parsed.data, parsed.sourceFormat, parsed.duplicatesDeduped);
      const fileSha256 = await sha256File(file.path);
      const stored = database.storeDataset({
        datasetId: randomUUID(), sourceFormat: parsed.sourceFormat,
        sourceResolutionSeconds: parsed.sourceResolutionSeconds,
        semanticFingerprint: validated.semanticFingerprint, fileSha256,
        data: validated.data,
      });
      sendData(res, {
        dataset_id: stored.datasetId,
        run_id: validated.data.run.run_id,
        status: stored.inserted ? 'accepted' : 'already_imported',
        already_imported: !stored.inserted,
        report: validated.report,
      }, stored.inserted ? 201 : 200);
    } catch (error) { sendImportError(error, res, next); }
    finally { cleanup(req); }
  });

  router.get('/imports', (_req, res) => sendData(res, database.listDatasets()));

  router.get('/imports/:id/summary', (req, res) => {
    const summary = database.getDatasetSummary(req.params.id!);
    if (!summary) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return; }
    sendData(res, summary);
  });

  router.put('/imports/:id/tariff', (req, res) => {
    const value: unknown = req.body?.inr_per_kwh;
    if (!database.hasDataset(req.params.id!)) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Dataset was not found' }); return; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      sendError(res, 422, { code: 'VALIDATION_ERROR', message: 'inr_per_kwh must be a finite nonnegative number', field: 'inr_per_kwh' });
      return;
    }
    database.setTariff(LOCAL_USER_ID, value, 'INR');
    sendData(res, { dataset_id: req.params.id, inr_per_kwh: value });
  });
  return router;
}
