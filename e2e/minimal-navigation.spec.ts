import { expect, test } from '@playwright/test';

test.describe('minimal navigation tree and editor level toggle', () => {
  test('shows only branches, keeps tree folds independent from editor, supports locate and collapse-all', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?demo');

    const nav = page.locator('.minimal-nav');
    const items = nav.locator('.minimal-nav-row');
    const locateBtn = nav.locator('[data-action="minimal.nav.locate"]');
    const collapseAllBtn = nav.locator('[data-action="minimal.nav.collapseAll"]');

    await expect(nav).toBeVisible();
    // Demo doc: "Том первый" (has child branch "Часть первая" + leaf "Часть вторая") and leaf "Том второй".
    // Only "Главная" and "Том первый" should be visible when collapsed.
    await expect(items.locator('.minimal-nav-label')).toHaveText(['Главная', 'Том первый']);
    await expect(locateBtn).toBeDisabled();
    await expect(collapseAllBtn).toBeDisabled();

    // Expand "Том первый" in tree — "Часть первая" (has leaf children) appears without chevron; "Часть вторая" (leaf) is omitted.
    await items.nth(1).locator('.minimal-nav-chev').click();
    await expect(items.locator('.minimal-nav-label')).toHaveText(['Главная', 'Том первый', 'Часть первая']);
    await expect(items.nth(2).locator('.minimal-nav-chev')).toHaveCount(0);
    await expect(collapseAllBtn).toBeEnabled();

    // Navigate to "Часть первая" via tree click.
    await items.nth(2).click();
    await expect(page.locator('.crumb.current')).toHaveText('Часть первая');
    await expect(items.nth(2)).toHaveClass(/active/);
    await expect(locateBtn).toBeEnabled();

    // Collapse all in tree — editor stays zoomed into "Часть первая" with its 2 rows intact.
    await collapseAllBtn.click();
    await expect(items.locator('.minimal-nav-label')).toHaveText(['Главная', 'Том первый']);
    await expect(page.locator('.crumb.current')).toHaveText('Часть первая');
    await expect(page.locator('.row')).toHaveCount(2);
    await expect(collapseAllBtn).toBeDisabled();

    // Locate current branch — expands path back to "Часть первая".
    await locateBtn.click();
    await expect(items.locator('.minimal-nav-label')).toHaveText(['Главная', 'Том первый', 'Часть первая']);
    await expect(items.nth(2)).toHaveClass(/active/);
    await expect(collapseAllBtn).toBeEnabled();

    // Hide and reopen tree via header toggle; preference persists across reload.
    const navToggle = page.locator('[data-action="minimal.nav.toggle"]');
    await navToggle.click();
    await expect(nav).toBeHidden();
    await page.reload();
    await expect(nav).toBeHidden();
    await navToggle.click();
    await expect(nav).toBeVisible();
  });

  test('editor level toggle folds and unfolds first level independently of tree', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?demo');

    const nav = page.locator('.minimal-nav');
    const levelToggle = page.locator('[data-action="ZoomHeader.3"]');
    const rows = page.locator('.row');

    // Expand tree branch first to verify editor level toggle does not touch tree folds.
    await nav.locator('.minimal-nav-chev').first().click();
    await expect(nav.locator('.minimal-nav-row')).toHaveCount(3);

    // Demo starts fully expanded: 6 visible rows.
    await expect(rows).toHaveCount(6);
    await expect(levelToggle).toBeEnabled();

    // Fold first level in editor.
    await levelToggle.click();
    await expect(rows).toHaveCount(2);
    // Tree stays expanded independently.
    await expect(nav.locator('.minimal-nav-row')).toHaveCount(3);

    // Unfold first level in editor.
    await levelToggle.click();
    await expect(rows).toHaveCount(6);
  });

  test('narrow screen starts closed, opens as overlay drawer and closes on navigation or Escape', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto('/?demo');

    const nav = page.locator('.minimal-nav');
    const navToggle = page.locator('[data-action="minimal.nav.toggle"]');

    await expect(nav).toBeHidden();
    await navToggle.click();
    await expect(nav).toBeVisible();
    await expect(nav).toHaveClass(/overlay/);

    // Escape closes overlay drawer.
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();

    // Opening and clicking a branch zooms and closes drawer.
    await navToggle.click();
    await expect(nav).toBeVisible();
    await nav.locator('.minimal-nav-row', { hasText: 'Том первый' }).click();
    await expect(page.locator('.crumb.current')).toHaveText('Том первый');
    await expect(nav).toBeHidden();
  });
});
