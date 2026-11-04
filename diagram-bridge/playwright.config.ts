import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'roundtrip.spec.ts', workers: 1, timeout: 90_000,
  use: { viewport: { width: 1500, height: 1050 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: 'list',
});
