import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const builtFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'v3', 'index.html');

function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/Content Security Policy|Refused to (?:execute|load|apply|connect)/i.test(t)) {
      violations.push(t);
    }
  });
  page.on('pageerror', (err) => violations.push(`pageerror: ${err.message}`));
  return violations;
}

test('sample → Solar & battery → Calculate renders figures + table, CSP clean, no network', async ({
  page,
}) => {
  const csp = watchCsp(page);
  // Any non-Octopus network request would break the "runs entirely in your browser"
  // claim; a file:// sample run must make none. (CSP-clean alone isn't proof, since
  // api.octopus.energy is allow-listed.)
  const requests: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('file://')) requests.push(req.url());
  });

  await page.goto(pathToFileURL(builtFile).href);
  await page.getByRole('button', { name: 'Use a sample household' }).click();
  await expect(page.getByRole('heading', { name: 'Your comparison' })).toBeVisible();

  await page.getByRole('button', { name: 'Solar & battery' }).click();
  await expect(page.getByRole('heading', { name: 'Solar & battery' })).toBeVisible();
  await expect(page.locator('#app')).toContainText('evidence, not a sales pitch');

  await page.getByRole('button', { name: 'Calculate' }).click();

  await expect(page.locator('#app')).toContainText('Would have generated');
  await expect(page.locator('#app')).toContainText('Worth about');
  await expect(page.locator('.solar-table')).toBeVisible();
  await expect(page.locator('#app')).toContainText('Month by month');
  // The battery panel is present and clearly labelled experimental.
  await expect(page.locator('#app')).toContainText('experimental');
  // Honesty: never a promise to buy.
  await expect(page.locator('#app')).not.toContainText('you should install');

  expect(requests, `unexpected network: ${requests.join(', ')}`).toHaveLength(0);
  expect(csp, csp.join('\n')).toHaveLength(0);
});
