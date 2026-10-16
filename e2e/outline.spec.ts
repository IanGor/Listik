import { expect, test, type Page } from '@playwright/test';

/** Rendered rows in the `build` format of the unit tests: 2 spaces per level. */
const outline = (page: Page) =>
  page.locator('.row').evaluateAll((rows) =>
    rows.map((r) => '  '.repeat(Number((r as HTMLElement).dataset.depth)) + r.querySelector('.text')!.textContent),
  );

const editing = (page: Page) => page.locator('.text[contenteditable]');

/** Click a row's text and put the caret at its end. */
async function edit(page: Page, text: string) {
  await page.locator('.row .text', { hasText: text }).first().click();
  await expect(editing(page)).toBeFocused();
  await page.keyboard.press('End');
}

const DEMO = [
  'Том первый',
  '  Часть первая',
  '    — Eh bien, mon prince. Gênes et Lucques ne sont plus que des apanages… #салон',
  '    Так говорила в июле 1805 года известная Анна Павловна Шерер #шерер',
  '  Часть вторая',
  'Том второй',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.locator('.row')).toHaveCount(DEMO.length);
});

test('renders the demo outline', async ({ page }) => {
  expect(await outline(page)).toEqual(DEMO);
});

test('typing edits the bullet and only that bullet becomes editable', async ({ page }) => {
  await edit(page, 'Том второй');
  await page.keyboard.type(' — конец');
  await expect(editing(page)).toHaveText('Том второй — конец');
  await expect(editing(page)).toHaveCount(1);
  // Leaving the row renders it as static text with the new content.
  await page.keyboard.press('Escape');
  await expect(editing(page)).toHaveCount(0);
  expect((await outline(page)).at(-1)).toBe('Том второй — конец');
});

test('Enter, Tab and Shift+Tab build structure', async ({ page }) => {
  await edit(page, 'Том второй');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Часть первая тома 2');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.type('глава');
  await page.keyboard.press('Tab');
  expect((await outline(page)).slice(-3)).toEqual(['Том второй', '  Часть первая тома 2', '    глава']);
  await page.keyboard.press('Shift+Tab');
  expect((await outline(page)).slice(-3)).toEqual(['Том второй', '  Часть первая тома 2', '  глава']);
  await expect(editing(page)).toHaveText('глава');
  await expect(editing(page)).toBeFocused();
});

test('Enter in the middle splits the text', async ({ page }) => {
  await edit(page, 'Том второй');
  for (let i = 0; i < 'второй'.length; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  expect((await outline(page)).slice(-2)).toEqual(['Том ', 'второй']);
  await expect(editing(page)).toHaveText('второй');
});

test('Backspace at the start merges into the previous row', async ({ page }) => {
  await edit(page, 'Том второй');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  expect((await outline(page)).slice(-1)).toEqual(['  Часть втораяТом второй']);
  // The caret sits at the junction: typing goes between the two texts.
  await page.keyboard.type('|');
  await expect(editing(page)).toHaveText('Часть вторая|Том второй');
});

test('arrow keys move between rows', async ({ page }) => {
  await edit(page, 'Часть вторая');
  await page.keyboard.press('ArrowDown');
  await expect(editing(page)).toHaveText('Том второй');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(editing(page)).toHaveText(/Анна Павловна/);
});

test('Alt+Shift+arrows move a bullet with its subtree', async ({ page }) => {
  await edit(page, 'Часть вторая');
  await page.keyboard.press('Alt+Shift+ArrowUp');
  expect(await outline(page)).toEqual([DEMO[0], DEMO[4], DEMO[1], DEMO[2], DEMO[3], DEMO[5]]);
  await expect(editing(page)).toBeFocused();
  await page.keyboard.press('Alt+Shift+ArrowDown');
  expect(await outline(page)).toEqual(DEMO);
});

test('Ctrl+ArrowUp collapses and the bullet gets a halo', async ({ page }) => {
  await edit(page, 'Часть первая');
  await page.keyboard.press('Control+ArrowUp');
  expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[4], DEMO[5]]);
  await expect(page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet')).toHaveClass(/collapsed/);
  await page.keyboard.press('Control+ArrowDown');
  expect(await outline(page)).toEqual(DEMO);
});

