import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Prefer a system Chromium (no browser download); otherwise Playwright's own,
// installed with `npx playwright install chromium`.
const chromium = process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
// IPv4 explicitly: `localhost` resolves to ::1 first, which hangs on some setups.
const dev = 'http://127.0.0.1:5180';
// The built app, for what only a production build does (service worker, offline).
const built = 'http://127.0.0.1:5181';

export default defineConfig({
  testDir: 'e2e',
  use: {
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  projects: [
    { name: 'app', testMatch: 'outline.spec.ts', use: { baseURL: dev } },
    { name: 'pwa', testMatch: 'pwa.spec.ts', use: { baseURL: built } },
  ],
  webServer: [
    {
      command: 'npx vite --host 127.0.0.1 --port 5180 --strictPort',
      url: dev,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --host 127.0.0.1 --port 5181 --strictPort',
      url: built,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
