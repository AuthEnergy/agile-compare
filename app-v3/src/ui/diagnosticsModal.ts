import { buildDiagnosticsBundle } from '../diagnostics/bundle';
import { copyBundleToClipboard, submitDiagnostics, type SubmitDeps } from '../diagnostics/submit';
import type { PiiIdentifiers } from '../domain/redact';
import type { AnyDiagnostics, BundlePolicy, DiagnosticsBundle } from '../types/diagnostics';
import { button, callout, switchRow } from './components';
import { el, icon } from './dom';
import { ICONS } from './icons';

export interface DiagModalDeps extends SubmitDeps {
  copyToClipboard: (text: string) => void | Promise<void>;
}

export interface DiagModalInput {
  diagnostics: AnyDiagnostics;
  ids: PiiIdentifiers;
  isExport: boolean;
}

const INCLUDED = [
  'App version and import/export',
  'Anonymised period summaries and confidence flags',
  'Which rates matched and which slots were missing',
  'Outward postcode area only (e.g. BS1)',
];
const REMOVED = [
  'API key',
  'MPAN',
  'Meter serial',
  'Full address',
  'Full postcode',
  'Account number',
];

// The diagnostics modal: manual only, nothing auto-uploaded. Builds an
// anonymised bundle from the current diagnostics + live identifiers (for the
// belt-and-braces redaction pass) and offers download / submit / copy.
export function openDiagnosticsModal(input: DiagModalInput, deps: DiagModalDeps): void {
  let note = '';
  let exportConsent = false;

  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = (): void => backdrop.remove();
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });

  const buildBundle = (): DiagnosticsBundle => {
    const policy: BundlePolicy = input.isExport
      ? { includeDetailedExportSlots: exportConsent }
      : {};
    return buildDiagnosticsBundle({ diagnostics: input.diagnostics, ids: input.ids, policy });
  };

  const status = el('span', { class: 'row-sub' });
  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const noteField = el('textarea', {
    class: 'textarea',
    placeholder: 'e.g. May looks wrong — bill and readings don’t match.',
    onInput: (ev) => {
      note = (ev.target as HTMLTextAreaElement).value;
    },
  });

  const included = el(
    'div',
    {
      style:
        'display:flex;flex-direction:column;gap:7px;padding:13px;background:var(--status-saving-bg);border:1px solid var(--border-soft);border-radius:var(--radius-md)',
    },
    [
      el('span', {
        style: 'font-size:var(--text-body-sm);font-weight:600;color:var(--status-saving)',
        text: 'Included',
      }),
      ...INCLUDED.map((i) => el('span', { class: 'row-sub', text: `• ${i}` })),
    ],
  );
  const removed = el(
    'div',
    {
      style:
        'display:flex;flex-direction:column;gap:7px;padding:13px;background:var(--surface-sunken);border:1px solid var(--border-soft);border-radius:var(--radius-md)',
    },
    [
      el('span', {
        style: 'font-size:var(--text-body-sm);font-weight:600;color:var(--text-strong)',
        text: 'Always removed',
      }),
      ...REMOVED.map((e) => el('span', { class: 'row-sub', text: `• ${e}` })),
    ],
  );

  // Export-slot consent: toggle IN PLACE (no modal re-create) so the value
  // actually persists into the bundle. Off by default (privacy-preserving).
  let consentSwitch: HTMLElement | null = null;
  if (input.isExport) {
    consentSwitch = switchRow({
      label: 'Include detailed export slots',
      description:
        'Privacy-sensitive: raw half-hour export times can reveal when you generate. Off by default.',
      checked: exportConsent,
      onChange: () => {
        exportConsent = !exportConsent;
        consentSwitch?.setAttribute('aria-checked', String(exportConsent));
      },
    });
  }

  const body = el('div', { class: 'modal-body' }, [
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' }, [
      included,
      removed,
    ]),
    callout(
      'Redacted by policy',
      'Your postcode is reduced to its outward area only (e.g. BS1). Key, MPAN, serial, address and account number are never included.',
      'info',
      'lock',
    ),
    consentSwitch,
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Add a note (optional)' }),
      noteField,
    ]),
    callout(
      'If you send by email',
      "Some email apps won't attach the file for you. Use Copy to paste the bundle yourself, or Download and attach it.",
      'caution',
      'info',
    ),
    status,
  ]);

  const onDownload = (): void => {
    deps.download(buildBundle());
    setStatus('Downloaded to your device.');
  };
  const onCopy = async (): Promise<void> => {
    const ok = await copyBundleToClipboard(buildBundle(), deps.copyToClipboard);
    setStatus(ok ? 'Copied to your clipboard.' : 'Could not copy — use Download instead.');
  };
  const onSubmit = async (): Promise<void> => {
    const res = await submitDiagnostics(buildBundle(), deps, { explanation: note });
    setStatus(
      res.method === 'web-share'
        ? 'Shared via your device’s share sheet.'
        : res.method === 'cancelled'
          ? 'Share cancelled.'
          : 'Downloaded + email drafted. Attach or paste the bundle.',
    );
  };

  const head = el('div', { class: 'modal-head' }, [
    el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
      el('span', {
        style: 'font-size:var(--text-h3);font-weight:700;color:var(--ink)',
        text: 'Diagnostics',
      }),
      el('span', {
        class: 'row-sub',
        text: 'Nothing leaves your device unless you send it.',
      }),
    ]),
    el('button', { class: 'icon-btn', type: 'button', ariaLabel: 'Close', onClick: close }, [
      icon(ICONS.x, 18),
    ]),
  ]);

  const foot = el('div', { class: 'modal-foot' }, [
    button('Copy', { variant: 'secondary', onClick: () => void onCopy() }),
    button('Download bundle', { variant: 'secondary', onClick: onDownload }),
    button('Submit to support', { variant: 'primary', onClick: () => void onSubmit() }),
  ]);

  backdrop.append(el('div', { class: 'modal' }, [head, body, foot]));
  document.body.append(backdrop);
}
