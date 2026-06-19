import { DIAGNOSTICS_RECIPIENT } from '../config';
import type { DiagnosticsBundle } from '../types/diagnostics';

// Side-effects the UI provides — all injectable so this module is DOM/navigator
// free and unit-testable. Absent Web Share hooks force the fallback path.
export interface SubmitDeps {
  canShare?: (data: unknown) => boolean;
  share?: (data: unknown) => Promise<void>;
  // Turn the bundle into a File for Web Share (needs DOM, so injected).
  makeFile?: (bundle: DiagnosticsBundle) => unknown;
  // Fallback channels.
  download: (bundle: DiagnosticsBundle) => void;
  openMailto: (url: string) => void;
}

export interface SubmitOptions {
  recipient?: string;
  explanation?: string;
  subject?: string;
}

export type SubmitMethod = 'web-share' | 'cancelled' | 'fallback';

export interface SubmitResult {
  method: SubmitMethod;
  // True only when the OS share sheet actually received the file.
  sharedFile: boolean;
  // Which fallback channels fired (for the UI to confirm to the user).
  downloaded: boolean;
  mailto: boolean;
}

function isAbort(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

function mailBody(explanation: string): string {
  const note =
    'The diagnostics JSON has been downloaded to your device — please attach it to this email. ' +
    'It contains no API key, meter number (MPAN), meter serial, full address, or account number.';
  return explanation ? `${explanation}\n\n${note}` : note;
}

// Submit a diagnostics bundle to support WITHOUT a backend. Prefers the Web
// Share sheet (no network, CSP-safe); falls back to a download + a prefilled
// mailto (a navigation, also CSP-safe) and an optional clipboard copy. Returns
// which path was taken so the UI can confirm it to the user.
export async function submitDiagnostics(
  bundle: DiagnosticsBundle,
  deps: SubmitDeps,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const recipient = opts.recipient ?? DIAGNOSTICS_RECIPIENT;
  const explanation = (opts.explanation ?? '').trim();
  const subject = opts.subject ?? 'Octopus Tariff Check diagnostics';

  if (deps.canShare && deps.share && deps.makeFile) {
    const file = deps.makeFile(bundle);
    const shareData = {
      files: [file],
      title: subject,
      text: explanation || 'Octopus Tariff Check diagnostics attached.',
    };
    if (deps.canShare(shareData)) {
      try {
        await deps.share(shareData);
        return { method: 'web-share', sharedFile: true, downloaded: false, mailto: false };
      } catch (err) {
        if (isAbort(err)) {
          // User dismissed the sheet — respect that, don't silently fall back.
          return { method: 'cancelled', sharedFile: false, downloaded: false, mailto: false };
        }
        // Any other share failure → fall through to the fallback channels.
      }
    }
  }

  deps.download(bundle);
  const url = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    mailBody(explanation),
  )}`;
  deps.openMailto(url);
  return { method: 'fallback', sharedFile: false, downloaded: true, mailto: true };
}

// Copy the bundle to the clipboard. SEPARATE, explicit action — never automatic:
// an import bundle carries raw half-hour readings, so an auto clipboard write is
// a privacy footgun. The UI exposes this only behind a deliberate "Copy" button.
export async function copyBundleToClipboard(
  bundle: DiagnosticsBundle,
  copy: (text: string) => void | Promise<void>,
): Promise<boolean> {
  try {
    await copy(bundle.content);
    return true;
  } catch {
    return false;
  }
}
