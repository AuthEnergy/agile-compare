import type { Reading } from '../src/types/domain';

const STEP_MS = 30 * 60 * 1000;

// Generate `count` consecutive half-hourly readings of `kwh` each from startISO.
export function makeReadings(startISO: string, count: number, kwh: number): Reading[] {
  const readings: Reading[] = [];
  let t = new Date(startISO);
  for (let i = 0; i < count; i++) {
    const start = new Date(t);
    const end = new Date(t.getTime() + STEP_MS);
    readings.push({ start, end, kwh });
    t = end;
  }
  return readings;
}
