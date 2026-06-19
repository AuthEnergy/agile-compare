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

test('built single file boots the Connect screen under CSP with no violations', async ({
  page,
}) => {
  const csp = watchCsp(page);
  await page.goto(pathToFileURL(builtFile).href);

  await expect(page.locator('.app-header')).toContainText('Octopus Tariff Check');
  await expect(page.locator('#app')).toContainText('would have cost');
  await expect(page.getByPlaceholder('sk_live_xxxxxxxxxxxxxxxx')).toBeVisible();

  // Legal/privacy footer must be present (v2/v1 parity — disclaimer + independence).
  await expect(page.locator('.app-footer')).toContainText('No warranty, no advice');
  await expect(page.locator('.app-footer')).toContainText('Not affiliated with');
  await expect(page.locator('.app-footer')).toContainText('PolyForm Noncommercial');
  // Build version is visible on screen (not just in diagnostics).
  await expect(page.locator('.app-footer')).toContainText(/Octopus Tariff Check v\d/);

  expect(csp, csp.join('\n')).toHaveLength(0);
});

test('dark mode applies the dark text colour to inherited text (regression)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(pathToFileURL(builtFile).href);

  // ensure dark via the toggle (independent of OS preference / storage)
  if ((await page.locator('html').getAttribute('data-theme')) !== 'dark') {
    await page.getByRole('button', { name: 'Toggle theme' }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // The replay caption sets NO colour — it must inherit the dark-mode (light) text,
  // not the light-mode (dark) value. Luminance must be high enough to read.
  const colour = await page
    .getByText('Replay a saved diagnostics file offline.')
    .evaluate((el) => getComputedStyle(el).color);
  const [r = 0, g = 0, b = 0] = (colour.match(/\d+/g) ?? []).map(Number);
  expect(0.299 * r + 0.587 * g + 0.114 * b).toBeGreaterThan(150);
});

test('connect validates the key; the sample household renders offline — CSP clean', async ({
  page,
}) => {
  const csp = watchCsp(page);
  await page.goto(pathToFileURL(builtFile).href);

  // Empty key → the primary action is disabled (no empty-key "connect").
  const connect = page.getByRole('button', { name: 'Connect and read my usage' });
  await expect(connect).toBeDisabled();

  // Typing enables it (input handler) — both via addEventListener, no inline JS.
  await page.getByPlaceholder('sk_live_xxxxxxxxxxxxxxxx').fill('sk_test_demo_key');
  await expect(connect).toBeEnabled();

  // The offline "sample household" path renders the full results screen with no
  // network, proving click handling + the render pipeline under CSP.
  await page.getByRole('button', { name: 'Use a sample household' }).click();
  await expect(page.getByRole('heading', { name: 'Your comparison' })).toBeVisible();
  await expect(page.locator('#app')).toContainText('Complete periods on your current tariff');

  // The public share panel renders with percentages + the campaign hashtag, and
  // never a £ amount in its share text.
  await expect(page.locator('#app')).toContainText('Share your result');
  const shareText = await page
    .locator('.card .mono', { hasText: '#DynamicTariffCheck' })
    .innerText();
  expect(shareText).toContain('%');
  expect(shareText).not.toContain('£');

  expect(csp, csp.join('\n')).toHaveLength(0);
});
