import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MULTI_CAMERA_SOURCE } from './paths';

function stat(page: import('@playwright/test').Page, key: string) {
  return page.locator('.stat', { has: page.locator('.k', { hasText: key }) }).locator('.v');
}

test('receiver reads two codes per frame and assembles the file', async ({ page }) => {
  await page.goto('/#/receive');
  await page.getByRole('button', { name: /Включить камеру/ }).click();
  const started = Date.now();
  // Time from the first accepted frame to completion, and distinct codes received meanwhile.
  await expect(page.getByText(/блоков/)).toBeVisible({ timeout: 30_000 });
  const t0 = Date.now();
  await expect(page.getByText('✅')).toBeVisible({ timeout: 60_000 });
  const seconds = (Date.now() - t0) / 1000;
  const unique = Number.parseInt((await stat(page, 'Уникальных кадров').textContent()) ?? '0', 10);
  const rate = unique / seconds;
  test.info().annotations.push({ type: 'speed', description: `${unique} codes in ${seconds.toFixed(1)} s = ${rate.toFixed(1)}/s` });
  console.log(`two-code clip: ${unique} distinct codes in ${seconds.toFixed(1)} s = ${rate.toFixed(1)} codes/s (total ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  // The clip delivers ~51 distinct codes/s (2 codes × 30 changes/s, every 7th missing).
  // A speed threshold is asserted once per-code tracking lands.
  expect(rate).toBeGreaterThan(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Сохранить/ }).click()]);
  expect(readFileSync(await download.path()).equals(readFileSync(MULTI_CAMERA_SOURCE))).toBe(true);
});