test('clicking a bullet toggles its children', async ({ page }) => {
  const bullet = page.locator('.row', { hasText: 'Том первый' }).locator('.bullet');
  await bullet.click();
  expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
  await bullet.click();
  expect(await outline(page)).toEqual(DEMO);
});

test('pasting several lines creates bullets', async ({ page }) => {
  await edit(page, 'Том второй');
  await page.keyboard.press('Enter');
  await editing(page).evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'один\nдва\nтри\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect((await outline(page)).slice(-4)).toEqual(['Том второй', 'один', 'два', 'три']);
  await expect(editing(page)).toHaveText('три');
});

test('Ctrl+Z undoes a typed word and a structural change; Ctrl+Shift+Z redoes', async ({ page }) => {
  await edit(page, 'Том второй');
  await page.keyboard.type(' конец');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect((await outline(page)).slice(-2)).toEqual(['Том второй конец', '  ']);

  await page.keyboard.press('Control+z'); // Tab
  await page.keyboard.press('Control+z'); // Enter
  expect((await outline(page)).slice(-1)).toEqual(['Том второй конец']);
  await page.keyboard.press('Control+z'); // "конец"
  await page.keyboard.press('Control+z'); // " "
  expect(await outline(page)).toEqual(DEMO);
  // The caret is back where typing started.
  await page.keyboard.type('!');
  await expect(editing(page)).toHaveText('Том второй!');

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(editing(page)).toHaveText('Том второй!');
});

test('undo works in any keyboard layout and without an editing row', async ({ page }) => {
  await page.locator('.row', { hasText: 'Том первый' }).locator('.bullet').click();
  expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
  // Physical Z key; with a Russian layout the character would be "я".
  await page.keyboard.press('Control+KeyZ');
  expect(await outline(page)).toEqual(DEMO);
});

test.describe('persistence', () => {
  test('edits survive a reload', async ({ page }) => {
    await page.goto('/?db=e2e');
    await expect(page.locator('.row')).toHaveCount(1);
    await page.locator('.row .text').click();
    await page.keyboard.type('Запись');
    await page.keyboard.press('Enter');
    await page.keyboard.type('вложенная');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.keyboard.type('ещё одна');
    await page.locator('.row', { hasText: 'Запись' }).locator('.bullet').click();
    await page.locator('.row', { hasText: 'Запись' }).locator('.bullet').click();
    // Writes are batched for 300 ms.
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(3);
    expect(await outline(page)).toEqual(['Запись', '  вложенная', '  ещё одна']);
  });

  test('demo and sample documents never touch stored data', async ({ page }) => {
    await page.goto('/?demo&db=e2e');
    await edit(page, 'Том второй');
    await page.keyboard.type(' изменён');
    await page.waitForTimeout(500);
    await page.goto('/?db=e2e');
    expect(await outline(page)).toEqual(['']);
  });
});

test.describe('at scale', () => {
  test('200k bullets: only a window is rendered, the end is reachable, editing stays fast', async ({ page }) => {
    await page.goto('/?sample=200000');
    await expect(page.locator('.row').first()).toHaveText(/Глава 1/);
    const rendered = await page.locator('.row').count();
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(200);

    // Jump to the very bottom: rows must render there, the last one fully in view.
    await page.locator('.scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.row').last()).toBeInViewport({ ratio: 1 });
    expect(await page.locator('.row').count()).toBeGreaterThan(10);

    // Typing into a row at the bottom of a 200k outline.
    const last = page.locator('.row .text').last();
    await last.click();
    await page.keyboard.press('End');
    const started = Date.now();
    await page.keyboard.type('abcdefghij');
    await page.keyboard.press('Enter');
    await page.keyboard.type('новый');
    await expect(editing(page)).toHaveText('новый');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
