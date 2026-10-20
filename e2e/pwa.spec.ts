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
  await expect(page.locator('.topbar')).toBeVisible();
  await context.setOffline(false);
});
