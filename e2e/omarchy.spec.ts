import type {} from '../src/view/omarchy';
import { expect, test, type Page } from '@playwright/test';

async function openThemes(page: Page) {
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await page.getByRole('menuitem', { name: /^Тема / }).click();
  return page.getByRole('dialog', { name: 'Тема', exact: true });
}
test('catalogue: variants, persistence, auto, keyboard and exact default restoration', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?demo');
  const original = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
  let panel = await openThemes(page);
  await expect(panel.getByRole('radio', { name: 'Omarchy' })).toBeDisabled();
  await panel.getByRole('radio', { name: 'Светлая', exact: true }).check();
  await panel.getByRole('radio', { name: 'Dracula', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(panel.getByText('У этой темы только тёмный вариант')).toBeVisible();
  await expect(panel.getByRole('radio', { name: 'Светлая', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Меню документа' })).toBeFocused();
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  panel = await openThemes(page);
  await panel.getByRole('radio', { name: 'Listik · По умолчанию' }).check();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await panel.getByRole('radio', { name: 'Авто', exact: true }).check();
  await expect(page.locator('body')).toHaveCSS('background-color', original);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
test('all bundled palettes work on desktop and phone without Omarchy', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?demo');
  const panel = await openThemes(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const name of ['Retro 82', 'Ristretto', 'Kanagawa', 'Osaka Jade', 'Dracula', 'Catppuccin', 'Gruvbox', 'Tokyo Night', 'Nord', 'Listik · По умолчанию']) {
      const radio = panel.getByRole('radio', { name, exact: true });
      await radio.check();
      await expect(radio).toBeChecked();
      for (const mode of ['Светлая', 'Тёмная', 'Авто']) await panel.getByRole('radio', { name: mode, exact: true }).check();
    }
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await panel.getByRole('radio', { name: 'Catppuccin', exact: true }).check();
    await page.screenshot({ path: `/tmp/listik-theme-panel-${width}.png` });
    await panel.getByRole('radio', { name: 'Тёмная', exact: true }).check();
    await page.screenshot({ path: `/tmp/listik-theme-panel-dark-${width}.png` });
  }
  await panel.getByRole('button', { name: 'Готово' }).click();
  await page.keyboard.press('Control+k');
  await page.locator('.goto input').fill('>тему');
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
});
test('Omarchy is explicit, updates live and never overrides another theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    let state: unknown = { version: 1, managed: true, palette: { mode: 'dark', colors: { background: '#1f1f28', foreground: '#dcd7ba', accent: '#7e9cd8' } } };
    const listeners = new Set<(s: unknown) => void>();
    window.listikDesktop = { version: 1, getTheme: () => state, onTheme: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
    addEventListener('test-theme', () => {
      state = { version: 1, managed: true, palette: { mode: 'light', colors: { background: '#faf9f5', foreground: '#1f1e1c' } } };
      for (const cb of listeners) cb(state);
    });
    addEventListener('test-invalid', () => { for (const cb of listeners) cb({ version: 1, managed: true, palette: null }); });
    addEventListener('test-disconnect', () => { for (const cb of listeners) cb({ version: 1, managed: false, palette: null }); });
  });
  await page.goto('/?demo');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const panel = await openThemes(page);
  await panel.getByRole('radio', { name: 'Omarchy', exact: true }).check();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(31, 31, 40)');
  await page.evaluate(() => dispatchEvent(new Event('test-invalid')));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(31, 31, 40)');
  await page.evaluate(() => dispatchEvent(new Event('test-theme')));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 249, 245)');
  await page.evaluate(() => dispatchEvent(new Event('test-disconnect')));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.evaluate(() => dispatchEvent(new Event('test-theme')));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 249, 245)');
  await panel.getByRole('radio', { name: 'Dracula', exact: true }).check();
  await page.evaluate(() => dispatchEvent(new Event('test-theme')));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  await panel.getByRole('radio', { name: 'Omarchy', exact: true }).check();
  await panel.getByRole('button', { name: 'Готово' }).click();
  await page.locator('.row .text').first().click();
  const editor = page.locator('.text[contenteditable]').first();
  await editor.fill('Сохраняем фокус при смене палитры');
  await page.evaluate(() => dispatchEvent(new Event('test-theme')));
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('Сохраняем фокус при смене палитры');
});
