import type {} from '../src/view/omarchy';
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('Omarchy owns the palette and changes it without losing edits or focus', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('listik-theme', 'light');
    localStorage.setItem('listik-theme-system', 'light');
    let state = { version: 1 as const, managed: true, palette: { mode: 'dark' as 'dark' | 'light', colors: { background: '#1f1f28', foreground: '#dcd7ba', accent: '#7e9cd8' } } };
    const listeners = new Set<(s: unknown) => void>();
    window.listikDesktop = { version: 1, getTheme: () => state, onTheme: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
    addEventListener('test-theme', () => {
      state = { version: 1, managed: true, palette: { mode: 'light', colors: { background: '#faf9f5', foreground: '#1f1e1c', accent: '#28706a' } } };
      for (const cb of listeners) cb(state);
    });
  });
  await page.goto('/?db=omarchy&empty');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(31, 31, 40)');
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Тёмная тема' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.row .text').click();
  await page.keyboard.type('keep this edit');
  await page.evaluate(() => dispatchEvent(new Event('test-theme')));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.text[contenteditable]')).toBeFocused();
  await expect(page.locator('.row .text')).toHaveText('keep this edit');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 249, 245)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await mkdir('test-results/omarchy', { recursive: true });
  await expect(page.locator('.searchbar')).toHaveCSS('background-color', 'rgb(241, 240, 236)');
  await page.screenshot({ path: 'test-results/omarchy/light.png' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/omarchy/dark.png' });
  await page.keyboard.press('Control+k');
  await page.locator('.goto input').fill('>Тема');
  await expect(page.getByText('Тема: светлая / тёмная', { exact: true })).toHaveCount(0);
});

test('ordinary browser retains manual choice, managed fallback hides it', async ({ page }) => {
  await page.goto('/?db=ordinary&empty');
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Тёмная тема' })).toBeVisible();
  await page.addInitScript(() => {
    window.listikDesktop = { version: 1, getTheme: () => ({ version: 1, managed: true, palette: null }), onTheme: () => () => {} };
  });
  await page.reload();
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Тёмная тема' })).toHaveCount(0);
});
