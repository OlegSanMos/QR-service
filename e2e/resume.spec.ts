import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { RESUME_CAMERA_SOURCE } from './paths';

// Runs in the 'resume' project: a slow fake camera (8 codes/s, see resume-clip.ts)
// so a reload lands mid-transfer.

const RESUME_NOTE = 'Продолжаем прерванный приём';

/** Blocks collected and needed, from the progress label ("12 / 60 блоков · …"); zeros before a transfer shows. */
async function blocks(page: Page): Promise<{ rank: number; K: number }> {
  const text = (await page.locator('.card', { has: page.locator('.progress') }).textContent()) ?? '';
  const m = /(\d+) \/ (\d+) блоков/.exec(text);
  return m ? { rank: Number(m[1]), K: Number(m[2]) } : { rank: 0, K: 0 };
}

/** Starts receiving and reloads the page once part of the transfer has been stored. */
async function receivePartlyAndReload(page: Page): Promise<{ seen: number; K: number }> {
  await page.goto('/#/receive');
  await page.getByRole('button', { name: /Включить камеру/ }).click();
  await expect.poll(async () => (await blocks(page)).rank, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const seen = (await blocks(page)).rank;
  await page.waitForTimeout(1000); // frames are written in batches every 400 ms
  const before = await blocks(page);
  expect(before.rank).toBeLessThan(before.K); // the reload has to interrupt the transfer
  await page.reload();
  return { seen, K: before.K };
}

test('reception interrupted by a reload resumes from the stored progress', async ({ page }) => {
  const { seen, K } = await receivePartlyAndReload(page);

  // The stored progress is back before the camera is switched on.
  await expect(page.getByText(RESUME_NOTE)).toBeVisible();
  const cameraBtn = page.getByRole('button', { name: /Включить камеру/ });
  await expect(cameraBtn).toBeVisible();
  const restored = await blocks(page);
  expect(restored.K).toBe(K);
  expect(restored.rank).toBeGreaterThanOrEqual(seen);
  expect(restored.rank).toBeLessThan(K);

  await cameraBtn.click();
  await expect(page.getByText(RESUME_NOTE)).toBeHidden();
  await expect(page.getByText('✅')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'resume.txt' })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Сохранить/ }).click()]);
  expect(readFileSync(await download.path()).toString('utf8')).toBe(readFileSync(RESUME_CAMERA_SOURCE, 'utf8'));

  // Delivered: nothing is left to resume.
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.getByText(RESUME_NOTE)).toBeHidden();
  await expect(page.getByText('Ожидание кодов…')).toBeVisible();
});

test('"Начать заново" discards an interrupted reception', async ({ page }) => {
  await receivePartlyAndReload(page);
  await expect(page.getByText(RESUME_NOTE)).toBeVisible();
  expect((await blocks(page)).rank).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Начать заново' }).click();
  await expect(page.getByText(RESUME_NOTE)).toBeHidden();
  await expect(page.getByText('Ожидание кодов…')).toBeVisible();

  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.getByText(RESUME_NOTE)).toBeHidden();
  await expect(page.getByText('Ожидание кодов…')).toBeVisible();
});

test('a restarted sender continues after the last code it showed', async ({ page }) => {
  await page.goto('/#/send');
  // Incompressible, ~130 codes: the systematic pass lasts several seconds.
  let seed = 11;
  const data = Buffer.from(new Uint8Array(200_000).map(() => (seed = (seed * 48271) % 2147483647) & 255));
  await page.locator('input[type=file]').first().setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: data });
  await expect(page.getByText(/big\.bin/).first()).toBeVisible();
  const startBtn = page.getByRole('button', { name: /Начать передачу/ });
  /** "исходные блоки N/K" in the sender's HUD: systematic codes shown so far (0 until the first). */
  const shown = async (): Promise<number> => {
    const m = /исходные блоки (\d+)\//.exec((await page.locator('.stage .info').textContent()) ?? '');
    return m ? Number(m[1]) : 0;
  };

  await startBtn.click();
  await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThanOrEqual(30);
  const atStop = await shown();
  await page.getByRole('button', { name: /Стоп/ }).click();
  await expect(page.locator('.stage')).toHaveCount(0);

  // Same file, same settings ⇒ same transfer id: the first code shown continues the count.
  await startBtn.click();
  let first = 0;
  await expect.poll(async () => (first = await shown()), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(first).toBeGreaterThan(atStop);
  await page.getByRole('button', { name: /Стоп/ }).click();
});
