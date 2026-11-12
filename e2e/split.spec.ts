import { expect, test, type Page } from '@playwright/test';

const pane = (page: Page, n: number) => page.locator(`[data-pane="${n}"]`);
async function openSplit(page: Page) {
  await page.getByRole('button', { name: 'Меню документа', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Открыть split view', exact: true }).click();
  await expect(pane(page, 1)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?demo');
  await expect(page.locator('.row')).toHaveCount(6);
});

test('navigation keeps calendar, search and favorites without a tree', async ({ page }) => {
  await page.locator('.navigation-toggle').click();
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Свернуть дерево', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar-calendar')).toBeVisible();
  await expect(page.locator('input.search')).toBeVisible();
});

test('menu opens two copies of the current slice and navigation stays independent', async ({ page }) => {
  await page.locator('.row').first().locator('.bullet').click();
  await openSplit(page);
  for (const n of [0, 1]) await expect(pane(page, n).locator('.zoom-title')).toHaveText('Том первый');
  await pane(page, 0).locator('.crumbs .crumb').first().click();
  await expect(pane(page, 0).locator('.document-home-title')).toHaveText('Главная');
  await expect(pane(page, 1).locator('.zoom-title')).toHaveText('Том первый');
  await pane(page, 0).locator('.row').last().locator('.bullet').click();
  await expect(pane(page, 0).locator('.zoom-title')).toHaveText('Том второй');
  await expect(pane(page, 1).locator('.zoom-title')).toHaveText('Том первый');
  await page.screenshot({ path: '/tmp/listik-split-independent.png' });
});

