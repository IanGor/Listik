import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 834, height: 1194 }, screen: { width: 834, height: 1194 }, isMobile: true, hasTouch: true });

test('iPad text scale: every tap updates the percentage, text size and saved setting together', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?demo');
  await expect(page.locator('html')).toHaveClass(/tablet/);
  const menu = page.getByRole('button', { name: 'Меню документа' });
  await menu.tap();
  const group = page.getByRole('group', { name: 'Размер текста' });
  const value = group.locator('.step-value');
  const smaller = group.getByRole('button', { name: 'Мельче' });
  const larger = group.getByRole('button', { name: 'Крупнее' });
  const fontSize = () => page.locator('.row .text').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const base = await fontSize();
  await expect(value).toHaveText('100%');
  // Keep the readout correct if its text nodes are normalized or replaced.
  let current = 100;
  for (const percent of [...Array.from({ length: 10 }, (_, i) => 95 - 5 * i), ...Array.from({ length: 20 }, (_, i) => 55 + 5 * i)]) {
    await value.evaluate(el => { el.normalize(); el.textContent = el.textContent; });
    await (percent < current ? smaller : larger).tap();
    await expect(value).toHaveText(`${percent}%`);
    expect(await fontSize()).toBeCloseTo(base * percent / 100, 2);
    expect(await page.evaluate(() => Number(document.documentElement.style.getPropertyValue('--font-scale')))).toBe(percent / 100);
    expect(await page.evaluate(() => Number(localStorage.getItem('listik-text-scale') ?? 1))).toBe(percent / 100);
    current = percent;
    if (percent === 50) await expect(smaller).toBeDisabled();
  }
  await expect(larger).toBeDisabled();
  await page.setViewportSize({ width: 1194, height: 834 });
  await smaller.tap();
  await expect(value).toHaveText('145%');
  await menu.tap();
  await menu.tap();
  await expect(value).toHaveText('145%');
  await page.reload();
  await menu.tap();
  await expect(value).toHaveText('145%');
  expect(await fontSize()).toBeCloseTo(base * 1.45, 2);
  expect(errors).toEqual([]);
});
