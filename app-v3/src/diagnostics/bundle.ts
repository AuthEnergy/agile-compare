import { redactPII, type PiiIdentifiers } from '../domain/redact';
import type {
  AnyDiagnostics,
  BundlePolicy,
  DiagnosticsBundle,
  ExportDiagnostics,
  FailureDiagnostics,
} from '../types/diagnostics';

export interface BuildBundleInput {
  // A diagnostics object already built by capture/failure.
  diagnostics: AnyDiagnostics;
  // Live identifiers, for the belt-and-braces redactPII string pass. MUST carry
  // mpan/serial(s)/apiKey/accountNumber so any that leaked into free text
  // (error messages, progress log) are scrubbed from the serialised output.
  ids: PiiIdentifiers;
  policy?: BundlePolicy;
  filenamePrefix?: string;
}

type DiagKind = 'import' | 'export' | 'failure';

function classify(diag: AnyDiagnostics): DiagKind {
  if ('error' in diag) return 'failure';
  if ('mode' in diag && diag.mode === 'export') return 'export';
  return 'import';
}

const DEFAULT_PREFIX: Record<DiagKind, string> = {
  import: 'octopus-tariff-diagnostics',
  export: 'octopus-tariff-export-diagnostics',
  failure: 'octopus-tariff-failure-diagnostics',
};

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function safeStamp(generatedAt: unknown): string {
  const iso = typeof generatedAt === 'string' && generatedAt ? generatedAt : 'unknown';
  // ISO → filesystem-safe; keep it sortable.
  return iso
    .replace(/:/g, '-')
    .replace(/\..*$/, '')
    .replace(/[^0-9A-Za-z-]/g, '');
}

// Build the anonymised, ready-to-save/share bundle shared by Download and
// Submit. Applies the privacy POLICY (defence-in-depth, even if capture already
// honoured it): export bundles are aggregate-only unless detailed-slots consent
// is given, and the failure bundle omits the account number unless an explicit
// debug policy keeps it. A final redactPII pass scrubs the serialised text.
export function buildDiagnosticsBundle(input: BuildBundleInput): DiagnosticsBundle {
  const policy = input.policy ?? {};
  const kind = classify(input.diagnostics);

  // Deep-clone via JSON (the diagnostics are pure JSON) so policy stripping never
  // mutates the caller's object.
  const obj = JSON.parse(JSON.stringify(input.diagnostics)) as AnyDiagnostics;

  if (kind === 'export' && !policy.includeDetailedExportSlots) {
    const exp = obj as ExportDiagnostics;
    if (exp.readings) delete exp.readings.raw;
  }
  if (kind === 'failure' && !policy.includeAccountNumber) {
    (obj as FailureDiagnostics).account.number = null;
  }

  // When the account number is deliberately kept (debug), don't scrub it from
  // free text; otherwise pass it to redactPII so stray copies are removed.
  const redactIds: PiiIdentifiers =
    kind === 'failure' && policy.includeAccountNumber
      ? { ...input.ids, accountNumber: null }
      : input.ids;

  const json = JSON.stringify(obj, null, 2);
  const content = (redactPII(json, redactIds) ?? json) as string;

  const prefix = input.filenamePrefix ?? DEFAULT_PREFIX[kind];
  const filename = `${prefix}-${safeStamp((obj as { generatedAt?: unknown }).generatedAt)}.json`;

  return {
    filename,
    mimeType: 'application/json',
    content,
    byteLength: byteLength(content),
  };
}
