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

test('Shift+Enter replaces a selection with a line break inside the same row', async ({ page }) => {
  await page.goto('/?db=minimal-line-break&empty');
  const rows = page.locator('.row');
  const text = rows.locator('.text');
  const editor = rows.locator('.text[contenteditable]');
  await text.tap();
  await editor.fill('alphaXbeta');
  await editor.press('Home');
  for (let i = 0; i < 'alpha'.length; i++) await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+Enter');
  await expect(rows).toHaveCount(1);
  await expect.poll(() => editor.textContent()).toBe('alpha\nbeta');

  await page.keyboard.type('new ');
  await expect.poll(() => editor.textContent()).toBe('alpha\nnew beta');
  await editor.press('Escape');
  await expect.poll(() => text.innerText()).toBe('alpha\nnew beta');
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => text.innerText()).toBe('alpha\nnew beta');
});

test('Shift+Enter opens an empty last line and Enter still splits the row', async ({ page }) => {
  await page.goto('/?db=minimal-last-line&empty');
  const rows = page.locator('.row');
  const text = rows.locator('.text');
  const editor = rows.locator('.text[contenteditable]');
  await text.tap();
  await editor.fill('previous');
  await editor.press('End');
  await editor.press('Enter');
  await editor.fill('alpha');
  await editor.press('End');
  const singleLineHeight = await editor.evaluate((el) => el.getBoundingClientRect().height);
  await editor.press('Shift+Enter');
  await expect(rows).toHaveCount(2);
  await expect.poll(() => editor.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(singleLineHeight);

  await editor.press('ArrowUp');
  await expect(text.nth(1)).toBeFocused();
  await editor.press('ArrowDown');
  await page.keyboard.type('beta');
  await expect.poll(() => editor.textContent()).toBe('alpha\nbeta');
  await editor.press('End');
  await editor.press('Shift+Enter');
  await editor.press('Backspace');
  await expect.poll(() => editor.textContent()).toBe('alpha\nbeta');
  await editor.press('Enter');
  await page.keyboard.type('gamma');
  await expect(rows).toHaveCount(3);
  await expect.poll(() => text.nth(1).textContent()).toBe('alpha\nbeta');
  await editor.press('Shift+Enter');
  await editor.press('Escape');
  await expect.poll(() => text.last().innerText()).toBe('gamma\n');
  await expect.poll(() => text.last().evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(singleLineHeight);
});

test.describe('hardware keyboard', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: false, isMobile: false });

  test('history shortcuts undo and redo typing, line breaks and row splits', async ({ page }) => {
    await page.goto('/?db=minimal-history&empty');
    const rows = page.locator('.row');
    const text = rows.locator('.text');
    const editor = rows.locator('.text[contenteditable]');
    await text.click();
    await page.keyboard.type('alpha');
    await page.keyboard.press('Control+z');
    await expect(editor).toBeEmpty();
    await page.keyboard.press('Meta+Shift+z');
    await expect(editor).toHaveText('alpha');

    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => editor.textContent()).toBe('alpha\n');
    await page.keyboard.press('Meta+z');
    await expect.poll(() => editor.textContent()).toBe('alpha');
    await page.keyboard.press('Control+y');
    await expect.poll(() => editor.textContent()).toBe('alpha\n');

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(text).toHaveText(['a', 'lpha']);
    await expect(text.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(rows).toHaveCount(1);
    await expect(editor).toBeFocused();
    await expect.poll(() => editor.textContent()).toBe('alpha\n');
    expect(await page.evaluate(() => getSelection()?.focusOffset)).toBe(1);
    await page.keyboard.press('Control+Shift+z');
    await expect(text).toHaveText(['a', 'lpha']);
    await expect(text.last()).toBeFocused();
    await expect(page.getByRole('toolbar', { name: 'Правка пункта' })).toBeHidden();
  });
});

