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

const colors = {
  light: { canvas: 'rgb(250, 249, 245)', text: 'rgb(20, 20, 19)', chrome: '#faf9f5' },
  dark: { canvas: 'rgb(38, 38, 36)', text: 'rgb(250, 249, 245)', chrome: '#262624' },
} as const;

for (const scheme of ['light', 'dark'] as const) {
  test(`first paint is ${scheme} before the app bundle, despite old theme settings`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(oldMode => {
      localStorage.setItem('listik-appearance', JSON.stringify({ version: 1, themeId: 'dracula', mode: oldMode }));
      localStorage.setItem('listik-theme', oldMode);
      localStorage.setItem('listik-theme-system', oldMode);
    }, scheme === 'light' ? 'dark' : 'light');
    await page.route('**/assets/*.js', route => route.abort());
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveCSS('background-color', colors[scheme].canvas);
    await expect(page.locator('body')).toHaveCSS('color', colors[scheme].text);
    const themeColor = await page.locator('meta[name="theme-color"]').evaluateAll(nodes =>
      nodes.find(node => matchMedia(node.getAttribute('media') ?? 'all').matches)?.getAttribute('content'),
    );
    expect(themeColor?.toLowerCase()).toBe(colors[scheme].chrome);
  });
}

for (const mode of ['minimal', 'legacy'] as const) {
  test(`the ${mode} interface follows the system live and offline`, async ({ page, context }) => {
    await page.addInitScript(view => localStorage.setItem('listik-view-mode', view), mode);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?demo');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await expect(page.getByRole('menuitem', { name: /^Тема/ })).toHaveCount(0);
    await expect(page.getByRole('menu')).not.toHaveCSS('box-shadow', 'none');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.getByRole('menu')).not.toHaveCSS('box-shadow', 'none');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    const row = page.locator('.row .text').first();
    await row.click();
    const editor = page.locator('.row .text[contenteditable]');
    await expect(editor).toBeFocused();
    await expect(page.locator('body')).toHaveCSS('background-color', colors.light.canvas);
    await context.setOffline(true);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('body')).toHaveCSS('background-color', colors.dark.canvas);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText('Том первый');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('body')).toHaveCSS('color', colors.light.text);
    await expect(editor).toBeFocused();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(row).toHaveText('Том первый');
    await expect(page.locator('body')).toHaveCSS('background-color', colors.dark.canvas);
  });
}
