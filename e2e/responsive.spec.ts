import { readFile } from 'node:fs/promises';
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
      await expect(page.getByRole('toolbar', { name: 'Правка пункта' })).toBeHidden();
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
        expect(box!.width).toBeGreaterThanOrEqual(40);
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

test.describe('compact pinned heading', () => {
  test.use({ hasTouch: true });

  test('a long Shift+Enter description scrolls independently of the title at every layout', async ({ page }) => {
    await page.goto('/?demo');
    await page.locator('.row').last().locator('.bullet').click();
    const title = page.locator('.zoom-title');
    await title.click();
    await page.keyboard.press('Shift+Enter');
    const note = page.locator('.zoom-note');
    const description = Array.from({ length: 60 }, (_, i) => `Описание ${i + 1}: контекст встречи, вопросы и следующие шаги.`).join('\n');
    await note.fill(description);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    for (const width of [1440, 834, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const scroller = page.locator('.scroller');
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await expect(page.locator('.document-header .zoom-title')).toHaveCount(1);
      await expect(page.locator('.document-header .zoom-note')).toHaveCount(0);
      const position = (await title.boundingBox())!;
      const descriptionPosition = (await note.boundingBox())!;
      await scroller.evaluate((el) => { el.scrollTop = 600; });
      await expect.poll(async () => (await title.boundingBox())!.y).toBe(position.y);
      expect((await title.boundingBox())!.height).toBe(position.height);
      expect((await note.boundingBox())!.y).toBeLessThan(descriptionPosition.y - 500);
      await expect(note).toHaveText(description, { useInnerText: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.locator('.scroller').evaluate((el) => { el.scrollTop = 0; });
    await title.click();
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.zoom-note[contenteditable]')).toBeFocused();
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.zoom-title[contenteditable]')).toBeFocused();
  });

  test('calendar arrows share a row and the navigation symbol matches the sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/?demo');
    await page.locator('.navigation-hamburger').click();
    const symbol = await page.locator('.navigation-hamburger svg').innerHTML();
    expect(await page.locator('.navigation-toggle svg').innerHTML()).toBe(symbol);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Меню документа', exact: true }).click();
    await page.getByRole('menuitem', { name: /Создать структуру/ }).click();
    await page.locator('.navigation-hamburger').click();
    await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
    const previous = page.getByRole('button', { name: 'Предыдущий день', exact: true });
    const next = page.getByRole('button', { name: 'Следующий день', exact: true });
    const a = (await previous.boundingBox())!, b = (await next.boundingBox())!;
    expect(a.y).toBe(b.y);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    expect(b.x + b.width).toBeLessThanOrEqual(320);
    const date = await page.locator('.zoom-date').innerText();
    await next.click();
    await expect(page.locator('.zoom-date')).not.toHaveText(date);
  });

  test('iPad window controls never create a vertical blank band, even with sketch open', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 881 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
      Object.defineProperty(navigator, 'standalone', { value: true });
      Object.defineProperty(screen, 'width', { value: 1376 });
      Object.defineProperty(screen, 'height', { value: 1032 });
    });
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveCSS('--controls-left', '76px');
    expect((await page.locator('.navigation-sidebar').boundingBox())!.y).toBeLessThanOrEqual(16);
    expect((await page.locator('.navigation-sidebar').boundingBox())!.x).toBe(8);
    expect((await page.locator('.main').boundingBox())!.y).toBeLessThanOrEqual(16);
    await page.locator('.row').last().locator('.bullet').click();
    await page.locator('.sketch-toggle').click();
    expect((await page.locator('.sketch').boundingBox())!.y).toBeLessThanOrEqual(16);
    expect((await page.locator('.main').boundingBox())!.y).toBeLessThanOrEqual(16);
  });

  test('headings share the path leading edge on every layout and stay opaque', async ({ page }) => {
    for (const width of [320, 390, 834, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?demo');
      const header = page.locator('.document-header');
      const check = async () => {
        const title = page.locator('.zoom-title, .document-home-title');
        const path = page.locator('.crumbs');
        const leading = await path.evaluate((el) => {
          const css = getComputedStyle(el);
          return el.getBoundingClientRect().x + parseFloat(css.paddingLeft);
        });
        expect((await title.boundingBox())!.x).toBeCloseTo(leading, 0);
        await expect(header).toHaveCSS('position', 'sticky');
        await expect(header).toHaveCSS('top', '0px');
        await expect(header).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(page.locator('.document-header .crumbbar')).toHaveCSS('backdrop-filter', 'none');
        const button = page.getByRole('button', { name: 'Открыть навигацию', exact: true });
        if (width < 768) {
          expect((await button.boundingBox())!.x + (await button.boundingBox())!.width)
            .toBeLessThanOrEqual((await title.boundingBox())!.x);
        }
      };
      await check();
      await page.locator('.row').last().locator('.bullet').click();
      await check();
      if (width >= 768) {
        await page.locator('.navigation-toggle').click();
        await check();
        await page.locator('.sketch-toggle').click();
        await check();
      }
      await page.screenshot({ path: `/tmp/listik-aligned-header-${width}.png` });
    }
  });

  test('touch rows stay compact without overlapping their action buttons', async ({ page }) => {
    for (const width of [390, 834, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?demo');
      const rows = page.locator('.row');
      const first = (await rows.first().boundingBox())!;
      expect(first.height).toBeGreaterThanOrEqual(29);
      expect(first.height).toBeLessThanOrEqual(32);
      for (let i = 1; i < await rows.count(); i++) {
        const above = (await rows.nth(i - 1).getByRole('button', { name: 'Действия с пунктом' }).boundingBox())!;
        const below = (await rows.nth(i).getByRole('button', { name: 'Действия с пунктом' }).boundingBox())!;
        expect(above.y + above.height).toBeLessThanOrEqual(below.y + 0.5);
      }
    }
  });

  test('long names clamp for reading and reveal their full editable text', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?demo');
    await page.locator('.row').last().locator('.bullet').click();
    const name = 'Очень длинное название ноды '.repeat(15);
    await page.locator('.zoom-title').click();
    await page.locator('.zoom-title[contenteditable]').fill(name);
    await page.keyboard.press('Escape');
    const title = page.locator('.zoom-title');
    const geometry = await title.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(geometry.height).toBeLessThanOrEqual(geometry.line * 2 + 1);
    await title.click();
    await expect(page.locator('.zoom-title[contenteditable]')).toHaveText(name.trim());
  });

  test('captures the agreed compact compositions and their visual comparisons', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('listik-navigation-open', 'true'));
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.goto('/?db=e2e-heading-visual&empty');
    await page.locator('.row .text').first().click();
    await page.locator('.text[contenteditable]').evaluate((el) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Inbox\n  Техсессия\n    *timeline*\n      @d11 @m11 @y26 @среда\n        *todo*\n        *flow*\n      **Вопросы**\n        Уточнить сценарии работы\n        Проверить поведение на iPad\n      **Решения**\n        Закрепить название ноды\n        Убрать пустую полосу\n        Уплотнить строки списка\n      **Следующие шаги**\n        Подготовить прототип\n        Согласовать критерии\n      **Материалы**\n        Ссылка на макет\n        Пример с iPad\n        Заметки из обсуждения');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await page.keyboard.press('Escape');
    await page.locator('.row', { has: page.locator('.text', { hasText: 'timeline' }) }).locator('.bullet').click();
    await page.locator('.zoom-title').click();
    await page.keyboard.press('Shift+Enter');
    await page.locator('.zoom-note[contenteditable]').fill('Заметки и вопросы к обсуждению.');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const frames = [
      { device: 'desktop', width: 1440, height: 1024, source: 'exec-ced28d5d-b5a5-4cf7-ab08-5af2dadef5e0.png' },
      { device: 'tablet', width: 1280, height: 881, source: 'exec-500f777f-cdfc-463e-b8d2-fc22bbf05876.png' },
      { device: 'phone', width: 390, height: 844, source: 'exec-42246c50-11ad-4ecb-91b7-7505d69f8953.png' },
    ];
    for (const frame of frames) {
      await page.setViewportSize({ width: frame.width, height: frame.height });
      if (frame.device === 'tablet') await page.locator('.sketch-toggle').click();
      if (frame.device === 'phone') await page.locator('.sketch-close').click();
      await expect(page.locator('.zoom-title')).toBeVisible();
      await expect(page.locator('.zoom-note')).toHaveText('Заметки и вопросы к обсуждению.');
      const actual = `/tmp/listik-heading-${frame.device}.png`;
      await page.screenshot({ path: actual });
      const source = '/home/ig/.codex/generated_images/01a1c908-7024-74b1-bb9f-7828415cff35/' + frame.source;
      // Local design references are optional; CI still captures the app.
      const a = await readFile(source).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!a) continue;
      const b = await readFile(actual);
      const comparison = await page.context().newPage();
      await comparison.setViewportSize({ width: frame.width * 2, height: frame.height });
      await comparison.setContent(`<style>body{margin:0;display:flex}img{width:${frame.width}px;height:${frame.height}px;object-fit:fill}</style><img src="data:image/png;base64,${a.toString('base64')}"/><img src="data:image/png;base64,${b.toString('base64')}"/>`);
      await comparison.locator('img').evaluateAll(async (imgs) => { await Promise.all(imgs.map((img) => (img as HTMLImageElement).decode())); });
      await comparison.screenshot({ path: `/tmp/listik-heading-compare-${frame.device}.png` });
      await comparison.close();
    }
  });
});