test.describe('tablet software keyboard', () => {
  test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });

  test('the history toolbar follows the keyboard and its taps keep focus', async ({ page }) => {
    await page.goto('/?db=minimal-history-toolbar&empty');
    const text = page.locator('.row .text');
    const editor = page.locator('.row .text[contenteditable]');
    const toolbar = page.getByRole('toolbar', { name: 'Правка пункта' });
    await text.tap();
    await page.keyboard.type('alpha');
    await page.keyboard.press('Shift+Enter');
    await expect(toolbar).toBeHidden();

    const layoutHeight = await page.evaluate(() => innerHeight);
    const setVisualViewport = (height: number, offsetTop: number) => page.evaluate(({ height, offsetTop }) => {
      const viewport = window.visualViewport!;
      Object.defineProperties(viewport, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
      });
      viewport.dispatchEvent(new Event('resize'));
    }, { height, offsetTop });
    await setVisualViewport(780, 20);
    expect(await page.evaluate(() => innerHeight)).toBe(layoutHeight);
    await expect(toolbar).toBeVisible();
    const box = (await toolbar.boundingBox())!;
    expect(box.y + box.height).toBeCloseTo(800, 0);
    await expect(toolbar.getByRole('button')).toHaveCount(2);

    await toolbar.getByRole('button', { name: 'Отменить' }).tap();
    await expect.poll(() => editor.textContent()).toBe('alpha');
    await expect(editor).toBeFocused();
    await toolbar.getByRole('button', { name: 'Повторить' }).tap();
    await expect.poll(() => editor.textContent()).toBe('alpha\n');
    await expect(editor).toBeFocused();

    await setVisualViewport(layoutHeight, 0);
    await expect(toolbar).toBeHidden();
    await expect(editor).toBeFocused();
    await page.keyboard.type('beta');
    await expect.poll(() => editor.textContent()).toBe('alpha\nbeta');
  });
});

test('the history toolbar also follows a phone layout resize', async ({ page }) => {
  await page.goto('/?db=minimal-history-phone&empty');
  await page.locator('.row .text').tap();
  const editor = page.locator('.row .text[contenteditable]');
  const toolbar = page.getByRole('toolbar', { name: 'Правка пункта' });
  await expect(toolbar).toBeHidden();

  const viewport = page.viewportSize()!;
  const openHeight = 540;
  await page.setViewportSize({ ...viewport, height: openHeight });
  await expect(toolbar).toBeVisible();
  const box = (await toolbar.boundingBox())!;
  expect(box.y + box.height).toBeCloseTo(openHeight, 0);

  await page.setViewportSize(viewport);
  await expect(toolbar).toBeHidden();
  await expect(editor).toBeFocused();
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

test('copied lines paste into the same bullet without splitting it', async ({ page }) => {
  await page.goto('/?db=minimal-copy-lines&empty');
  const rows = page.locator('.row');
  await rows.locator('.text').tap();
  const editor = rows.locator('.text[contenteditable]');
  await editor.fill('alpha');
  await editor.press('End');
  await editor.press('Shift+Enter');
  await page.keyboard.type('- beta');
  await editor.press('Shift+Enter');
  await editor.press('Shift+Enter');
  await page.keyboard.type('  gamma');
  const original = 'alpha\n- beta\n\n  gamma';
  await expect.poll(() => editor.textContent()).toBe(original);
  await editor.press('ControlOrMeta+a');
  await editor.press('ControlOrMeta+c');
  await editor.press('Control+End');
  await editor.press('Shift+Enter');
  await editor.press('ControlOrMeta+v');
  await expect(rows).toHaveCount(1);
  await expect.poll(() => editor.textContent()).toBe(original + '\n' + original);
});

test('copied bullets paste as distinct nodes with their original lines and nesting', async ({ page }) => {
  await page.goto('/?db=minimal-copy-bullets&empty');
  const rows = page.locator('.row');
  const text = rows.locator('.text');
  const editor = rows.locator('.text[contenteditable]');
  await text.tap();
  await pasteText(editor, 'parent\n  child\n  outside selection\ndestination');
  await text.first().tap();
  await editor.press('Control+End');
  await editor.press('Shift+Enter');
  await page.keyboard.type('- continuation');
  await editor.press('Control+End');
  await editor.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.row.selected')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('Escape');
  await text.last().tap();
  await editor.press('ControlOrMeta+v');
  await expect(rows).toHaveCount(6);
  await expect.poll(() => text.nth(4).textContent()).toBe('parent\n- continuation');
  await expect(text.nth(3)).toHaveText('destination');
  await expect(text.nth(5)).toHaveText('child');
  await expect(rows.nth(5)).toHaveAttribute('data-depth', '1');
});
