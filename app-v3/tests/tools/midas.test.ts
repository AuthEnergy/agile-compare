import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// app-v3 root (cwd for the dev-time generator + selftest).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The detailed unit assertions live in tools/midas/selftest.mjs (plain node, so it
// can import the .mjs ingest directly). We shell out so tsc never sees the .mjs.
describe('MIDAS ingest pipeline', () => {
  it('passes the node selftest (parse, QC, KJ→kWh, hour-ending split, zone assign, fallback)', () => {
    const out = execFileSync('node', ['tools/midas/selftest.mjs'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('midas selftest OK');
  });

  it('generator --source midas yields measured provenance + complete profiles from the fixture', () => {
    const out = execFileSync(
      'node',
      [
        'tools/build-solar-profiles.mjs',
        '--source',
        'midas',
        '--midas-dir',
        'tools/fixtures/midas',
        '--dry-run',
        '--json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const o = JSON.parse(out) as {
      source: string;
      dataVersion: string;
      provenance: { doi: string; dataset: string; license: string; citation: string };
      zoneSources: Record<string, string>;
      profilesPpm: Record<string, number[][]>;
    };
    expect(o.source).toBe('midas');
    expect(o.dataVersion).toBe('midas-v202507');
    expect(o.provenance.doi).toContain('10.5285/76e54f87');
    expect(o.provenance.dataset.toLowerCase()).toContain('midas');
    expect(o.provenance.license.toLowerCase()).toContain('open government licence');
    expect(o.zoneSources['south-west']).toBe('midas');
    expect(o.zoneSources['london']).toBe('modelled'); // no fixture station nearby
    const june = o.profilesPpm['south-west']?.[5] ?? [];
    expect(june.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(june[0]).toBe(0); // midnight is dark
  });
});
