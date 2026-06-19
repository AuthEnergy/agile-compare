import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDiagnosticsModal, type DiagModalDeps } from '../../src/ui/diagnosticsModal';
import { buildExportDiagnostics } from '../../src/diagnostics/capture';
import { makeExportRun } from '../diagnostics/runFactory';
import type { DiagnosticsBundle } from '../../src/types/diagnostics';

function deps(onDownload: (b: DiagnosticsBundle) => void): DiagModalDeps {
  return { download: onDownload, openMailto: vi.fn(), copyToClipboard: vi.fn() };
}

describe('diagnostics modal — export-slot consent', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('persists the consent toggle into the downloaded bundle (no modal re-create)', () => {
    // The export diag carries raw slots; the bundle keeps them ONLY with consent.
    const diag = buildExportDiagnostics(makeExportRun(), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      includeDetailedExportSlots: true,
    });
    let downloaded = '';
    openDiagnosticsModal(
      { diagnostics: diag, ids: {}, isExport: true },
      deps((b) => {
        downloaded = b.content;
      }),
    );

    const sw = document.querySelector<HTMLButtonElement>('.switch');
    expect(sw).not.toBeNull();
    expect(sw?.getAttribute('aria-checked')).toBe('false');

    // toggle consent ON — must flip in place, not reset
    sw?.click();
    expect(sw?.getAttribute('aria-checked')).toBe('true');

    const dl = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Download bundle',
    );
    dl?.click();
    expect(downloaded).toContain('"raw"'); // raw export slots now included
  });

  it('omits raw export slots when consent is left off (privacy default)', () => {
    const diag = buildExportDiagnostics(makeExportRun(), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      includeDetailedExportSlots: true,
    });
    let downloaded = '';
    openDiagnosticsModal(
      { diagnostics: diag, ids: {}, isExport: true },
      deps((b) => {
        downloaded = b.content;
      }),
    );
    const dl = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Download bundle',
    );
    dl?.click();
    expect(downloaded).not.toContain('"raw"');
  });
});
