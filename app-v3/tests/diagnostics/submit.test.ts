import { describe, it, expect, vi } from 'vitest';
import {
  copyBundleToClipboard,
  submitDiagnostics,
  type SubmitDeps,
} from '../../src/diagnostics/submit';
import type { DiagnosticsBundle } from '../../src/types/diagnostics';

const bundle: DiagnosticsBundle = {
  filename: 'octopus-tariff-diagnostics-x.json',
  mimeType: 'application/json',
  content: '{"hello":"world"}',
  byteLength: 17,
};

function fallbackDeps(): SubmitDeps {
  return { download: vi.fn(), openMailto: vi.fn() };
}

describe('submitDiagnostics', () => {
  it('uses the Web Share sheet when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const deps: SubmitDeps = {
      ...fallbackDeps(),
      canShare: () => true,
      share,
      makeFile: () => ({}),
    };
    const res = await submitDiagnostics(bundle, deps, { explanation: 'it broke' });
    expect(res.method).toBe('web-share');
    expect(res.sharedFile).toBe(true);
    expect(share).toHaveBeenCalledOnce();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('treats an AbortError (user dismissed the sheet) as cancelled, not a fallback', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const deps: SubmitDeps = {
      ...fallbackDeps(),
      canShare: () => true,
      share: vi.fn().mockRejectedValue(abort),
      makeFile: () => ({}),
    };
    const res = await submitDiagnostics(bundle, deps);
    expect(res.method).toBe('cancelled');
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('falls back to download + mailto when share throws a non-abort error', async () => {
    const deps: SubmitDeps = {
      ...fallbackDeps(),
      canShare: () => true,
      share: vi.fn().mockRejectedValue(new Error('not allowed')),
      makeFile: () => ({}),
    };
    const res = await submitDiagnostics(bundle, deps);
    expect(res.method).toBe('fallback');
    expect(deps.download).toHaveBeenCalledOnce();
    expect(deps.openMailto).toHaveBeenCalledOnce();
  });

  it('falls back when Web Share is unavailable, building a prefilled mailto — never auto-copies', async () => {
    const deps = fallbackDeps();
    const res = await submitDiagnostics(bundle, deps, {
      recipient: 'support@example.test',
      explanation: 'my bill looks wrong',
    });
    expect(res.method).toBe('fallback');
    expect(res.downloaded).toBe(true);
    expect(deps.download).toHaveBeenCalledOnce();

    const url = (deps.openMailto as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toMatch(/^mailto:support@example\.test\?/);
    expect(url).toContain(encodeURIComponent('my bill looks wrong'));
    // the privacy note about no secrets is always included
    expect(decodeURIComponent(url)).toContain('no API key');
  });
});

describe('copyBundleToClipboard', () => {
  it('copies the bundle only when explicitly invoked', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const ok = await copyBundleToClipboard(bundle, copy);
    expect(ok).toBe(true);
    expect(copy).toHaveBeenCalledWith(bundle.content);
  });

  it('reports failure without throwing', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('denied'));
    expect(await copyBundleToClipboard(bundle, copy)).toBe(false);
  });
});