test('text and notes can be edited in either pane and shared undo runs once', async ({ page }) => {
  await page.locator('.row').first().locator('.bullet').click();
  await openSplit(page);
  const right = pane(page, 1), left = pane(page, 0);
  await right.locator('.zoom-title').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' справа');
  await page.keyboard.press('Escape');
  await expect(left.locator('.zoom-title')).toHaveText('Том первый справа');
  await page.keyboard.press('Control+z');
  await expect(left.locator('.zoom-title')).toHaveText('Том первый');
  await expect(right.locator('.zoom-title')).toHaveText('Том первый');
  await left.locator('.row .text', { hasText: 'Часть вторая' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' слева');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Заметка в левой области');
  await right.locator('.row .text', { hasText: 'Часть первая' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' справа');
  await expect(left.locator('.row .note', { hasText: 'Заметка в левой области' })).toBeVisible();
  await expect(right.locator('.row .text', { hasText: 'Часть вторая слева' })).toBeVisible();
  await expect(left.locator('.row .text', { hasText: 'Часть первая справа' })).toBeVisible();
  await expect(page.locator('[contenteditable]')).toHaveCount(1);
});

test('folding a branch is local to its pane', async ({ page }) => {
  await openSplit(page);
  await pane(page, 1).locator('.row', { hasText: 'Том первый' }).locator('.toggle').click();
  await expect(pane(page, 1).locator('.row .text', { hasText: 'Часть первая' })).toHaveCount(0);
  await expect(pane(page, 0).locator('.row .text', { hasText: 'Часть первая' })).toBeVisible();
  await pane(page, 0).locator('.row', { hasText: 'Часть первая' }).locator('.toggle').click();
  await expect(pane(page, 1).locator('.row')).toHaveCount(2);
  await expect(pane(page, 0).locator('.row')).toHaveCount(4);
});

test('narrow windows preserve the active slice and closing split keeps it', async ({ page }) => {
  await openSplit(page);
  await pane(page, 1).locator('.row').last().locator('.bullet').click();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(pane(page, 0)).toBeHidden();
  await expect(pane(page, 1).locator('.zoom-title')).toHaveText('Том второй');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(pane(page, 0)).toBeVisible();
  const divider = page.getByRole('separator', { name: 'Ширина областей' });
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '52');
  await page.getByRole('button', { name: 'Меню документа', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Закрыть split view', exact: true }).click();
  await expect(pane(page, 0)).toBeHidden();
  await expect(pane(page, 1).locator('.zoom-title')).toHaveText('Том второй');
  expect((await pane(page, 1).boundingBox())!.width).toBe(1440);
});

test('stored slices, ratio and active pane survive reload', async ({ page }) => {
  await page.goto('/?db=e2e-split-restore&empty');
  await page.locator('.row .text').click();
  await page.keyboard.type('Первый');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Второй');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await openSplit(page);
  await pane(page, 1).locator('.row').last().locator('.bullet').click();
  await pane(page, 0).locator('.row').first().locator('.bullet').click();
  await expect(pane(page, 0).locator('.zoom-title')).toHaveText('Первый');
  await expect(pane(page, 1).locator('.zoom-title')).toHaveText('Второй');
  for (const n of [1, 0]) {
    await pane(page, n).locator('.zoom-title').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' изменён');
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(500); // Persist both pane edits through the shared 300ms writer batch.
  await page.getByRole('separator', { name: 'Ширина областей' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('listik-split:e2e-split-restore'))).not.toBeNull();
  await page.reload();
  await expect(pane(page, 0).locator('.zoom-title')).toHaveText('Первый изменён');
  await expect(pane(page, 1).locator('.zoom-title')).toHaveText('Второй изменён');
  await expect(pane(page, 0)).toHaveClass(/active/);
  await expect(page.getByRole('separator', { name: 'Ширина областей' })).toHaveAttribute('aria-valuenow', '52');
});

test('opening is unavailable on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1000 });
  await page.getByRole('button', { name: 'Меню документа', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Открыть split view', exact: true })).toHaveCount(0);
});

test('search and its keyboard shortcut belong only to the active pane', async ({ page }) => {
  await openSplit(page);
  const left = pane(page, 0), right = pane(page, 1);
  await page.keyboard.press('Control+f');
  await expect(right.locator('input.search')).toBeFocused();
  await right.locator('input.search').fill('Том');
  await expect(right.locator('.row')).toHaveCount(2);
  await expect(left.locator('.row')).toHaveCount(6);
  await left.locator('.document-home-title').click();
  await page.keyboard.press('Control+f');
  await expect(left.locator('input.search')).toBeFocused();
  await expect(left.locator('input.search')).toHaveValue('');
  await expect(right.locator('input.search')).toHaveValue('Том');
  await expect(page.locator('input.search:focus')).toHaveCount(1);
});

test('deleting the slice open in the other pane returns it safely to home', async ({ page }) => {
  await page.locator('.row').first().locator('.bullet').click();
  await openSplit(page);
  const left = pane(page, 0), right = pane(page, 1);
  await right.locator('.crumbs .crumb').first().click();
  await right.locator('.row .text', { hasText: /^Том первый$/ }).click();
  await page.keyboard.press('Control+Shift+Backspace');
  await expect(left.locator('.document-home-title')).toHaveText('Главная');
  await expect(left.locator('.row .text')).toHaveText(['Том второй']);
  await expect(right.locator('.row .text')).toHaveText(['Том второй']);
});

test('a second browser tab keeps both split panes read-only', async ({ page, context }) => {
  await page.goto('/?db=e2e-split-readonly&empty');
  await page.locator('.row .text').click();
  await page.keyboard.type('Общая запись');
  await page.waitForTimeout(500); // IndexedDB batches writes for 300ms.
  const reader = await context.newPage();
  await reader.goto('/?db=e2e-split-readonly&empty');
  await expect(reader.locator('.banner')).toContainText('только просмотр');
  await openSplit(reader);
  for (const n of [0, 1]) {
    await pane(reader, n).locator('.row .text').click();
    await expect(pane(reader, n).locator('[contenteditable]')).toHaveCount(0);
    await expect(pane(reader, n).locator('[data-action="TopBar.3"]')).toHaveCount(0);
    await expect(pane(reader, n).locator('.row .text')).toHaveText(['Общая запись']);
  }
  await reader.close();
});

test('each pane keeps its own scroll and reload restores both', async ({ page }) => {
  await page.goto('/?db=e2e-split-scroll&empty');
  await page.locator('.row .text').click();
  await page.locator('.text[contenteditable]').evaluate(el => {
    const data = new DataTransfer();
    data.setData('text/plain', Array.from({ length: 150 }, (_, i) => `Строка ${i}`).join('\n'));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await openSplit(page);
  const left = pane(page, 0).locator('.scroller'), right = pane(page, 1).locator('.scroller');
  await left.evaluate(el => { el.scrollTop = 300; });
  await right.evaluate(el => { el.scrollTop = 1000; });
  await expect.poll(() => left.evaluate(el => el.scrollTop)).toBe(300);
  await expect.poll(() => right.evaluate(el => el.scrollTop)).toBe(1000);
  await page.reload();
  await expect.poll(() => pane(page, 0).locator('.scroller').evaluate(el => el.scrollTop)).toBe(300);
  await expect.poll(() => pane(page, 1).locator('.scroller').evaluate(el => el.scrollTop)).toBe(1000);
});

test('row menus in the right pane use window coordinates and stay usable', async ({ page }) => {
  await openSplit(page);
  await pane(page, 1).locator('.row .text', { hasText: /^Том второй$/ }).click({ button: 'right' });
  const menu = page.locator('.row-menu');
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await menu.getByRole('menuitem', { name: /Сделать задачей/ }).click();
  await expect(pane(page, 0).locator('.row').last().getByRole('checkbox')).toBeVisible();
  await expect(pane(page, 1).locator('.row').last().getByRole('checkbox')).toBeVisible();
});

test('touch can switch editors between both large-screen panes', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 1194, height: 834 } });
  const touchPage = await context.newPage();
  try {
    await touchPage.goto('/?demo');
    await openSplit(touchPage);
    await pane(touchPage, 0).locator('.row .text', { hasText: /^Том второй$/ }).tap();
    await touchPage.keyboard.press('Control+End');
    await touchPage.keyboard.type(' слева');
    await pane(touchPage, 1).locator('.row .text', { hasText: /^Том первый$/ }).tap();
    await touchPage.keyboard.press('Control+End');
    await touchPage.keyboard.type(' справа');
    await expect(pane(touchPage, 0).locator('.row .text', { hasText: 'Том первый справа' })).toBeVisible();
    await expect(pane(touchPage, 1).locator('.row .text', { hasText: 'Том второй слева' })).toBeVisible();
    await expect(touchPage.locator('[contenteditable]')).toHaveCount(1);
    await touchPage.screenshot({ path: '/tmp/listik-split-touch.png' });
  } finally { await context.close(); }
});


test('browser back and forward change only the active slice', async ({ page }) => {
  await openSplit(page);
  const right = pane(page, 1);
  await right.locator('.row').first().locator('.bullet').click();
  await expect(right.locator('.zoom-title')).toHaveText('Том первый');
  await right.locator('.row', { hasText: /^Часть вторая$/ }).locator('.bullet').click();
  await expect(right.locator('.zoom-title')).toHaveText('Часть вторая');
  await page.goBack();
  await expect(right.locator('.zoom-title')).toHaveText('Том первый');
  await expect(pane(page, 0).locator('.document-home-title')).toHaveText('Главная');
  await page.goForward();
  await expect(right.locator('.zoom-title')).toHaveText('Часть вторая');
  await expect(pane(page, 0).locator('.document-home-title')).toHaveText('Главная');
});
