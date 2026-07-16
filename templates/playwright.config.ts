import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './scenarios',
  // Только чистовики: draft.js фазы 1 раннер подхватывать не должен.
  testMatch: '**/final.spec.ts',
  use: {
    baseURL: process.env.BASE_URL || '{{BASE_URL}}',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['html', { outputFolder: 'scenarios/_playwright-report', open: 'never' }]],
  retries: 1,
});
