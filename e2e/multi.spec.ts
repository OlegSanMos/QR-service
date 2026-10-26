import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MULTI_CAMERA_SOURCE } from './paths';

function stat(page: import('@playwright/test').Page, key: string) {
  return page.locator('.stat', { has: page.locator('.k', { hasText: key }) }).locator('.v');
}

test('receiver reads two codes per frame and assembles the file', async ({ page }) => {
  await page.goto('/#/receive');
  // Time from the first accepted frame to completion, taken in the page: Playwright's
  // own waiting re-checks only every 0.1-1 s, which made the result jump by 0.5-1 s.
  const timing = page.evaluate(
    () =>
      new Promise<{ start: number; end: number }>((resolve) => {
        let start = 0;
        const check = (): void => {
          const text = document.body.textContent ?? '';
          if (!start && text.includes('блоков')) start = performance.now();
          if (start && text.includes('✅')) {
            observer.disconnect();
            resolve({ start, end: performance.now() });
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      }),
  );
  await page.getByRole('button', { name: /Включить камеру/ }).click();
  await expect(page.getByText('✅')).toBeVisible({ timeout: 60_000 });
  const { start, end } = await timing;
  const seconds = (end - start) / 1000;
  const unique = Number.parseInt((await stat(page, 'Уникальных кадров').textContent()) ?? '0', 10);
  const rate = unique / seconds;
  test.info().annotations.push({ type: 'speed', description: `${unique} codes in ${seconds.toFixed(1)} s = ${rate.toFixed(1)}/s` });
  console.log(`two-code clip: ${unique} distinct codes in ${seconds.toFixed(2)} s = ${rate.toFixed(1)} codes/s`);
  // The clip delivers ~51 distinct codes/s (2 codes × 30 changes/s, every 7th missing).
  // One shared region for both codes managed ~31.5/s; per-code tracking reads
  // practically all of them (51-53/s measured).
  expect(rate).toBeGreaterThan(45);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Сохранить/ }).click()]);
  expect(readFileSync(await download.path()).equals(readFileSync(MULTI_CAMERA_SOURCE))).toBe(true);
});
