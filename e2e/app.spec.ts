import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unpackContainer } from '../src/core/container';
import { TransferReceiver } from '../src/core/transfer';
import '../tests/helpers/zxing'; // configures ZXing's WASM for Node
import { FAKE_CAMERA_SOURCE } from './paths';
import { readBarcodes } from 'zxing-wasm/reader';

test('home page links to all sections', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'QR Air Transfer' })).toBeVisible();
  await page.getByRole('link', { name: /Лимиты/ }).click();
  await expect(page.getByRole('heading', { name: /Лимиты/ })).toBeVisible();
  await expect(page.getByText('Скорость приёма')).toBeVisible();
});

test('sender screen produces a decodable QR stream that reassembles into the file', async ({ page }) => {
  await page.goto('/#/send');
  // Pseudo-random text: deflate cannot shrink it, so the transfer spans many frames.
  let seed = 7;
  const content = Array.from({ length: 2500 }, () => String.fromCharCode(33 + ((seed = (seed * 48271) % 2147483647) % 90))).join('');
  await page.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
  await expect(page.getByText(/note\.txt/)).toBeVisible();
  // Small, slow codes so screenshots can keep up.
  await page.locator('input[type=range]').first().fill('8');
  await page.locator('input[type=range]').nth(1).fill('4');
  await page.getByRole('button', { name: /Начать передачу/ }).click();
  const canvas = page.locator('.stage canvas').first();
  await expect(canvas).toBeVisible();

  const rx = new TransferReceiver();
  let shots = 0;
  const seen = new Set<string>();
  while (!rx.complete && shots < 200) {
    const png = await canvas.screenshot();
    shots++;
    const results = await readBarcodes(new Uint8Array(png), { formats: ['QRCode'], maxNumberOfSymbols: 1 });
    for (const r of results.filter((x) => x.isValid)) {
      seen.add(Buffer.from(r.bytes).toString('hex').slice(0, 40));
      rx.ingest(r.bytes, Date.now());
    }
    await page.waitForTimeout(80);
  }
  expect(seen.size).toBeGreaterThan(1); // the code actually changes over time
  expect(rx.complete).toBe(true);
  expect(rx.status!.K).toBeGreaterThan(10);
  const file = await unpackContainer(rx.stream());
  expect(file.name).toBe('note.txt');
  expect(new TextDecoder().decode(file.data)).toBe(content);
  await page.getByRole('button', { name: /Стоп/ }).click();
  await expect(page.locator('.stage')).toHaveCount(0);
});

function stat(page: import('@playwright/test').Page, key: string) {
  return page.locator('.stat', { has: page.locator('.k', { hasText: key }) }).locator('.v');
}

test('receiver decodes the fake camera stream and offers the file', async ({ page }) => {
  await page.goto('/#/receive');
  await page.getByRole('button', { name: /Включить камеру/ }).click();
  // The camera is opened in its 60 fps mode and, once a code is seen, only the area around it is decoded.
  await expect(page.getByText(/@ 60 к\/с/)).toBeVisible();
  await expect(stat(page, 'Область')).toContainText('слежение', { timeout: 30_000 });
  let bestCameraFps = 0;
  while (!(await page.getByText('✅').isVisible())) {
    const fps = Number.parseInt((await stat(page, 'Камера').textContent()) ?? '0', 10);
    bestCameraFps = Math.max(bestCameraFps, fps);
    await page.waitForTimeout(250);
  }
  expect(bestCameraFps).toBeGreaterThanOrEqual(45);
  await expect(page.getByRole('heading', { name: 'e2e.txt' })).toBeVisible();
  await expect(page.getByText(/CRC-32 ✔/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Сохранить/ }).click()]);
  const saved = readFileSync(await download.path());
  expect(saved.toString('utf8')).toBe(readFileSync(FAKE_CAMERA_SOURCE, 'utf8'));
});
