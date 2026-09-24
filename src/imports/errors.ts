import type { ErrorBody } from '../http/envelope.js';

export interface ValidationIssue { field: string; message: string; row?: number; }
export interface ImportReport { errors: ValidationIssue[]; warnings: string[]; duplicates_deduped: number; additional_errors: boolean; }

export class ImportError extends Error {
  constructor(readonly status: number, readonly code: ErrorBody['code'], message: string,
    readonly report?: ImportReport, readonly field?: string, readonly row?: number) {
    super(message);
  }
}

export function validationError(field: string, message: string, row?: number): ImportError {
  const issue: ValidationIssue = row === undefined ? { field, message } : { field, message, row };
  return new ImportError(422, 'VALIDATION_ERROR', 'Uploaded dataset failed validation',
    { errors: [issue], warnings: [], duplicates_deduped: 0, additional_errors: false }, field, row);
}
