import { expect, test } from '@playwright/test';

test.describe('adaptive workspace', () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?demo');
    await expect(page.locator('.row')).toHaveCount(6);
  });

  test('phone navigation contains the same tree, favorites and search', async ({ page }) => {
    const hamburger = page.getByRole('button', { name: 'Открыть навигацию', exact: true });
    const sidebar = page.locator('.navigation-sidebar');
    await expect(sidebar).toBeHidden();
    await page.screenshot({ path: '/tmp/listik-responsive-phone.png' });
    await hamburger.click();
    await page.screenshot({ path: '/tmp/listik-responsive-navigation.png' });
    await sidebar.getByRole('treeitem', { name: 'Том первый', exact: true }).click();
    await expect(sidebar).toBeHidden();
    await expect(page.locator('.crumb.current')).toHaveText('Том первый');
    await page.getByRole('button', { name: 'Добавить ноду в избранное' }).click();
    await hamburger.click();
    await expect(sidebar.getByRole('list', { name: 'Избранное', exact: true })).toBeVisible();
    await sidebar.locator('input.search').fill('#салон');
    await sidebar.locator('.searchbar .star').click();
    await expect(sidebar.getByRole('list', { name: 'Избранное', exact: true })).toContainText('#салон');
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(hamburger).toBeFocused();
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await page.getByRole('menuitem', { name: 'Поиск', exact: true }).click();
    await expect(sidebar.locator('input.search')).toBeFocused();
  });

  test('the editor and query survive resize without replacement', async ({ page }) => {
    await page.locator('.row .text').last().click();
    const editor = page.locator('.text[contenteditable]');
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await editor.evaluate((el) => el.setAttribute('data-same-editor', 'yes'));
    for (const width of [820, 1194, 767, 320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(editor).toHaveAttribute('data-same-editor', 'yes');
      await expect(editor).toContainText('edited');
      await expect(page.getByRole('toolbar', { name: 'Правка пункта' })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Открыть навигацию', exact: true }).click();
    await page.locator('input.search').fill('#салон');
    for (const width of [820, 1194, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator('input.search')).toHaveValue('#салон');
    }
  });

  test('row and block actions are available by ordinary buttons', async ({ page }) => {
    const row = page.locator('.row').last();
    await row.getByRole('button', { name: 'Действия с пунктом' }).click();
    await page.getByRole('menuitem', { name: 'Выделить пункты' }).click();
    const toolbar = page.getByRole('toolbar', { name: 'Выделенные пункты' });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Выделить всё', exact: true }).click();
    await expect(page.locator('.row.selected')).toHaveCount(6);
    await toolbar.getByRole('button', { name: 'Готово', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(toolbar.getByRole('button', { name: 'Выделить всё', exact: true })).toBeFocused();
    await toolbar.getByRole('button', { name: 'Готово', exact: true }).focus();
    await page.keyboard.press('Enter');
    await row.getByRole('button', { name: 'Действия с пунктом' }).click();
    await page.getByRole('menuitem', { name: 'Сделать задачей', exact: true }).click();
    await expect(row.getByRole('checkbox')).toBeVisible();
    await row.getByRole('button', { name: 'Действия с пунктом' }).click();
    await page.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
    await expect(page.locator('.row')).toHaveCount(5);
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(page.locator('.row')).toHaveCount(6);
  });

  test('toolbar buttons and navigation fit all width boundaries', async ({ page }) => {
    for (const width of [320, 375, 390, 430, 640, 767, 768, 820, 834, 1024, 1194, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `page overflow at ${width}`).toBeLessThanOrEqual(1);
      await expect(page.locator('.navigation-hamburger')).toHaveCount(width < 768 ? 1 : 0);
      await expect(page.locator('.navigation-sidebar')).toHaveClass(width < 1024 ? /overlay/ : /^(?!.*overlay)/);
      const buttons = page.locator('.crumbbar > button, .crumbbar .menu-button');
      for (const button of await buttons.all()) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      }
    }
  });

  test('sketch and trash are usable workspaces with a clear return', async ({ page }) => {
    await page.getByRole('button', { name: 'Открыть навигацию', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Том первый', exact: true }).click();
    await page.getByRole('button', { name: 'Скетч', exact: true }).click();
    const sketch = page.locator('.sketch');
    await expect(sketch).toBeVisible();
    expect((await sketch.boundingBox())!.height).toBeGreaterThan(500);
    await page.getByRole('button', { name: 'Рисовать пальцем', exact: true }).click();
    const cdp = await page.context().newCDPSession(page);
    const sheet = (await sketch.locator('.sketch-sheet').boundingBox())!;
    const x = sheet.x + 30, y = sheet.y + 80;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 60, y: y + 30 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sketch.locator('g.pen path')).toHaveCount(1);
    await cdp.detach();
    await page.getByRole('button', { name: 'Закрыть скетч', exact: true }).click();
    await expect(sketch).toHaveCount(0);
    await page.locator('.row').last().getByRole('button', { name: 'Действия с пунктом' }).click();
    await page.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await page.getByRole('menuitem', { name: /Корзина/ }).click();
    await expect(page.locator('.trash')).toBeVisible();
    expect((await page.locator('.trash').boundingBox())!.height).toBeGreaterThan(500);
    await page.locator('.trash-close').click();
    await expect(page.locator('.trash')).toHaveCount(0);
  });

  test('appearance and touch targets survive trackpad capability and large text', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1194 });
    await expect(page.locator('html')).toHaveClass(/tablet/);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '1.5'));
    await page.screenshot({ path: '/tmp/listik-responsive-ipad-dark.png' });
    await page.setViewportSize({ width: 320, height: 600 });
    await page.screenshot({ path: '/tmp/listik-responsive-small-large-text.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.locator('.navigation-hamburger').click();
    await expect(page.getByRole('tree')).toBeVisible();
  });

  test('navigation and commands remain reachable in a short landscape window', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 190 });
    await page.locator('.navigation-hamburger').click();
    await page.locator('input.search').fill('Том');
    await expect(page.locator('input.search')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.locator('.row-actions').first().click();
    const menu = page.locator('.row-menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(190);
    await menu.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Удалено');
  });

  test('semantic text colors retain contrast in both themes', async ({ page }) => {
    await page.locator('.row .text').last().click();
    await page.locator('.text[contenteditable]').fill('**Жирный** *Курсив* #тег [[Ссылка]]');
    await page.keyboard.press('Escape');
    await expect(page.locator('.md-bold')).toHaveCSS('font-weight', '700');
    await expect(page.locator('.md-italic')).toHaveCSS('font-style', 'italic');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const scores = await page.evaluate(() => {
        const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
        const luminance = (values: number[]) => values.slice(0, 3).map((n) => {
          const v = n / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const probe = document.createElement('span');
        document.body.append(probe);
        const results = ['text', 'muted', 'faint', 'primary', 'link', 'bold', 'italic', 'tag', 'danger'].map((token) => {
          probe.style.color = `var(--${token})`;
          probe.style.backgroundColor = 'var(--canvas)';
          const style = getComputedStyle(probe);
          const a = luminance(rgb(style.color)), b = luminance(rgb(style.backgroundColor));
          return { token, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
        probe.remove();
        return results;
      });
      for (const { token, ratio } of scores) expect(ratio, `${theme} ${token}`).toBeGreaterThanOrEqual(4.5);
      const inks = await page.locator('.md-bold, .md-italic, .row .text').evaluateAll((els) => new Set(els.map((el) => getComputedStyle(el).color)).size);
      expect(inks).toBeGreaterThanOrEqual(3);
      await page.screenshot({ path: `/tmp/listik-responsive-colors-${theme}.png` });
    }
  });
});