test('desktop and touch share compact navigation, backlinks, menu and search metrics', async ({ browser, baseURL }) => {
  for (const hasTouch of [false, true]) {
    const context = await browser.newContext({ baseURL, hasTouch, viewport: { width: 834, height: 1000 } });
    const page = await context.newPage();
    try {
      await page.goto('/?demo');
      await page.locator('.row .text').last().click();
      await page.keyboard.press('End');
      await page.keyboard.type(' [[Том первый]]');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('.row').last().locator('.link').click();
      const backlinks = page.getByRole('navigation', { name: 'Ссылки сюда' });
      await expect(backlinks.getByRole('button').first()).toBeVisible();
      await expect(page.locator('.row .text').first()).toHaveCSS('font-size', '17px');
      expect((await backlinks.getByRole('button').first().boundingBox())!.height).toBe(28);
      await page.getByRole('button', { name: 'Добавить ноду в избранное' }).click();
      for (const width of [390, 834, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width < 768) {
          await page.getByRole('button', { name: 'Открыть навигацию', exact: true }).click();
        } else if (await page.locator('.navigation-toggle').getAttribute('aria-expanded') === 'false') {
          await page.locator('.navigation-toggle').click();
        }
        const sidebar = page.locator('.navigation-sidebar');
        await expect(sidebar.getByRole('tree')).toBeVisible();
        expect((await sidebar.getByRole('treeitem').first().boundingBox())!.height).toBe(34);
        expect((await sidebar.locator('.favorite-entry').first().boundingBox())!.height).toBe(42);
        expect((await sidebar.locator('.searchbar').boundingBox())!.height).toBe(44);
        await page.screenshot({ path: `/tmp/listik-density-${hasTouch ? 'touch' : 'desktop'}-${width}-navigation.png` });
        await sidebar.locator('input.search').fill('#салон');
        for (const selector of ['.star', '.clear']) {
          const box = (await sidebar.locator('.searchbar ' + selector).boundingBox())!;
          expect(box.width).toBe(32); expect(box.height).toBe(32);
        }
        await sidebar.locator('.searchbar .clear').click();
        await page.locator('.navigation-toggle').click();
        await page.getByRole('button', { name: 'Меню документа' }).click();
        const menuHeight = (await page.getByRole('menuitem', { name: 'Поиск', exact: true }).boundingBox())!.height;
        expect(menuHeight).toBeGreaterThanOrEqual(38);
        expect(menuHeight).toBeLessThan(40);
        await page.screenshot({ path: `/tmp/listik-density-${hasTouch ? 'touch' : 'desktop'}-${width}-menu.png` });
        await page.keyboard.press('Escape');
        await page.screenshot({ path: `/tmp/listik-density-${hasTouch ? 'touch' : 'desktop'}-${width}-document.png` });
      }
      await backlinks.getByRole('button').first().click();
      await expect(page.locator('.text[contenteditable]')).toContainText('[[Том первый]]');
      await page.keyboard.press('End');
      await page.keyboard.type(' #с');
      await expect(page.locator('.suggest-item').first()).toBeVisible();
      expect((await page.locator('.suggest-item').first().boundingBox())!.height).toBe(32);
    } finally { await context.close(); }
  }
});
