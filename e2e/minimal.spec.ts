import { expect, test, type Page } from '@playwright/test';

const menu = 'Меню документа';
const legacy = 'Вернуться к прежнему интерфейсу';
const minimal = 'Открыть новый интерфейс';

test('default view, empty branch, keyboard and view preference round trip', async ({ page }) => {
  await page.goto('/?db=e2e-minimal&empty');
  const rows = page.locator('.row');
  const editor = page.locator('.row .text[contenteditable]');
  const home = page.getByRole('button', { name: /Главная|На главную/i });
  const openMenu = () => page.getByRole('button', { name: menu }).first().click();
  await expect(home).toBeVisible();
  await expect(home.locator('svg')).toBeVisible();
  await expect(page.locator('.navigation-sidebar, .workspace-heading, .add')).toHaveCount(0);

  await rows.first().locator('.text').click();
  await editor.fill('Ветка');
  await rows.first().locator('.bullet').click();
  await expect(page.locator('.crumb.current')).toHaveText('Ветка');
  await expect(rows).toHaveCount(0);
  await page.locator('.scroller').focus();
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await editor.fill('Первый пункт');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.goto-input')).toHaveCount(0);
  await rows.first().locator('.text').click({ button: 'right' });
  await expect(page.locator('.row-menu')).toHaveCount(0);

  await openMenu();
  await expect(page.getByRole('menuitem')).toHaveText([legacy]);
  await page.getByRole('menuitem', { name: legacy }).click();
  await expect(page.locator('.navigation-sidebar')).toHaveCount(1);
  await expect(page.locator('.crumb.current')).toHaveText('Ветка');
  await expect(rows.first()).toContainText('Первый пункт');
  await page.reload();
  await expect(page.locator('.navigation-sidebar')).toHaveCount(1);
  await openMenu();
  await page.getByRole('menuitem', { name: minimal }).click();
  await page.reload();
  await expect(page.locator('.navigation-sidebar')).toHaveCount(0);
  await expect(page.locator('.crumb.current')).toHaveText('Ветка');
  await expect(rows.first()).toContainText('Первый пункт');
  await home.click();
  await expect(rows.first()).toContainText('Ветка');
  await rows.first().getByRole('button', { name: 'Свернуть пункт' }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: 'Развернуть пункт' }).click();
  await expect(rows).toHaveCount(2);
});

test('iPad window controls leave Home accessible after resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1376, height: 1032 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    Object.defineProperty(navigator, 'standalone', { value: true });
    Object.defineProperty(screen, 'width', { value: 1376 });
    Object.defineProperty(screen, 'height', { value: 1032 });
  });
  await page.goto('/?demo');
  const home = page.getByRole('button', { name: 'Главная', exact: true });
  const fullScreen = (await home.boundingBox())!;

  await page.setViewportSize({ width: 600, height: 800 });
  await expect.poll(async () => (await home.boundingBox())?.x).toBeGreaterThanOrEqual(76);
  const windowed = (await home.boundingBox())!;
  expect(windowed.y + windowed.height).toBeLessThanOrEqual(52);
  await page.getByRole('button', { name: 'Открыть пункт' }).first().click();
  await expect(home).not.toHaveAttribute('aria-current', 'page');
  await home.click();
  await expect(home).toHaveAttribute('aria-current', 'page');

  await page.setViewportSize({ width: 1376, height: 1032 });
  await expect.poll(() => home.boundingBox()).toEqual(fullScreen);
});

test('the current crumb uses the space available beside Home', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?db=minimal-current-crumb&empty');
  const row = page.locator('.row').first();
  const title = 'Подробное название ветки';
  await row.locator('.text').click();
  await row.locator('.text[contenteditable]').fill(title);
  await row.getByRole('button', { name: 'Открыть пункт' }).click();

  const crumb = page.locator('.crumb[aria-current="page"]');
  await expect(crumb).toHaveText(title);
  await expect.poll(() => crumb.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Главная', exact: true }).click();
  await expect(row).toContainText(title);
});

// Read the rendered gutter one pixel row at a time so a gap at a row boundary
// is detectable even when the styles on both sides look right in isolation.
async function gutterPixels(page: Page, x: number) {
  const png = await page.screenshot({ clip: { x, y: 0, width: 18, height: 300 } });
  return page.evaluate(async (data) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data: pixels } = context.getImageData(0, 0, image.width, image.height);
    const stride = image.width * 4;
    return Array.from({ length: image.height }, (_, y) => pixels.slice(y * stride, (y + 1) * stride).join());
  }, png.toString('base64'));
}

