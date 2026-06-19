import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';

const builtFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'v3', 'index.html');

function watchCsp(page: Page): string[] {
  const v: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) v.push(m.text());
  });
  page.on('pageerror', (e) => v.push(`pageerror: ${e.message}`));
  return v;
}

async function toSampleResults(page: Page): Promise<void> {
  await page.goto(pathToFileURL(builtFile).href);
  await page.getByRole('button', { name: 'Use a sample household' }).click();
  await expect(page.getByRole('heading', { name: 'Your comparison' })).toBeVisible();
}

test('diagnostics modal downloads an anonymised bundle with no secrets (CSP clean)', async ({
  page,
}) => {
  const csp = watchCsp(page);
  await toSampleResults(page);

  await page.getByRole('button', { name: 'Diagnostics' }).click();
  await expect(page.getByText('Always removed')).toBeVisible();
  await expect(page.getByText('• Account number')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download bundle' }).click(),
  ]);
  const path = await download.path();
  const content = readFileSync(path, 'utf8');

  // valid JSON, recognisable shape
  const obj = JSON.parse(content) as { appVersion?: string; billingPeriods?: unknown[] };
  expect(obj.appVersion).toBeTruthy();
  expect(Array.isArray(obj.billingPeriods)).toBe(true);

  // no secrets / identifiers anywhere in the bundle
  for (const bad of ['sk_live', 'sk_test', 'mpan', 'MPAN', 'serial', 'accountNumber']) {
    expect(content).not.toContain(bad);
  }

  expect(csp, csp.join('\n')).toHaveLength(0);
});

test('diagnostics submit uses the Web Share sheet when available (mobile path)', async ({
  page,
}) => {
  // Mock the Web Share API before the app loads.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __shared?: unknown;
      navigator: Navigator & {
        canShare?: (d: unknown) => boolean;
        share?: (d: unknown) => Promise<void>;
      };
    };
    w.navigator.canShare = () => true;
    w.navigator.share = (data: unknown) => {
      w.__shared = data;
      return Promise.resolve();
    };
  });
  const csp = watchCsp(page);
  await toSampleResults(page);

  await page.getByRole('button', { name: 'Diagnostics' }).click();
  await page.getByRole('button', { name: 'Submit to support' }).click();

  await expect(page.getByText('Shared via your device')).toBeVisible();
  const shared = await page.evaluate(
    () => (window as unknown as { __shared?: { files?: unknown[] } }).__shared,
  );
  expect(shared?.files?.length).toBe(1);

  expect(csp, csp.join('\n')).toHaveLength(0);
});

test('social share posts a branded PNG via the native sheet (mobile), CSP clean', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __shared?: unknown;
      navigator: Navigator & {
        canShare?: (d: unknown) => boolean;
        share?: (d: unknown) => Promise<void>;
      };
    };
    w.navigator.canShare = () => true;
    w.navigator.share = (data: unknown) => {
      w.__shared = data;
      return Promise.resolve();
    };
  });
  const csp = watchCsp(page);
  await toSampleResults(page);

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Shared!' })).toBeVisible();

  const shared = await page.evaluate(() => {
    const s = (window as unknown as { __shared?: { files?: File[]; text?: string } }).__shared;
    const f = s?.files?.[0];
    return {
      count: s?.files?.length ?? 0,
      type: f?.type,
      name: f?.name,
      size: f?.size ?? 0,
      hashtag: (s?.text ?? '').includes('#DynamicTariffCheck'),
      noPound: !(s?.text ?? '').includes('£'),
    };
  });
  expect(shared.count).toBe(1); // the optimised artifact is attached
  expect(shared.type).toBe('image/png');
  expect(shared.name).toBe('octopus-tariff-check.png');
  expect(shared.size).toBeGreaterThan(1000); // a real rendered card, not an empty file
  expect(shared.hashtag).toBe(true);
  expect(shared.noPound).toBe(true); // percentages only

  expect(csp, csp.join('\n')).toHaveLength(0);
});
