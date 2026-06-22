import { badge, button, callout, inputField, switchRow } from './components';
import { clear, el, icon, logo } from './dom';
import { ICONS, LOGO_PATHS } from './icons';
import { clearApiKey, loadSavedApiKey, saveApiKey } from '../storage/credentials';
import { loadAnalyticsConsent, saveAnalyticsConsent } from '../storage/analyticsConsent';
import {
  initAnalytics,
  trackComparisonSuccess,
  trackComparisonFailure,
  type ComparisonFailureProps,
} from '../analytics/posthog';
import { computeHeadline } from '../domain/headline';
import { nextSteps } from '../journey/nextSteps';
import { getAgreementsForMpan, getPostcodeAreaForMpan, obtainKrakenToken } from '../api/account';
import { createClient, OctopusApiError, type OctopusClient } from '../api/client';
import { discoverMeters, type MeterChoice } from '../api/meters';
import { runComparison, type RunInput } from '../flows/runComparison';
import { runExportComparison } from '../flows/runExportComparison';
import { buildExportDiagnostics, buildImportDiagnostics } from '../diagnostics/capture';
import { captureFailureDiag, type FailureContext } from '../diagnostics/failure';
import type { PiiIdentifiers } from '../domain/redact';
import type { AnyDiagnostics, DiagnosticsBundle, FailureDiagnostics } from '../types/diagnostics';
import type { ComparisonRun, ExportRun, ProgressFn } from '../types/result';
import { renderResults, renderResultsEmpty } from './results';
import { computeShareClaims } from './share';
import { openTariffOverrideModal } from './tariffOverrideModal';
import { applyUserTariff } from '../flows/applyUserTariff';
import { renderExportResults } from './exportResults';
import { renderTiming } from './timing';
import { renderFooter } from './footer';
import { openDiagnosticsModal, type DiagModalDeps } from './diagnosticsModal';

