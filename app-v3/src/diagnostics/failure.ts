import { OctopusApiError } from '../api/client';
import { APP_VERSION } from '../config';
import { redactPII, type PiiIdentifiers } from '../domain/redact';
import type { Agreement } from '../types/domain';
import type { FailureDiagnostics } from '../types/diagnostics';

export interface FailureMeterSummary {
  serialCount: number;
  isExport: boolean;
  currentTariff: string | null;
}

// Everything the UI knows at the point of failure, assembled DOM-free so this
// module stays pure. The UI gathers these from AppState + account helpers (and
// scrapes the progress-log lines) before calling captureFailureDiag.
export interface FailureContext {
  accountNumber: string | null;
  serialCount: number;
  isExport: boolean;
  postcodeArea: string | null;
  agreements: Agreement[];
  metersOnAccount: FailureMeterSummary[];
  progressLog: string[];
}

export interface FailureCaptureOptions {
  generatedAt: string;
  appVersion?: string;
  // Debug-only escape hatch. Default (false) omits the account number, matching
  // the success-bundle policy. Even when true, redactPII still runs over free
  // text — this only controls the structured `account.number` field.
  includeAccountNumber?: boolean;
}

function describeError(err: unknown, ids: PiiIdentifiers): FailureDiagnostics['error'] {
  if (err instanceof OctopusApiError) {
    return {
      message: redactPII(err.message, ids),
      type: 'OctopusApiError',
      status: err.status,
      corsLikely: err.corsLikely,
    };
  }
  if (err instanceof Error) {
    return {
      message: redactPII(err.message, ids),
      type: err.name || err.constructor.name || 'Error',
      status: null,
      corsLikely: false,
    };
  }
  return {
    message: redactPII(String(err), ids),
    type: 'Error',
    status: null,
    corsLikely: false,
  };
}

// Capture a failure diagnostic. PII-light: NO MPAN, serial, or address; the
// account number is omitted by default (policy-controlled). `ids` MUST carry the
// live identifiers (incl. accountNumber) so redactPII scrubs any that leaked
// into the error message or progress-log lines.
export function captureFailureDiag(
  err: unknown,
  ctx: FailureContext,
  ids: PiiIdentifiers,
  opts: FailureCaptureOptions,
): FailureDiagnostics {
  return {
    generatedAt: opts.generatedAt,
    appVersion: opts.appVersion ?? APP_VERSION,
    error: describeError(err, ids),
    account: {
      number: opts.includeAccountNumber ? ctx.accountNumber : null,
      serialCount: ctx.serialCount,
      isExport: ctx.isExport,
      postcodeArea: ctx.postcodeArea,
      agreements: (ctx.agreements || []).map((a) => ({
        tariffCode: a.tariff_code,
        validFrom: a.valid_from,
        validTo: a.valid_to || null,
      })),
      metersOnAccount: ctx.metersOnAccount,
    },
    progressLog: (ctx.progressLog || []).map((line) => redactPII(line, ids)),
  };
}
