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

test('minimal header keeps Home and breadcrumbs left and the menu right', async ({ page }) => {
  await page.goto('/?demo');
  const open = page.getByRole('button', { name: 'Открыть пункт' }).first();
  await open.click();
  await open.click();
  const breadcrumbs = page.getByRole('navigation', { name: 'Путь' });
  const path = breadcrumbs.getByRole('button');
  await expect(path).toHaveCount(3);
  const navToggle = page.getByRole('button', { name: /дерево навигации/i });
  const trigger = page.getByRole('button', { name: menu });

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const [toggleBox, navBox, current, box] = await Promise.all([
      navToggle.boundingBox(),
      breadcrumbs.boundingBox(),
      path.last().boundingBox(),
      trigger.boundingBox(),
    ]);
    expect(toggleBox!.x).toBeGreaterThanOrEqual(4);
    expect(navBox!.x).toBeGreaterThanOrEqual(toggleBox!.x + toggleBox!.width);
    expect(current!.x + current!.width).toBeLessThanOrEqual(box!.x + 1);
    expect(width - box!.x - box!.width).toBeGreaterThanOrEqual(4);
    expect(width - box!.x - box!.width).toBeLessThanOrEqual(16);
  }

  await page.setViewportSize({ width: 240, height: 640 });
  const scrollLeft = () => breadcrumbs.evaluate((el) => el.scrollLeft);
  await expect.poll(scrollLeft).toBeGreaterThan(0);
  const end = await scrollLeft();
  await breadcrumbs.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(scrollLeft).toBeLessThan(end);
});

test('minimal header menu rests as dots and keeps hover and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 18, right: 24 } });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?db=minimal-menu-header&empty');
  const home = page.getByRole('button', { name: 'Главная', exact: true });
  const trigger = page.getByRole('button', { name: menu });
  await expect(trigger.locator('svg circle')).toHaveCount(3);
  await expect(trigger).toHaveText('');
  await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(trigger).toHaveCSS('border-style', 'none');

  await home.hover();
  await expect(home).toHaveCSS('background-color', 'rgb(241, 237, 228)');
  await trigger.hover();
  await expect(trigger).toHaveCSS('background-color', 'rgb(241, 237, 228)');
  const radius = await home.evaluate((el) => getComputedStyle(el).borderRadius);
  await expect(trigger).toHaveCSS('border-radius', radius);
  const [homeBox, triggerBox] = await Promise.all([home.boundingBox(), trigger.boundingBox()]);
  expect(triggerBox!.width).toBe(homeBox!.width);
  expect(triggerBox!.height).toBe(homeBox!.height);

  const navToggle = page.getByRole('button', { name: /дерево навигации/i });
  await page.mouse.move(140, 160);
  await page.keyboard.press('Tab');
  await expect(navToggle).toBeFocused();
  await expect(navToggle).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(home).toBeFocused();
  await expect(home).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS('outline-style', 'solid');
  await expect(trigger).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Enter');
  const popup = page.getByRole('menu');
  await expect(popup.getByRole('menuitem', { name: legacy })).toBeFocused();
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(18);
  expect(box.x + box.width).toBeLessThanOrEqual(320 - 24);
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('iPad window controls leave Home accessible after resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1376, height: 1032 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 18, right: 24 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    Object.defineProperty(navigator, 'standalone', { value: true });
    Object.defineProperty(screen, 'width', { value: 1376 });
    Object.defineProperty(screen, 'height', { value: 1032 });
  });
  await page.goto('/?demo');
  const navToggle = page.getByRole('button', { name: /дерево навигации/i });
  const home = page.getByRole('button', { name: 'Главная', exact: true });
  const trigger = page.getByRole('button', { name: menu });
  const fullScreenToggle = (await navToggle.boundingBox())!;
  const fullScreen = (await home.boundingBox())!;
  expect(fullScreenToggle.x).toBeGreaterThanOrEqual(18 + 4);
  expect(fullScreenToggle.x).toBeLessThanOrEqual(18 + 16);

  await page.setViewportSize({ width: 600, height: 800 });
  await expect.poll(async () => (await home.boundingBox())?.x).toBeCloseTo(fullScreen.x + 76, 0);
  const windowed = (await home.boundingBox())!;
  expect(windowed.y + windowed.height).toBeLessThanOrEqual(52);
  const menuBox = (await trigger.boundingBox())!;
  expect(600 - menuBox.x - menuBox.width).toBeGreaterThanOrEqual(24 + 4);
  expect(600 - menuBox.x - menuBox.width).toBeLessThanOrEqual(24 + 16);
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

test('Swiss Editorial keeps quiet editing focus and isolates tokens from legacy', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?db=minimal-swiss-theme&empty');
  const row = page.locator('.row').first();
  await row.locator('.text').click();
  const editor = row.locator('.text[contenteditable]');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(editor).toHaveCSS('box-shadow', 'none');
  await expect(editor).toHaveCSS('border-bottom-style', 'none');
  const bulletColor = await row.locator('.bullet').evaluate((el) => getComputedStyle(el, '::after').backgroundColor);
  expect(bulletColor).toBe('rgb(29, 92, 76)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(25, 24, 22)');
  await expect.poll(() => row.locator('.bullet').evaluate((el) => getComputedStyle(el, '::after').backgroundColor)).toBe('rgb(88, 179, 152)');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: menu }).click();
  await page.getByRole('menuitem', { name: legacy }).click();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 249, 245)');
});
