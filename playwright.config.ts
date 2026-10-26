import { defineConfig } from '@playwright/test';
import { FAKE_CAMERA_VIDEO, MULTI_CAMERA_VIDEO } from './e2e/paths';

const fakeCamera = (clip: string): string[] => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${clip}`,
];

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
  },
  projects: [
    { name: 'one-code', testIgnore: /multi\.spec/, use: { launchOptions: { args: fakeCamera(FAKE_CAMERA_VIDEO) } } },
    { name: 'two-codes', testMatch: /multi\.spec/, use: { launchOptions: { args: fakeCamera(MULTI_CAMERA_VIDEO) } } },
  ],
});
