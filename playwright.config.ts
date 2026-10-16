import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Prefer a system Chromium (no browser download); otherwise Playwright's own,
// installed with `npx playwright install chromium`.
const chromium = process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
// IPv4 explicitly: `localhost` resolves to ::1 first, which hangs on some setups.
const origin = 'http://127.0.0.1:5180';

export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: origin,
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5180 --strictPort',
    url: origin,
    reuseExistingServer: !process.env.CI,
  },
});
