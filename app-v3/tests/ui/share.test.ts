import { describe, it, expect, vi } from 'vitest';
import { computeHeadline } from '../../src/domain/headline';
import { buildShareText, renderSharePanel } from '../../src/ui/share';
import { makeRun } from '../diagnostics/runFactory';

const onePeriod = (over: Record<string, unknown> = {}) =>
  makeRun([
    {
      start: '2025-01-01',
      end: '2025-02-01',
      tariff: 'current',
      actual: 6000,
      flexEnergy: 4200,
      flexStanding: 800, // Flexible 5000
      agileEnergy: 3600,
      agileStanding: 800, // Agile 4400
      ...over,
    },
  ]);

describe('buildShareText', () => {
  it('shares percentages only (never £) for a Flexible user, with the campaign hashtag', () => {
    const run = onePeriod();
    const text = buildShareText(run, computeHeadline(run));
    expect(text).not.toBeNull();
    expect(text).not.toContain('£'); // percentages only — no bill amounts
    expect(text).toContain('#DynamicTariffCheck');
    expect(text).toContain('Agile worked out 12.0% cheaper than Flexible'); // 5000 vs 4400
    expect(text).toContain(
      'Agile would have been 26.7% cheaper than what I actually paid on Flexible',
    ); // 4400 vs 6000
  });

  it('frames an Agile user against Flexible, never the other way', () => {
    const run = onePeriod({
      actual: 4000,
      flexEnergy: 5000,
      flexStanding: 1000,
      agileEnergy: 3200,
      agileStanding: 800,
    });
    const AGILE = 'E-1R-AGILE-24-10-01-A';
    run.periods.forEach((p) => {
      p.tariffCodes = [AGILE];
      p.actualTariffCode = AGILE;
    });
    run.context.currentAgreement = {
      tariff_code: AGILE,
      valid_from: '2024-01-01T00:00:00.000Z',
      valid_to: null,
    };
    const text = buildShareText(run, computeHeadline(run));
    expect(text).toContain('Agile worked out 33.3% cheaper than Flexible'); // 6000 vs 4000
    expect(text).toContain(
      'Flexible would have been 50.0% dearer than what I actually paid on Agile',
    );
    expect(text).not.toContain('£');
  });

  it('shares Flexible proxy as the estimate baseline when actual tariff rates are unavailable', () => {
    const run = onePeriod();
    const TRACKER = 'E-1R-TRACKER-24-10-01-A';
    run.periods.forEach((p) => {
      p.tariffCodes = [TRACKER];
      p.actualTariffCode = TRACKER;
    });
    run.context.currentAgreement = {
      tariff_code: TRACKER,
      valid_from: '2024-01-01T00:00:00.000Z',
      valid_to: null,
    };
    run.context.flexColumnSource = {
      kind: 'flexible-proxy',
      label: 'Flexible proxy',
      actualTariffLabel: 'Tracker',
      actualTariffCode: TRACKER,
      reason: 'Tracker rates are not modelled.',
    };

    const text = buildShareText(run, computeHeadline(run));

    expect(text).toContain('Agile worked out 12.0% cheaper than Flexible proxy');
    expect(text).not.toContain('Tracker worked out');
  });

  it('returns null when the headline is not trustworthy', () => {
    const run = onePeriod();
    run.context.statementsIncomplete = true;
    expect(buildShareText(run, computeHeadline(run))).toBeNull();
  });

  it('returns null in the all-pre-switch case (old usage, not a current-tariff result)', () => {
    const run = onePeriod();
    const OLD = 'E-1R-FIX-12M-23-A';
    run.periods.forEach((p) => {
      p.tariffCodes = [OLD];
      p.actualTariffCode = OLD;
    });
    run.context.currentAgreement = {
      tariff_code: 'E-1R-VAR-99-01-A',
      valid_from: '2026-04-09T00:00:00.000Z',
      valid_to: null,
    };
    expect(buildShareText(run, computeHeadline(run))).toBeNull();
  });

  it('renders a text-only share fallback when canvas is unavailable', () => {
    const run = onePeriod();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const panel = renderSharePanel(run, computeHeadline(run));

      expect(panel).not.toBeNull();
      expect(panel?.querySelector('canvas')).toBeNull();
      expect(panel?.textContent).toContain('Copy to clipboard');
      expect(panel?.textContent).toContain('#DynamicTariffCheck');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
