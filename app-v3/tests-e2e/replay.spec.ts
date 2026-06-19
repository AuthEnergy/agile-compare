import { test, expect } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const builtFile = join(here, '..', '..', 'v3', 'index.html');
const fixture = join(here, '..', 'tests', 'fixtures', 'diagnostics-l-wip-v2.json');

test('replay a diagnostics file → results → month/day/slot drill-down (CSP clean)', async ({
  page,
}) => {
  const csp: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
  });
  page.on('pageerror', (e) => csp.push(`pageerror: ${e.message}`));

  await page.goto(pathToFileURL(builtFile).href);

  // Replay the committed v2 fixture via the real file picker.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Replay a file' }).click(),
  ]);
  await chooser.setFiles(fixture);

  // Results render, with the offline-replay banner and the complete-periods label.
  await expect(page.getByRole('heading', { name: 'Your comparison' })).toBeVisible();
  await expect(page.locator('#app')).toContainText('offline replay');
  await expect(page.locator('#app')).toContainText('Complete periods on your current tariff');

  // Month → day: a complete period expands to the month calendar (lazy).
  await page.locator('.row', { hasText: 'January 2025' }).click();
  await expect(page.getByText(/Daily cost/)).toBeVisible();

  // Day → 48 slots: tapping a calendar day reveals its half-hour grid (lazy).
  await page.locator('.cal-cell:not(.cal-cell-empty)').first().click();
  await expect(page.locator('.slot-grid-head')).toBeVisible();
  await expect(page.locator('.slot-row').first()).toBeVisible();

  // Stage 2: timing screen reachable, with the move-don't-reduce framing.
  await page.getByRole('button', { name: 'See how timing saves more' }).click();
  await expect(
    page.getByRole('heading', { name: 'Save more by moving flexible use' }),
  ).toBeVisible();

  expect(csp, csp.join('\n')).toHaveLength(0);
});
