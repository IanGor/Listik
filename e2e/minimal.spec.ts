import { expect, test } from '@playwright/test';

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