for (const touch of [false, true]) {
  test.describe(touch ? 'touch guides' : 'mouse guides', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: touch, isMobile: touch });

    test('an expanded branch keeps the start of its guide when its parent wraps', async ({ page }) => {
      await page.goto('/?db=minimal-wrapped-guide&empty');
      const rows = page.locator('.row');
      const editor = rows.locator('.text[contenteditable]');
      const parent = rows.first();
      const child = rows.nth(1);
      const parentText = parent.locator('.text');
      if (touch) await parentText.tap();
      else await parentText.click();
      await editor.press('Enter');
      await editor.fill('Дочерний пункт');
      await editor.press('Tab');
      await editor.press('End');
      await editor.press('Enter');
      await editor.press('Shift+Tab');
      await editor.press('Escape');
      await expect(rows.locator('.text')).toHaveText(['', 'Дочерний пункт', '']);
      await expect(child).toHaveAttribute('data-depth', '1');
      await expect(rows.last()).toHaveAttribute('data-depth', '0');

      const empty = (await parent.boundingBox())!;
      if (touch) expect(empty.height).toBe(30);
      const x = Math.floor(empty.x);
      const start = Math.round(empty.y + empty.height);
      const initial = await gutterPixels(page, x);
      const blank = initial[start - 2];
      const guide = initial[start + 4];
      expect(guide).not.toBe(blank);
      expect(initial[start - 1]).toBe(blank);
      expect(initial[start]).toBe(guide);

      if (touch) await parentText.tap();
      else await parentText.click();
      await editor.fill('Длинная строка с переносом '.repeat(5).trimEnd());
      const wrapped = (await parent.boundingBox())!;
      expect(wrapped.height).toBeGreaterThan(empty.height);
      const descendant = (await child.boundingBox())!;
      const end = Math.round(descendant.y + descendant.height);
      const expanded = await gutterPixels(page, x);
      expect(expanded[start - 1]).toBe(blank);
      expect(expanded.slice(start, end).findIndex((pixel) => pixel !== guide)).toBe(-1);
      expect(expanded[end + 2]).toBe(blank);

      const fold = parent.getByRole('button', { name: 'Свернуть пункт' });
      if (touch) await fold.tap();
      else await fold.click();
      await expect(rows).toHaveCount(2);
      const collapsed = await gutterPixels(page, x);
      expect(collapsed.slice(start, Math.round(wrapped.y + wrapped.height)).every((pixel) => pixel === blank)).toBe(true);
    });
  });
}

test.describe('touch', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  test('the bullet and its collapsed halo clear the first symbol on a phone', async ({ page }) => {
    await page.goto('/?db=e2e-mobile-bullet&empty');
    const row = page.locator('.row').first();
    await row.locator('.text').tap();
    const editor = page.locator('.row .text[contenteditable]');
    await editor.fill('📥 Inbox');
    await editor.press('End');
    await editor.press('Enter');
    await editor.fill('Вложенный пункт');
    await editor.press('Tab');

    const bullet = row.getByRole('button', { name: 'Открыть пункт' });
    const text = row.locator('.text');
    const expectGap = async (pseudo: '::before' | '::after') => {
      const bulletRight = await bullet.evaluate((element, part) => {
        const style = getComputedStyle(element, part);
        return element.getBoundingClientRect().left + parseFloat(style.left) + parseFloat(style.width) / 2;
      }, pseudo);
      expect((await text.boundingBox())!.x - bulletRight).toBeGreaterThanOrEqual(4);
    };

    await expectGap('::after');
    await row.getByRole('button', { name: 'Свернуть пункт' }).tap();
    await expect(bullet).toHaveClass(/collapsed/);
    await expectGap('::before');
  });

  test('a tap in an empty branch creates and focuses one row', async ({ page }) => {
    await page.goto('/?demo');
    await page.locator('.row .bullet').last().tap();
    await expect(page.locator('.row')).toHaveCount(0);
    await page.locator('.scroller').tap({ position: { x: 30, y: 80 } });
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('.row .text[contenteditable]')).toBeFocused();
    await expect(page.locator('.editbar, .row-menu, .navigation-sidebar')).toHaveCount(0);
  });
});
