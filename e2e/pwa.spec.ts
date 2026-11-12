import { expect, test } from '@playwright/test';

test('the built app is installable and opens offline, with its data', async ({ page, context }) => {
  await page.goto('/?db=e2e-pwa&empty');
  await expect(page.locator('.row')).toHaveCount(1);
  await page.locator('.row .text').click();
  await page.keyboard.type('без интернета');
  await page.waitForTimeout(500); // writes are batched for 300 ms

  // Installable: a manifest with a name and icons.
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
    return (await fetch(href)).json();
  });
  expect(manifest).toMatchObject({ name: 'Listik', display: 'standalone' });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));

  // The service worker takes control, and has cached what the page needs.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator('.row .text')).toHaveText('без интернета');

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.row .text')).toHaveText('без интернета');
  await expect(page.locator('.document-header')).toBeVisible();
  await context.setOffline(false);
});

test('the built app runs under its Content Security Policy: editing, the compaction worker, Argon2id and sync break none of it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    (window as unknown as { violations: string[] }).violations = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { violations: string[] }).violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto('/?db=e2e-csp&empty');
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("script-src 'self' 'sha256-");
  await page.locator('.row .text').click();
  await page.keyboard.type('под CSP');
  await page.waitForTimeout(400);
  // Turning sync on: Argon2id (WebAssembly), the worker that re-encrypts the store, requests to the server.
  await page.locator('.document-header [aria-label="Меню документа"]').click();
  await page.getByRole('menuitem', { name: /Синхронизация/ }).click();
  await page.locator('.sync-dialog input[type="url"]').fill('http://127.0.0.1:5182');
  const passwords = page.locator('.sync-dialog input[type="password"]');
  await passwords.nth(0).fill('пароль под политикой');
  await passwords.nth(1).fill('пароль под политикой');
  await page.getByRole('button', { name: 'Создать и включить' }).click();
  await expect(page.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30_000 });
  await page.reload();
  await expect(page.locator('.row .text')).toHaveText('под CSP');
  expect(await page.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
});

test('bundled themes persist and switch offline under the production CSP', async ({ page, context }) => {
  await page.goto('/?demo');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await page.getByRole('menuitem', { name: /^Тема / }).click();
  await page.getByRole('radio', { name: 'Dracula', exact: true }).check();
  await page.getByRole('radio', { name: 'Светлая', exact: true }).check();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await page.getByRole('menuitem', { name: /^Тема / }).click();
  await expect(page.getByRole('radio', { name: 'Светлая', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Catppuccin', exact: true }).check();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(239, 241, 245)');
  await context.setOffline(false);
});

test('first paint resolves the saved palette even before the app bundle loads', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('listik-appearance', JSON.stringify({ version: 1, themeId: 'dracula', mode: 'light' })));
  await page.route('**/assets/*.js', route => route.abort());
  await page.goto('/?demo');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'dracula');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#282a36');
});
