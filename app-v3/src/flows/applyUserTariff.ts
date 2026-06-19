import { calculateCost } from '../domain/cost';
import type { RateWindow } from '../types/domain';
import type { ComparisonRun, RunDetail } from '../types/result';

// Replaces the Flex (actual) tariff rates with a single flat rate supplied by
// the user, recalculates every period, and labels the result "User tariff".
// The Agile side and all readings stay unchanged — only the Flex rates swap out.
export function applyUserTariff(
  run: ComparisonRun,
  unitRatePence: number,
  standingChargePence: number,
): ComparisonRun {
  const { context } = run;

  // Single window covering the full fetch window so every period is matched.
  const flatUnit: RateWindow = {
    validFrom: context.periodFrom,
    validTo: context.periodTo,
    value: unitRatePence,
  };
  const flatStanding: RateWindow = {
    validFrom: context.periodFrom,
    validTo: context.periodTo,
    value: standingChargePence,
  };
  const flexUnitSorted = [flatUnit];
  const flexStanding = [flatStanding];

  const periods = run.periods.map((p) => {
    const newFlex = calculateCost(
      run.detail.readings,
      p.start,
      p.end,
      flexUnitSorted,
      flexStanding,
    );
    const confident =
      !p.wasClamped &&
      !p.suspectActual &&
      newFlex.unmatchedReadings === 0 &&
      newFlex.unmatchedStandingDays === 0 &&
      (p.agile === null ||
        (p.agile.unmatchedReadings === 0 && p.agile.unmatchedStandingDays === 0));
    return {
      ...p,
      flex: newFlex,
      confident,
      // classifyPeriod compares actualTariffCode to currentAgreement.tariff_code
      // to detect "pre-switch" periods. Without this, every period looks like it
      // predates the override and becomes non-expandable + triggers the notice path.
      actualTariffCode: 'User tariff',
      tariffCodes: ['User tariff'],
    };
  });

  const detail: RunDetail = { ...run.detail, flexUnitSorted, flexStanding };

  return {
    periods,
    detail,
    context: {
      ...context,
      // classifyTariffCode falls through to { kind: 'other', label: code } for
      // unknown codes, so 'User tariff' renders as "User tariff" throughout.
      currentAgreement: {
        tariff_code: 'User tariff',
        valid_from: context.periodFrom.toISOString(),
        valid_to: context.periodTo.toISOString(),
      },
      tariffOverride: true,
    },
  };
}
