import {
  getAgreementsForMpan,
  getPostcodeAreaForMpan,
  getRegionLetterFromAccount,
} from '../api/account';
import { fetchConsumptionMerged } from '../api/consumption';
import {
  fetchMergedRateWindows,
  findFlatOutgoingProducts,
  findProductsByDisplayNameOverlapping,
} from '../api/products';
import type { OctopusClient } from '../api/client';
import { calculateExportValue } from '../domain/cost';
import { detectGaps } from '../domain/gaps';
import { findCurrentAgreement } from '../domain/tariff';
import type { ExportRun, ProgressFn } from '../types/result';
import type { RunInput } from './runComparison';

// Orchestrates an export comparison (Outgoing flat vs Agile Outgoing) and returns
// a typed ExportRun — NO DOM, NO standing charge (income, not cost).
export async function runExportComparison(
  client: OctopusClient,
  input: RunInput,
  onProgress: ProgressFn = () => {},
): Promise<ExportRun> {
  onProgress('Verifying export meter…', 'active', 5);
  const accountData = input.accountData;
  const regionLetter = getRegionLetterFromAccount(accountData, input.mpan);
  if (regionLetter === null || regionLetter === 'MPAN_FOUND_NO_REGION') {
    throw new Error(`Could not determine the region for export MPAN ${input.mpan}.`);
  }
  const agreements = getAgreementsForMpan(accountData, input.mpan);
  const currentAgreement = findCurrentAgreement(agreements, new Date());
  const postcodeArea = getPostcodeAreaForMpan(accountData, input.mpan);
  onProgress(`Export meter verified. Region ${regionLetter}.`, 'ok', 10);

  // Window: up to 7 days ago, reaching back ~13 months.
  const periodTo = new Date();
  periodTo.setUTCDate(periodTo.getUTCDate() - 7);
  periodTo.setUTCHours(0, 0, 0, 0);
  const periodFrom = new Date(periodTo);
  periodFrom.setUTCFullYear(periodFrom.getUTCFullYear() - 1);
  periodFrom.setUTCMonth(periodFrom.getUTCMonth() - 1);

  onProgress('Fetching half-hourly export readings…', 'active', 30);
  const serials = input.serials.length ? input.serials : [input.serial];
  const merged = await fetchConsumptionMerged(client, input.mpan, serials, periodFrom, periodTo);
  const readings = merged.readings;
  if (readings.length === 0) {
    throw new Error(
      'No export readings were returned for this meter in the last year. Either the export meter has no smart data yet, or it has not exported any energy in this window.',
    );
  }
  const gapInfo = detectGaps(readings);
  const dataFrom = gapInfo.earliest ?? periodFrom;
  const dataTo = gapInfo.latest ? new Date(gapInfo.latest.getTime() + 30 * 60 * 1000) : periodTo;
  const exportKwh = readings.reduce((s, r) => s + r.kwh, 0);
  onProgress(
    `Fetched ${readings.length} reading(s); ${exportKwh.toFixed(1)} kWh exported.`,
    'ok',
    40,
  );

  // Outgoing (flat) export rates — current variable + historical fixed names.
  onProgress('Fetching Outgoing Octopus (flat export) rates…', 'active', 55);
  const flatProducts = await findFlatOutgoingProducts(client, dataFrom, dataTo);
  const flatMerged = await fetchMergedRateWindows(
    client,
    flatProducts,
    regionLetter,
    'standard-unit-rates',
    dataFrom,
    dataTo,
  );

  // Agile Outgoing (half-hourly export) rates.
  onProgress('Fetching Agile Outgoing rates…', 'active', 75);
  const agileProducts = await findProductsByDisplayNameOverlapping(
    client,
    'Agile Outgoing Octopus',
    dataFrom,
    dataTo,
  );
  const agileMerged = await fetchMergedRateWindows(
    client,
    agileProducts,
    regionLetter,
    'standard-unit-rates',
    dataFrom,
    dataTo,
  );

  const flat = flatMerged.windows.length
    ? {
        ...calculateExportValue(readings, dataFrom, dataTo, flatMerged.windows),
        products: flatMerged.used,
      }
    : null;
  const agile = agileMerged.windows.length
    ? {
        ...calculateExportValue(readings, dataFrom, dataTo, agileMerged.windows),
        products: agileMerged.used,
      }
    : null;
  if (!flat && !agile) {
    throw new Error(
      'Could not fetch any export tariff rates for this region, so no export comparison is possible.',
    );
  }
  onProgress('Done.', 'ok', 100);

  return {
    regionLetter,
    postcodeArea,
    currentAgreement,
    agreements,
    periodFrom: dataFrom,
    periodTo: dataTo,
    exportKwh,
    flat: flat
      ? {
          valuePence: flat.valuePence,
          unmatchedReadings: flat.unmatchedReadings,
          products: flat.products,
        }
      : null,
    agile: agile
      ? {
          valuePence: agile.valuePence,
          unmatchedReadings: agile.unmatchedReadings,
          products: agile.products,
        }
      : null,
    gapInfo,
    detail: {
      readings,
      flatWindows: flatMerged.windows,
      agileWindows: agileMerged.windows,
      duplicateIntervals: merged.duplicateIntervals,
    },
  };
}
