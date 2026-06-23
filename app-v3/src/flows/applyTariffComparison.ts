import { calculateCost } from '../domain/cost';
import type { RateWindow } from '../types/domain';
import type { ComparisonRun, PeriodComparison, RunDetail } from '../types/result';

export interface TariffColumn {
  unitWindows: RateWindow[];
  standingWindows: RateWindow[];
  label: string;
}

// Apply one or both column overrides to an existing ComparisonRun. Pass null for
// a column to leave it unchanged. At least one must be non-null.
// The left column maps to the "flex" slot; the right to "agile".
export function applyTariffComparison(
  run: ComparisonRun,
  flexColumn: TariffColumn | null,
  agileColumn: TariffColumn | null,
): ComparisonRun {
  if (!flexColumn && !agileColumn) return run;

  const { context } = run;

  const flexUnitSorted = flexColumn
    ? [...flexColumn.unitWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
    : run.detail.flexUnitSorted;
  const flexStanding = flexColumn
    ? [...flexColumn.standingWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
    : run.detail.flexStanding;

  const agileUnitSorted = agileColumn
    ? [...agileColumn.unitWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
    : run.detail.agileUnitSorted;
  const agileStanding = agileColumn
    ? [...agileColumn.standingWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
    : run.detail.agileStanding;

  const periods: PeriodComparison[] = run.periods.map((p) => {
    const newFlex = flexColumn
      ? calculateCost(run.detail.readings, p.start, p.end, flexUnitSorted, flexStanding, true)
      : p.flex;
    const newAgile = agileColumn
      ? calculateCost(run.detail.readings, p.start, p.end, agileUnitSorted, agileStanding, true)
      : p.agile;

    const confident =
      !p.wasClamped &&
      !p.suspectActual &&
      newFlex.unmatchedReadings === 0 &&
      newFlex.unmatchedStandingDays === 0 &&
      (newAgile === null ||
        (newAgile.unmatchedReadings === 0 && newAgile.unmatchedStandingDays === 0));

    return {
      ...p,
      flex: newFlex,
      agile: newAgile,
      confident,
      ...(flexColumn
        ? {
            // classifyPeriod compares actualTariffCode to currentAgreement.tariff_code
            // to detect pre-switch periods. Mirror the label onto both fields so every
            // period is treated as "on current tariff" and none is dimmed.
            actualTariffCode: flexColumn.label,
            tariffCodes: [flexColumn.label],
          }
        : {}),
    };
  });

  const detail: RunDetail = {
    ...run.detail,
    flexUnitSorted,
    flexStanding,
    agileUnitSorted,
    agileStanding,
    agileAvailable: agileColumn ? true : run.detail.agileAvailable,
  };

  return {
    periods,
    detail,
    context: {
      ...context,
      ...(flexColumn
        ? {
            currentAgreement: {
              tariff_code: flexColumn.label,
              valid_from: context.periodFrom.toISOString(),
              valid_to: context.periodTo.toISOString(),
            },
            flexColumnSource: { kind: 'user-override', label: flexColumn.label },
          }
        : {}),
      ...(agileColumn
        ? { agileColumnLabel: agileColumn.label }
        : context.agileColumnLabel !== undefined
          ? { agileColumnLabel: context.agileColumnLabel }
          : {}),
      agileAvailable: agileColumn ? true : context.agileAvailable,
      tariffOverride: true,
    },
  };
}
