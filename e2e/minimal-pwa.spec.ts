import { expect, test } from '@playwright/test';

test('the new interface preserves edits offline and follows the system appearance', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?db=minimal-offline&empty');
  const row = page.locator('.minimal-outline .row .text');
  await row.click();
  const editor = page.locator('.row .text[contenteditable]');
  await editor.fill('Доступно без сети');
  await editor.press('Escape');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 249, 245)');

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(row).toHaveText('Доступно без сети');

  await context.setOffline(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(38, 38, 36)');
  await page.reload();
  await expect(row).toHaveText('Доступно без сети');
  await row.click();
  await editor.fill('Правка без сети');
  await editor.press('Escape');
  await expect(row).toHaveText('Правка без сети');
});
