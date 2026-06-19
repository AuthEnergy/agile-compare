import type { Reading } from '../types/domain';
import type { RawConsumptionRow } from '../types/octopus';
import { OctopusApiError, type OctopusClient } from './client';

export interface MergedConsumption {
  readings: Reading[];
  // interval-start (ms) seen on more than one serial / more than once: the
  // dedup collapses these but records them so the warning + per-slot `duplicate`
  // flag survive (they would otherwise vanish).
  duplicateIntervals: Set<number>;
}

export async function fetchConsumption(
  client: OctopusClient,
  mpan: string,
  serial: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<Reading[]> {
  const path = `/electricity-meter-points/${mpan}/meters/${serial}/consumption/`;
  const results = await client.restGetAllPages<RawConsumptionRow>(path, {
    period_from: periodFrom.toISOString(),
    period_to: periodTo.toISOString(),
    page_size: 25000,
    order_by: 'period',
  });
  return results.map((r) => ({
    start: new Date(r.interval_start),
    end: new Date(r.interval_end),
    kwh: r.consumption,
  }));
}

// Fetch consumption across ALL serials on the MPAN and merge by interval. A meter
// exchange leaves readings split across serials; merging tiles the timeline.
// Unlike v2, the SINGLE-serial path also runs through the dedup, so within-serial
// duplicate interval_starts collapse and are recorded in duplicateIntervals.
// A 404 means a stale serial (skip); any other error fails the run (a silent
// undercount would mislead).
export async function fetchConsumptionMerged(
  client: OctopusClient,
  mpan: string,
  serials: readonly string[],
  periodFrom: Date,
  periodTo: Date,
): Promise<MergedConsumption> {
  const list = serials.filter(Boolean);
  const byInterval = new Map<number, Reading>();
  const duplicateIntervals = new Set<number>();
  for (const serial of list) {
    let readings: Reading[];
    try {
      readings = await fetchConsumption(client, mpan, serial, periodFrom, periodTo);
    } catch (e) {
      if (e instanceof OctopusApiError && e.status === 404) continue;
      throw e;
    }
    for (const r of readings) {
      const key = r.start.getTime();
      if (byInterval.has(key)) duplicateIntervals.add(key);
      else byInterval.set(key, r); // keep first (newest) serial's value for an interval
    }
  }
  const merged = [...byInterval.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
  return { readings: merged, duplicateIntervals };
}
