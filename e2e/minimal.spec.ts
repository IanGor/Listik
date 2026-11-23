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

test.describe('touch', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

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
