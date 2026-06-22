import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock the network-touching modules so this exercises only the App's live-journey
// WIRING (connect → discover → meter picker → fetch → results). The flows
// themselves are covered by their own fetch-mocked unit tests.
vi.mock('../../src/api/account', () => ({
  obtainKrakenToken: vi.fn(async () => 'tok'),
  getPostcodeAreaForMpan: vi.fn(() => null),
  getAgreementsForMpan: vi.fn(() => []),
}));
vi.mock('../../src/api/client', () => ({
  createClient: vi.fn(() => ({})),
  OctopusApiError: class extends Error {},
}));
vi.mock('../../src/api/meters', () => ({ discoverMeters: vi.fn() }));
vi.mock('../../src/flows/runComparison', () => ({ runComparison: vi.fn() }));
vi.mock('../../src/flows/runExportComparison', () => ({ runExportComparison: vi.fn() }));
vi.mock('../../src/analytics/posthog', () => ({
  trackComparisonSuccess: vi.fn(),
  trackComparisonFailure: vi.fn(),
}));

import { App, type UiActions } from '../../src/ui/app';
import { discoverMeters, type MeterChoice } from '../../src/api/meters';
import { runComparison } from '../../src/flows/runComparison';
import { runExportComparison } from '../../src/flows/runExportComparison';
import { trackComparisonFailure, trackComparisonSuccess } from '../../src/analytics/posthog';
import { buildSampleRun } from '../../src/data/sample';
import type { ExportRun } from '../../src/types/result';
import type { AccountData } from '../../src/types/octopus';

const noActions: UiActions = { connect: () => {}, useSample: () => {}, replayFile: () => {} };

function meter(over: Partial<MeterChoice>): MeterChoice {
  return {
    accountNumber: 'A-MOCK',
    mpan: '1900000000001',
    serial: 'MOCK1',
    serials: ['MOCK1'],
    address: '1 Test St',
    tariffCode: 'E-1R-VAR-22-11-01-C',
    gsp: '_C',
    isExport: false,
    accountData: {} as AccountData,
    ...over,
  };
}

function clickButton(root: HTMLElement, label: string): void {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  btn.click();
}

function clickSwitch(root: HTMLElement, label: string): void {
  const btn = [...root.querySelectorAll('button[role="switch"]')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!btn) throw new Error(`switch "${label}" not found`);
  (btn as HTMLButtonElement).click();
}

const exportRun: ExportRun = {
  regionLetter: 'C',
  postcodeArea: 'BS1',
  currentAgreement: null,
  agreements: [],
  periodFrom: new Date('2025-01-01'),
  periodTo: new Date('2025-06-01'),
  exportKwh: 642,
  flat: { valuePence: 9630, unmatchedReadings: 0, products: ['OUTGOING'] },
  agile: { valuePence: 11847, unmatchedReadings: 0, products: ['AGILE-OUTGOING'] },
  gapInfo: { gaps: [], duplicates: [], earliest: null, latest: null },
  detail: { readings: [], flatWindows: [], agileWindows: [], duplicateIntervals: new Set() },
};

describe('App live-journey wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('connect → meter picker → fetch → import results', async () => {
    vi.mocked(discoverMeters).mockResolvedValue([meter({})]);
    vi.mocked(runComparison).mockResolvedValue(buildSampleRun());

    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();

    await app.runLive('sk_test_key');
    expect(root.textContent).toContain('Which meter?');
    expect(root.textContent).toContain('Import meter');

    clickButton(root, 'Fetch this meter');
    await vi.waitFor(() => expect(root.textContent).toContain('Your comparison'));
    expect(vi.mocked(runComparison)).toHaveBeenCalledOnce();
    expect(vi.mocked(trackComparisonSuccess)).toHaveBeenCalledOnce();
  });

  it('routes an export meter to the export results screen', async () => {
    vi.mocked(discoverMeters).mockResolvedValue([meter({ isExport: true })]);
    vi.mocked(runExportComparison).mockResolvedValue(exportRun);

    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();

    await app.runLive('sk_test_key');
    expect(root.textContent).toContain('Export meter');

    clickButton(root, 'Fetch this meter');
    await vi.waitFor(() => expect(root.textContent).toContain('Your export comparison'));
    expect(vi.mocked(runExportComparison)).toHaveBeenCalledOnce();
  });

  it('shows an error + a downloadable failure diagnostic when discovery fails', async () => {
    vi.mocked(discoverMeters).mockRejectedValue(new Error('No accounts found for this API key.'));

    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();

    await app.runLive('sk_bad');
    expect(root.textContent).toContain("That didn't work");
    expect(root.textContent).toContain('No accounts found');
    expect(vi.mocked(trackComparisonFailure)).toHaveBeenCalledOnce();

    // v2 parity: a failure diagnostic is offered for download/send.
    clickButton(root, 'Download diagnostics');
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    document.querySelector('.modal-backdrop')?.remove();
  });

  it('navigating home invalidates an in-flight run (concurrency guard)', async () => {
    vi.mocked(discoverMeters).mockResolvedValue([meter({})]);
    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();

    const p = app.runLive('sk_test_key'); // run #1 starts → fetch screen
    (root.querySelector('.brand [aria-label="Home"]') as HTMLElement | null)?.click(); // Home → reset, bumps runSeq
    await p; // the stale run must bail, NOT navigate to the meter picker

    expect(root.textContent).not.toContain('Which meter?');
    expect(root.textContent).toContain('would have cost'); // back on connect
  });

  it('does not send analytics on first load', () => {
    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();

    expect(vi.mocked(trackComparisonSuccess)).not.toHaveBeenCalled();
    expect(vi.mocked(trackComparisonFailure)).not.toHaveBeenCalled();
  });

  it('does not send failure analytics after the user unticks sharing', async () => {
    vi.mocked(discoverMeters).mockRejectedValue(new Error('No accounts found for this API key.'));

    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();
    clickSwitch(root, 'Share anonymous results with Auth Energy');

    await app.runLive('sk_bad');

    expect(vi.mocked(trackComparisonFailure)).not.toHaveBeenCalled();
  });

  it('does not send success analytics when the saved preference is off', async () => {
    localStorage.setItem('otc-analytics-consent', 'false');
    vi.mocked(discoverMeters).mockResolvedValue([meter({})]);
    vi.mocked(runComparison).mockResolvedValue(buildSampleRun());

    const root = document.createElement('div');
    const app = new App(root, noActions);
    app.mount();

    await app.runLive('sk_test_key');
    clickButton(root, 'Fetch this meter');
    await vi.waitFor(() => expect(root.textContent).toContain('Your comparison'));

    expect(vi.mocked(trackComparisonSuccess)).not.toHaveBeenCalled();
  });
});