function downloadBundle(bundle: DiagnosticsBundle): void {
  const blob = new Blob([bundle.content], { type: bundle.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bundle.filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type Screen = 'connect' | 'meter' | 'fetch' | 'results' | 'timing';

export interface UiState {
  screen: Screen;
  theme: 'light' | 'dark';
  apiKey: string;
  remember: boolean;
  statusMessage: string | null;
  error: string | null;
  fetchPct: number;
  fetchMessage: string;
  exportConsent: boolean;
  analyticsConsent: boolean;
}

export interface UiActions {
  // Start a live run from the connect screen (wired in main.ts).
  connect: () => void;
  useSample: () => void;
  replayFile: () => void;
}

const THEME_KEY = 'otc-theme';
const STEP_MAP: Record<Screen, { label: string; n: number }> = {
  connect: { label: 'Connect', n: 0 },
  meter: { label: 'Choose meter', n: 1 },
  fetch: { label: 'Reading your usage', n: 2 },
  results: { label: 'Your comparison', n: 3 },
  timing: { label: 'Save more', n: 4 },
};

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Check your API key and try again.';
}

function classifyError(err: unknown): Omit<ComparisonFailureProps, 'stage'> {
  if (err instanceof OctopusApiError) {
    return { errorType: 'OctopusApiError', httpStatus: err.status, corsLikely: err.corsLikely };
  }
  if (err instanceof Error) {
    return {
      errorType: err.name || err.constructor?.name || 'Error',
      httpStatus: null,
      corsLikely: false,
    };
  }
  return { errorType: 'Error', httpStatus: null, corsLikely: false };
}

// The app shell: owns UI state, paints the header / step progress / current
// screen, and re-renders on setState. Drill-down inside results is imperative
// (cached child DOM) and must NOT go through this whole-screen repaint.
export class App {
  private state: UiState;
  private root: HTMLElement;
  private actions: UiActions;
  private screenRenderers = new Map<Screen, (host: HTMLElement) => void>();
  private currentRun: ComparisonRun | null = null;
  private originalRun: ComparisonRun | null = null;
  private userTariffOverride: { unitRate: number; standingCharge: number } | null = null;
  private currentExport: ExportRun | null = null;
  private replayMeta: string | null = null;
  private liveClient: OctopusClient | null = null;
  private liveApiKey = '';
  private meters: MeterChoice[] = [];
  private selectedMeterIdx = 0;
  // The live meter behind the current results (null for sample/replay, whose
  // data is already anonymised). Used only for diagnostics redaction identifiers.
  private currentMeter: MeterChoice | null = null;
  private progressLog: string[] = [];
  // Built when a live run fails so the user can download/send a failure diagnostic
  // (v2 parity). Account number omitted by policy; ids scrub the rest from text.
  private failureDiag: FailureDiagnostics | null = null;
  // Monotonic run token: a newer run or a navigation bumps it, so stale async
  // completions bail instead of yanking the user back or interleaving two runs.
  private runSeq = 0;
  // Persistent shell so a setState repaints ONLY the screen content (not the
  // whole page), and the fade animation plays only on real screen transitions.
  private shellBuilt = false;
  private themeBtn: HTMLElement | null = null;
  private stepsHost: HTMLElement | null = null;
  private screenHost: HTMLElement | null = null;
  private prevScreen: Screen | null = null;
  // Live refs into the fetch screen so progress ticks update in place.
  private fetchFillEl: HTMLElement | null = null;
  private fetchMsgEl: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: UiActions) {
    this.root = root;
    this.actions = actions;
    // Restore an opt-in saved key so "remember" is a true contract, not a label.
    const savedKey = loadSavedApiKey();
    const analyticsConsent = loadAnalyticsConsent();
    if (analyticsConsent) initAnalytics();
    this.state = {
      screen: 'connect',
      theme: initialTheme(),
      apiKey: savedKey ?? '',
      remember: savedKey !== null,
      statusMessage: null,
      error: null,
      fetchPct: 0,
      fetchMessage: '',
      exportConsent: false,
      analyticsConsent,
    };
    this.screenRenderers.set('connect', (h) => this.renderConnect(h));
    this.screenRenderers.set('meter', (h) => this.renderMeterScreen(h));
    this.screenRenderers.set('fetch', (h) => this.renderFetchScreen(h));
    this.screenRenderers.set('results', (h) => this.renderResultsScreen(h));
    this.screenRenderers.set('timing', (h) => this.renderTimingScreen(h));
  }

  getState(): Readonly<UiState> {
    return this.state;
  }

  // Load a ComparisonRun (live or replayed/sample) and show the results screen.
  showResults(run: ComparisonRun, replayMeta: string | null = null): void {
    this.originalRun = run;
    this.currentRun = run;
    this.currentExport = null;
    this.currentMeter = null;
    this.replayMeta = replayMeta;
    this.userTariffOverride = null;
    this.setState({ screen: 'results', statusMessage: null, error: null });
  }

  showExportResults(run: ExportRun, replayMeta: string | null = null): void {
    this.currentExport = run;
    this.currentRun = null;
    this.currentMeter = null;
    this.replayMeta = replayMeta;
    this.setState({ screen: 'results', statusMessage: null, error: null, exportConsent: false });
  }

  // Live journey: connect → discover meters → meter picker.
  async runLive(apiKey: string): Promise<void> {
    this.liveApiKey = apiKey;
    this.failureDiag = null;
    this.progressLog = ['Looking up your account…'];
    const myRun = ++this.runSeq;
    this.setState({
      screen: 'fetch',
      error: null,
      fetchPct: 6,
      fetchMessage: 'Looking up your account…',
    });
    try {
      const client = createClient(apiKey);
      const token = await obtainKrakenToken(client, apiKey);
      if (myRun !== this.runSeq) return;
      this.liveClient = client;
      const meters = await discoverMeters(client, token);
      if (myRun !== this.runSeq) return;
      if (meters.length === 0) throw new Error('No electricity meters found on this account.');
      this.meters = meters;
      this.selectedMeterIdx = 0;
      this.setState({ screen: 'meter' });
    } catch (err) {
      if (myRun !== this.runSeq) return;
      this.captureFailure(err);
      trackComparisonFailure({ ...classifyError(err), stage: 'auth' });
      this.setState({ screen: 'connect', error: errorMessage(err) });
    }
  }

  // Run the comparison for the chosen meter, driving the fetch progress.
  private async runForMeter(meter: MeterChoice): Promise<void> {
    const client = this.liveClient;
    if (!client) {
      this.setState({ screen: 'connect', error: 'Session expired — please reconnect.' });
      return;
    }
    const myRun = ++this.runSeq;
    this.progressLog = [];
    this.setState({ screen: 'fetch', fetchPct: 2, fetchMessage: 'Starting…' });
    const onProgress: ProgressFn = (message, _status, pct) => {
      if (myRun !== this.runSeq) return; // ignore progress from a superseded run
      this.progressLog.push(message);
      this.setState({ fetchMessage: message, fetchPct: pct ?? this.state.fetchPct });
    };
    const input: RunInput = {
      apiKey: this.liveApiKey,
      accountNumber: meter.accountNumber,
      mpan: meter.mpan,
      serial: meter.serial,
      serials: meter.serials,
      accountData: meter.accountData,
    };
    try {
      if (meter.isExport) {
        const run = await runExportComparison(client, input, onProgress);
        if (myRun !== this.runSeq) return;
        this.showExportResults(run);
      } else {
        const run = await runComparison(client, input, onProgress);
        if (myRun !== this.runSeq) return;
        this.showResults(run);
        this.trackSuccess(run, meter);
      }
      // Record the live meter AFTER show* (which clears it) so diagnostics can
      // redaction-scrub these real identifiers from the bundle.
      this.currentMeter = meter;
    } catch (err) {
      if (myRun !== this.runSeq) return;
      this.captureFailure(err, meter);
      trackComparisonFailure({ ...classifyError(err), stage: 'fetch' });
      this.setState({ screen: 'connect', error: errorMessage(err) });
    }
  }

  private trackSuccess(run: ComparisonRun, meter: MeterChoice): void {
    if (!this.state.analyticsConsent) return;
    const headline = computeHeadline(run);
    const claims = computeShareClaims(run, headline);
    const outwardCode = getPostcodeAreaForMpan(meter.accountData, meter.mpan);
    const periodMs = run.context.periodTo.getTime() - run.context.periodFrom.getTime();
    const periodDays = periodMs / (24 * 60 * 60 * 1000);
    let pctSaved: number | null = null;
    if (claims?.actual) {
      const altIsAgile = claims.actual.altLabel === 'Agile';
      const agileIsCheaper = altIsAgile ? claims.actual.cheaper : !claims.actual.cheaper;
      pctSaved = agileIsCheaper ? claims.actual.pct : -claims.actual.pct;
    } else if (claims?.estimate) {
      pctSaved = claims.estimate.cheaper === 'Agile' ? claims.estimate.pct : -claims.estimate.pct;
    }
    trackComparisonSuccess({ outwardCode, pctSaved, kwhTotal: headline.summaryKwh, periodDays });
  }

  // Build a failure diagnostic (v2 parity) the user can download/send from the
  // error state. Account number is omitted by policy; ids scrub the rest.
  private captureFailure(err: unknown, meter?: MeterChoice): void {
    const m = meter ?? this.currentMeter ?? this.meters[this.selectedMeterIdx] ?? null;
    const ctx: FailureContext = {
      accountNumber: m?.accountNumber ?? null,
      serialCount: m ? m.serials.length : 0,
      isExport: m?.isExport ?? false,
      postcodeArea: m ? getPostcodeAreaForMpan(m.accountData, m.mpan) : null,
      agreements: m ? getAgreementsForMpan(m.accountData, m.mpan) : [],
      metersOnAccount: this.meters.map((mm) => ({
        serialCount: mm.serials.length,
        isExport: mm.isExport,
        currentTariff: mm.tariffCode,
      })),
      progressLog: this.progressLog,
    };
    this.failureDiag = captureFailureDiag(err, ctx, this.failureIds(m), {
      generatedAt: new Date().toISOString(),
    });
  }

  private failureIds(m: MeterChoice | null): PiiIdentifiers {
    return m
      ? {
          mpan: m.mpan,
          serials: m.serials,
          apiKey: this.liveApiKey,
          accountNumber: m.accountNumber,
        }
      : { apiKey: this.liveApiKey };
  }

  private openFailureDiagnostics(): void {
    if (!this.failureDiag) return;
    const m = this.currentMeter ?? this.meters[this.selectedMeterIdx] ?? null;
    openDiagnosticsModal(
      { diagnostics: this.failureDiag, ids: this.failureIds(m), isExport: false },
      this.diagnosticsDeps(),
    );
  }

  // Build the diagnostics bundle inputs for the current run and open the modal.
  private openDiagnostics(): void {
    const generatedAt = new Date().toISOString();
    let diagnostics: AnyDiagnostics;
    if (this.currentExport) {
      diagnostics = buildExportDiagnostics(this.currentExport, { generatedAt });
    } else if (this.currentRun) {
      diagnostics = buildImportDiagnostics(this.currentRun, { generatedAt });
    } else {
      return;
    }
    const m = this.currentMeter;
    const ids: PiiIdentifiers = m
      ? {
          mpan: m.mpan,
          serials: m.serials,
          apiKey: this.liveApiKey,
          accountNumber: m.accountNumber,
        }
      : {};
    openDiagnosticsModal(
      { diagnostics, ids, isExport: this.currentExport !== null },
      this.diagnosticsDeps(),
    );
  }

  private diagnosticsDeps(): DiagModalDeps {
    return {
      download: downloadBundle,
      openMailto: (url) => {
        const a = document.createElement('a');
        a.href = url;
        a.click();
      },
      copyToClipboard: (text) =>
        navigator.clipboard?.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('clipboard unavailable')),
      canShare: (data) =>
        typeof navigator.canShare === 'function' && navigator.canShare(data as ShareData),
      share: (data) => navigator.share(data as ShareData),
      makeFile: (bundle) => new File([bundle.content], bundle.filename, { type: bundle.mimeType }),
    };
  }

  private reset(): void {
    this.runSeq++; // invalidate any in-flight run
    this.currentRun = null;
    this.originalRun = null;
    this.currentExport = null;
    this.currentMeter = null;
    this.failureDiag = null;
    this.replayMeta = null;
    this.userTariffOverride = null;
    this.setState({ screen: 'connect', statusMessage: null, error: null });
  }

  private openTariffOverrideModal(): void {
    const base = this.originalRun ?? this.currentRun;
    if (!base) return;
    openTariffOverrideModal(
      this.userTariffOverride?.unitRate ?? null,
      this.userTariffOverride?.standingCharge ?? null,
      (unitRate, standingCharge) => {
        this.userTariffOverride = { unitRate, standingCharge };
        this.currentRun = applyUserTariff(base, unitRate, standingCharge);
        this.setState({ screen: 'results' });
      },
    );
  }

  private resetTariff(): void {
    this.userTariffOverride = null;
    this.currentRun = this.originalRun;
    this.setState({ screen: 'results' });
  }

  private resultsCallbacks() {
    return {
      onTiming: () => this.setState({ screen: 'timing' }),
      onReset: () => this.reset(),
      onDiagnostics: () => this.openDiagnostics(),
      onEditTariff: () => this.openTariffOverrideModal(),
      onResetTariff: this.userTariffOverride ? () => this.resetTariff() : null,
    };
  }

  private renderResultsScreen(host: HTMLElement): void {
    if (this.currentExport) {
      renderExportResults(host, this.currentExport, {
        onReset: () => this.reset(),
        onDiagnostics: () => this.openDiagnostics(),
        consent: this.state.exportConsent,
        onToggleConsent: (v) => this.setState({ exportConsent: v }),
      });
      return;
    }
    if (!this.currentRun) {
      host.append(el('p', { class: 'muted', text: 'No comparison loaded.' }));
      return;
    }
    const cb = this.resultsCallbacks();
    if (this.currentRun.periods.length === 0) {
      renderResultsEmpty(host, cb);
      return;
    }
    renderResults(host, this.currentRun, computeHeadline(this.currentRun), this.replayMeta, cb);
  }

  private renderMeterScreen(host: HTMLElement): void {
    host.append(
      el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
        el('h1', { style: 'font-size:var(--text-h2)', text: 'Which meter?' }),
        el('p', {
          class: 'row-sub',
          text: 'Pick a meter to compare. Import meters price what you paid; export meters value what you sent back.',
        }),
      ]),
    );
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    this.meters.forEach((m, i) => {
      const selected = i === this.selectedMeterIdx;
      const row = el('div', { class: `row is-clickable${selected ? ' is-selected' : ''}` }, [
        el('div', { class: 'row-main' }, [
          el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
            el('span', {
              class: 'row-title',
              text: m.isExport ? 'Export meter' : 'Import meter',
            }),
            badge(m.isExport ? 'Export' : 'Import', m.isExport ? 'support' : 'info'),
          ]),
          el('span', { class: 'row-sub', text: m.address || 'Address unavailable' }),
          el('span', {
            class: 'mono',
            style: 'font-size:var(--text-data-sm);color:var(--text-muted)',
            text: `MPAN ${m.mpan} · ${m.serials.length} serial(s)`,
          }),
        ]),
      ]);
      row.addEventListener('click', () => {
        this.selectedMeterIdx = i;
        this.setState({});
      });
      list.append(row);
    });
    host.append(list);
    host.append(
      el('div', { style: 'display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap' }, [
        button('Back', { variant: 'secondary', onClick: () => this.reset() }),
        button('Fetch this meter', {
          variant: 'primary',
          size: 'lg',
          onClick: () => {
            const meter = this.meters[this.selectedMeterIdx];
            if (meter) void this.runForMeter(meter);
          },
        }),
      ]),
    );
  }

  private renderFetchScreen(host: HTMLElement): void {
    // Keep refs so progress ticks update text + bar IN PLACE (see render()'s
    // fast path): the bar's width transition animates and the message blurs in,
    // instead of repainting the whole screen (which restarts the spinner).
    const fill = el('div', {
      class: 'steps-fill',
      style: `width:${Math.max(2, Math.min(100, this.state.fetchPct))}%`,
    });
    const msg = el('span', {
      class: 'fetch-msg',
      style: 'font-size:var(--text-body);color:var(--ink)',
      text: this.state.fetchMessage || 'Working…',
    });
    this.fetchFillEl = fill;
    this.fetchMsgEl = msg;
    host.append(
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:16px;max-width:520px;margin:24px auto 0' },
        [
          el('div', { style: 'text-align:center;display:flex;flex-direction:column;gap:6px' }, [
            el('h1', { style: 'font-size:var(--text-h2)', text: 'Reading your usage' }),
            el('p', {
              class: 'row-sub',
              text: 'All in your browser. No personal data is uploaded.',
            }),
          ]),
          el('div', { class: 'steps-track', style: 'height:6px' }, [fill]),
          el('div', { style: 'display:flex;align-items:center;gap:11px;justify-content:center' }, [
            el('span', {
              style:
                'flex:none;width:18px;height:18px;border-radius:50%;border:2.5px solid var(--grid-blue-tint);border-top-color:var(--grid-blue);animation:ae-spin 700ms linear infinite',
            }),
            msg,
          ]),
          el('p', {
            class: 'row-sub',
            style: 'text-align:center',
            text: "Missing smart data, statements or rates? We'll say what, and why.",
          }),
        ],
      ),
    );
  }

  // In-place progress update for the fetch screen: slide the bar (CSS width
  // transition) and blur the new message in, without a full repaint.
  private updateFetchProgress(): void {
    if (this.fetchFillEl) {
      this.fetchFillEl.style.width = `${Math.max(2, Math.min(100, this.state.fetchPct))}%`;
    }
    if (this.fetchMsgEl) {
      this.fetchMsgEl.textContent = this.state.fetchMessage || 'Working…';
      // restart the blur-in animation so each new message fades in
      this.fetchMsgEl.style.animation = 'none';
      void this.fetchMsgEl.offsetWidth;
      this.fetchMsgEl.style.animation = '';
    }
  }

  private renderTimingScreen(host: HTMLElement): void {
    if (!this.currentRun) {
      host.append(el('p', { class: 'muted', text: 'No comparison loaded.' }));
      return;
    }
    const guidance = nextSteps(this.currentRun, computeHeadline(this.currentRun));
    renderTiming(host, guidance, {
      onBack: () => this.setState({ screen: 'results' }),
      onDiagnostics: () => this.openDiagnostics(),
    });
  }

  setState(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  // Allow later increments to register richer screen renderers.
  registerScreen(screen: Screen, renderer: (host: HTMLElement) => void): void {
    this.screenRenderers.set(screen, renderer);
  }

  mount(): void {
    this.render();
  }

  private toggleTheme(): void {
    const theme = this.state.theme === 'dark' ? 'light' : 'dark';
    this.state.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage may be unavailable */
    }
    // Update in place — no full re-render, so the screen doesn't flash/re-animate.
    document.documentElement.setAttribute('data-theme', theme);
    if (this.themeBtn) {
      clear(this.themeBtn);
      this.themeBtn.append(icon(theme === 'dark' ? ICONS.sun : ICONS.moon, 16));
    }
  }

  private render(): void {
    // data-theme MUST go on <html>, not #app: <body> sets the inherited text
    // colour via var(--text-body), and <body> is an ancestor of #app — so the
    // dark overrides have to live at the document root to cascade to everything.
    document.documentElement.setAttribute('data-theme', this.state.theme);
    // Build the chrome ONCE; subsequent renders only swap the screen content.
    if (!this.shellBuilt) {
      clear(this.root);
      this.stepsHost = el('div');
      this.screenHost = el('main', { class: 'app-main' });
      this.root.append(
        el('div', { class: 'app' }, [
          this.renderHeader(),
          this.stepsHost,
          this.screenHost,
          renderFooter(),
        ]),
      );
      this.shellBuilt = true;
    }

    // Fast path: while staying on the fetch screen, update progress in place so
    // the bar slides and the message blurs in — no repaint (which would restart
    // the spinner and kill the width transition).
    if (
      this.state.screen === 'fetch' &&
      this.prevScreen === 'fetch' &&
      this.fetchMsgEl?.isConnected
    ) {
      this.updateFetchProgress();
      return;
    }

    if (this.stepsHost) {
      clear(this.stepsHost);
      const steps = this.renderSteps();
      if (steps) this.stepsHost.append(steps);
    }

    if (this.screenHost) {
      clear(this.screenHost);
      const changed = this.prevScreen !== this.state.screen;
      const screen = el('div', {
        // animate only on a real screen transition, never on in-screen updates
        class: changed ? 'screen screen-enter' : 'screen',
        dataset: { screen: this.state.screen },
      });
      const renderer = this.screenRenderers.get(this.state.screen);
      if (renderer) renderer(screen);
      this.screenHost.append(screen);
      // A real screen change is a fresh view — return to the top like a page
      // navigation, so the user isn't dropped mid-scroll on the new screen
      // (e.g. clicking "See how timing saves more" from far down the results).
      if (changed && this.prevScreen !== null) {
        try {
          window.scrollTo(0, 0);
        } catch {
          /* no real viewport (e.g. jsdom under test) */
        }
      }
      this.prevScreen = this.state.screen;
    }
  }

  private renderHeader(): HTMLElement {
    const brand = el('div', { class: 'brand' }, [
      el(
        'a',
        {
          href: 'https://auth.energy',
          target: '_blank',
          rel: 'noopener noreferrer',
          ariaLabel: 'Auth Energy',
          style: 'color:var(--ink);line-height:0;display:flex',
        },
        [logo(LOGO_PATHS, 26)],
      ),
      el(
        'a',
        {
          href: '',
          ariaLabel: 'Home',
          style: 'display:flex;flex-direction:column;line-height:1.1',
          onClick: (ev) => {
            ev.preventDefault();
            this.reset();
          },
        },
        [
          el('span', { class: 'brand-name', text: 'Octopus Tariff Check' }),
          el('span', { class: 'brand-by', text: 'by auth.energy' }),
        ],
      ),
    ]);
    const onDevice = el('span', { class: 'chip' }, [
      el('span', { style: 'color:var(--status-support);line-height:0' }, [
        icon(ICONS.lock, 13, 2.4),
      ]),
      'On-device',
    ]);
    const themeBtn = el(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        ariaLabel: 'Toggle theme',
        onClick: () => this.toggleTheme(),
      },
      [icon(this.state.theme === 'dark' ? ICONS.sun : ICONS.moon, 16)],
    );
    this.themeBtn = themeBtn;
    return el('header', { class: 'app-header' }, [
      el('div', { class: 'app-header-inner' }, [
        brand,
        el('div', { style: 'display:flex;align-items:center;gap:8px' }, [onDevice, themeBtn]),
      ]),
    ]);
  }

  private renderSteps(): HTMLElement | null {
    if (this.state.screen === 'connect') return null;
    const sm = STEP_MAP[this.state.screen];
    return el('div', { class: 'steps' }, [
      el('div', { class: 'steps-row' }, [
        el('span', { class: 'steps-label', text: sm.label }),
        el('span', { class: 'steps-count', text: `${sm.n} / 4` }),
      ]),
      el('div', { class: 'steps-track' }, [
        el('div', { class: 'steps-fill', style: `width:${(sm.n / 4) * 100}%` }),
      ]),
    ]);
  }

  private renderConnect(host: HTMLElement): void {
    const heading = el(
      'div',
      {
        style:
          'display:flex;flex-direction:column;gap:8px;max-width:720px;margin:0 auto;text-align:center',
      },
      [
        el('h1', { style: 'font-size:var(--text-h1);line-height:1.15;text-wrap:balance' }, [
          'See what a dynamic tariff ',
          el('em', {
            style: 'font-style:normal;color:var(--grid-blue)',
            text: 'would have cost you',
          }),
        ]),
        el('p', {
          class: 'lead',
          text: 'Past performance is not a guarantee of future savings.',
        }),
      ],
    );

    // Built first so the input handler can flip its disabled state imperatively —
    // a full re-render on each keystroke would drop input focus.
    const connectBtn = button('Connect and read my usage', {
      variant: 'primary',
      size: 'lg',
      full: true,
      disabled: this.state.apiKey.trim().length === 0,
      onClick: () => this.actions.connect(),
    });

    const apiInput = inputField({
      label: 'Octopus API key',
      hint: 'From your Octopus dashboard. Read-only, used once.',
      placeholder: 'sk_live_xxxxxxxxxxxxxxxx',
      value: this.state.apiKey,
      onInput: (v) => {
        this.state.apiKey = v;
        if (this.state.remember) saveApiKey(v); // keep the opt-in store in sync
        (connectBtn as HTMLButtonElement).disabled = v.trim().length === 0;
      },
    });
    const findKey = el(
      'a',
      {
        class: 'btn-ghost',
        href: 'https://octopus.energy/dashboard/new/accounts/personal-details/api-access/',
        target: '_blank',
        rel: 'noopener noreferrer',
        style: 'display:inline-flex;align-items:center;gap:6px;font-size:var(--text-body-sm)',
      },
      ['Find your API key on Octopus', icon(ICONS.arrowUpRight, 14)],
    );
    const remember = switchRow({
      label: 'Remember my key on this device',
      checked: this.state.remember,
      onChange: (checked) => {
        if (checked) {
          if (this.state.apiKey.trim().length > 0) saveApiKey(this.state.apiKey);
        } else {
          clearApiKey();
        }
        this.setState({ remember: checked });
      },
    });
    const analyticsSwitch = switchRow({
      label: 'Share anonymous results with Auth Energy',
      description:
        'Sends postcode area (first half), % savings, total kWh and dates compared. No personal data, consumption data, tariff data, API key, MPAN, address, full postcode, or £ amounts are shared.',
      checked: this.state.analyticsConsent,
      onChange: (checked) => {
        saveAnalyticsConsent(checked);
        if (checked) initAnalytics();
        this.setState({ analyticsConsent: checked });
      },
    });

    const card = el(
      'div',
      { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' },
      [
        el('div', { style: 'display:flex;flex-direction:column;gap:1px' }, [
          el('span', { class: 'row-title', text: 'Connect your Octopus account' }),
          el('span', {
            class: 'row-sub',
            text: 'Read-only, used once. Runs entirely in your browser.',
          }),
        ]),
        apiInput,
        findKey,
        remember,
        analyticsSwitch,
        connectBtn,
        el('div', { style: 'display:flex;justify-content:center' }, [
          button('Use a sample household', {
            variant: 'ghost',
            onClick: () => this.actions.useSample(),
          }),
        ]),
      ],
    );

    const replay = el(
      'div',
      {
        style:
          'display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:13px 16px;border:1px dashed var(--border-strong);border-radius:var(--radius-md)',
      },
      [
        el('span', {
          style: 'font-size:var(--text-body-sm);flex:1;min-width:180px',
          text: 'Replay a saved diagnostics file offline.',
        }),
        button('Replay a file', { variant: 'secondary', onClick: () => this.actions.replayFile() }),
      ],
    );

    const guarantees = el(
      'div',
      { style: 'display:flex;flex-wrap:wrap;gap:7px;justify-content:center' },
      [
        ...['No backend', 'Opt-in analytics', 'Opt-in key storage'].map((g) =>
          el('span', { class: 'chip' }, [
            el('span', { style: 'color:var(--status-support);line-height:0' }, [
              icon(ICONS.check, 12, 2.6),
            ]),
            g,
          ]),
        ),
      ],
    );

    if (this.state.error) {
      host.append(
        el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
          callout("That didn't work", this.state.error, 'risk', 'alert'),
          this.failureDiag
            ? el('div', {}, [
                button('Download diagnostics', {
                  variant: 'secondary',
                  iconLeft: 'lock',
                  onClick: () => this.openFailureDiagnostics(),
                }),
              ])
            : null,
        ]),
      );
    }
    if (this.state.statusMessage) {
      host.append(callout('Heads up', this.state.statusMessage, 'info', 'info'));
    }
    host.append(
      heading,
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:16px;max-width:480px;margin:0 auto' },
        [
          card,
          callout(
            'Your data never leaves your device',
            'API Key is used once to read your data directly from Octopus to your device. Remembering it is optional and stays in this browser only.',
            'support',
            'lock',
          ),
          guarantees,
          replay,
        ],
      ),
    );
  }
}
