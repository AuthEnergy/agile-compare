import { describe, it, expect } from 'vitest';
import { fetchConsumptionMerged } from '../../src/api/consumption';
import { OctopusApiError, type OctopusClient } from '../../src/api/client';
import type { RawConsumptionRow } from '../../src/types/octopus';

function row(iso: string, kwh: number): RawConsumptionRow {
  const start = new Date(iso);
  return {
    interval_start: start.toISOString(),
    interval_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    consumption: kwh,
  };
}

type SerialResult = RawConsumptionRow[] | (() => never);

function mockClient(perSerial: Record<string, SerialResult>): OctopusClient {
  const client = {
    async restGetAllPages(path: string): Promise<unknown[]> {
      const serial = path.split('/')[4] ?? '';
      const v = perSerial[serial];
      if (typeof v === 'function') return v();
      return v ?? [];
    },
    restGet: async () => ({}),
    restGetRaw: async () => ({}),
    graphqlRequest: async () => ({}),
  };
  return client as unknown as OctopusClient;
}

const from = new Date('2025-06-01T00:00:00Z');
const to = new Date('2025-06-02T00:00:00Z');
const key0 = new Date('2025-06-01T00:00:00Z').getTime();

describe('fetchConsumptionMerged', () => {
  it('dedups a SINGLE serial and records the duplicate interval', async () => {
    const client = mockClient({
      S1: [
        row('2025-06-01T00:00:00Z', 0.5),
        row('2025-06-01T00:30:00Z', 0.6),
        row('2025-06-01T00:00:00Z', 0.9),
      ],
    });
    const { readings, duplicateIntervals } = await fetchConsumptionMerged(
      client,
      'M',
      ['S1'],
      from,
      to,
    );
    expect(readings).toHaveLength(2);
    expect(duplicateIntervals.has(key0)).toBe(true);
    expect(readings[0]?.kwh).toBe(0.5); // first occurrence kept
  });

  it('merges across serials, keeps the first serial on overlap, flags the overlap', async () => {
    const client = mockClient({
      NEW: [row('2025-06-01T01:00:00Z', 1), row('2025-06-01T00:00:00Z', 2)],
      OLD: [row('2025-06-01T00:00:00Z', 9), row('2025-06-01T00:30:00Z', 3)],
    });
    const { readings, duplicateIntervals } = await fetchConsumptionMerged(
      client,
      'M',
      ['NEW', 'OLD'],
      from,
      to,
    );
    expect(readings).toHaveLength(3);
    expect(duplicateIntervals.size).toBe(1);
    const at0 = readings.find((r) => r.start.getTime() === key0);
    expect(at0?.kwh).toBe(2); // NEW (first in list) wins
  });

  it('skips a 404 serial and keeps the good one', async () => {
    const client = mockClient({
      BAD404: () => {
        throw new OctopusApiError('not found', { status: 404 });
      },
      GOOD: [row('2025-06-01T00:00:00Z', 0.5)],
    });
    const { readings } = await fetchConsumptionMerged(client, 'M', ['BAD404', 'GOOD'], from, to);
    expect(readings).toHaveLength(1);
  });

  it('fails the run on a non-404 error (no silent undercount)', async () => {
    const client = mockClient({
      GOOD: [row('2025-06-01T00:00:00Z', 0.5)],
      BAD500: () => {
        throw new OctopusApiError('server error', { status: 500 });
      },
    });
    await expect(
      fetchConsumptionMerged(client, 'M', ['GOOD', 'BAD500'], from, to),
    ).rejects.toThrow();
  });
});
