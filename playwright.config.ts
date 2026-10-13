import { defineConfig } from '@playwright/test';
import { FAKE_CAMERA_VIDEO } from './e2e/paths';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    acceptDownloads: true,
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${FAKE_CAMERA_VIDEO}`,
      ],
    },
  },
});
