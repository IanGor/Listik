import { expect, test, type Locator } from '@playwright/test';

test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

async function pasteText(editor: Locator, text: string) {
  await editor.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test('keyboard editing splits, nests and joins outline rows', async ({ page }) => {
  await page.goto('/?db=minimal-structure&empty');
  const rows = page.locator('.row');
  const text = rows.locator('.text');
  const editor = rows.locator('.text[contenteditable]');
  await text.first().tap();
  await editor.fill('alphabeta');
  await editor.press('Home');
  for (let i = 0; i < 'alpha'.length; i++) await editor.press('ArrowRight');
  await editor.press('Enter');
  await expect(text).toHaveText(['alpha', 'beta']);

  await editor.press('Tab');
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');
  await editor.press('Shift+Tab');
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '0');
  await editor.press('ArrowUp');
  await expect(text.first()).toBeFocused();
  await editor.press('ArrowDown');
  await expect(text.nth(1)).toBeFocused();
  await editor.press('Home');
  await editor.press('Backspace');
  await expect(text).toHaveText(['alphabeta']);

  await editor.press('Enter');
  await expect(text).toHaveText(['alpha', 'beta']);
  await editor.press('ArrowUp');
  await editor.press('End');
  await editor.press('Delete');
  await expect(text).toHaveText(['alphabeta']);
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('tapping blank space finishes editing and makes an internal link usable', async ({ page }) => {
  await page.goto('/?db=minimal-editing&empty');
  const rows = page.locator('.row');
  await rows.first().locator('.text').tap();
  const editor = page.locator('.row .text[contenteditable]');
  await editor.fill('Раздел');
  await editor.press('End');
  await editor.press('Enter');
  await editor.fill('Открыть [[Раздел]]');

  await page.locator('.scroller').tap({ position: { x: 30, y: 220 } });
  await expect(editor).toHaveCount(0);
  await rows.nth(1).getByText('Раздел', { exact: true }).tap();
  await expect(page.locator('.crumb.current')).toHaveText('Раздел');
});

test('pasting an address replaces the selected text and leaves the address visible', async ({ page }) => {
  await page.goto('/?db=minimal-editing&empty');
  const text = page.locator('.row .text');
  await text.tap();
  const editor = page.locator('.row .text[contenteditable]');
  await editor.fill('Старый адрес');
  await editor.press('ControlOrMeta+A');
  const address = 'https://example.com/listik';
  await pasteText(editor, address);
  await expect(editor).toHaveText(address);
  await editor.press('Escape');
  await expect(text).toHaveText(address, { useInnerText: true });
});

test('pasting an indented list preserves its structure', async ({ page }) => {
  await page.goto('/?db=minimal-paste-tree&empty');
  const rows = page.locator('.row');
  await rows.locator('.text').tap();
  await pasteText(rows.locator('.text[contenteditable]'), 'Раздел\n  Пункт\nДругой раздел');
  await expect(rows.locator('.text')).toHaveText(['Раздел', 'Пункт', 'Другой раздел']);
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');
  await expect(rows.nth(2)).toHaveAttribute('data-depth', '0');
});
