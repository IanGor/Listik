import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/** Rendered rows in the `build` format of the unit tests: 2 spaces per level. */
const outline = (page: Page) =>
  page.locator('.row').evaluateAll((rows) =>
    rows.map((r) => '  '.repeat(Number((r as HTMLElement).dataset.depth)) + r.querySelector('.text')!.textContent),
  );

const editing = (page: Page) => page.locator('.text[contenteditable]');

/** Click a row's text and put the caret at the end of its text (not of a wrapped line). */
async function edit(page: Page, text: string) {
  await page.locator('.row .text', { hasText: text }).first().click();
  await expect(editing(page)).toBeFocused();
  await page.keyboard.press('Control+End');
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

test('the fold arrow toggles children', async ({ page }) => {
  const bullet = page.locator('.row', { hasText: 'Том первый' }).locator('.toggle');
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
  await page.locator('.row', { hasText: 'Том первый' }).locator('.toggle').click();
  expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
  // Physical Z key; with a Russian layout the character would be "я".
  await page.keyboard.press('Control+KeyZ');
  expect(await outline(page)).toEqual(DEMO);
});

test.describe('tag filter', () => {
  test('a tag typed in the search box narrows with every character, as a word does', async ({ page }) => {
    const search = page.locator('.search');
    await search.click();
    await search.pressSequentially('#');
    await expect(page.locator('.searchbar .count')).toHaveText(/^2 /);
    await search.pressSequentially('с');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[2]]);
    await expect(page.locator('.tag.active')).toHaveText('#салон');
    await search.press('Backspace');
    await search.pressSequentially('ш');
    await expect.poll(() => outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[3]]);
    await search.pressSequentially('х');
    await expect(page.locator('.searchbar .count')).toHaveText(/^0 /);
  });

  test('clicking a tag shows only tagged bullets with their path; Esc clears', async ({ page }) => {
    await expect(page.locator('.tag')).toHaveText(['#салон', '#шерер']);
    await page.locator('.tag', { hasText: '#салон' }).click();
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[2]]);
    await expect(page.locator('.search')).toHaveValue('#салон');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    // "Часть первая" shows only the path: its other child is hidden, so its bullet is folded.
    await expect(page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet')).toHaveClass(/collapsed/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.searchbar .count')).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);
  });

  test('a folded path bullet opens within the filter without touching the document', async ({ page }) => {
    await page.locator('.tag', { hasText: '#салон' }).click();
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.toggle').click();
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[2], DEMO[3]]);
    await page.locator('.searchbar .clear').click();
    expect(await outline(page)).toEqual(DEMO);
  });

  test('editing under a filter: new bullets stay, Esc returns to the full outline while editing', async ({ page }) => {
    await page.locator('.tag', { hasText: '#шерер' }).click();
    await edit(page, 'Анна Павловна');
    await page.keyboard.press('Enter');
    await page.keyboard.type('новая мысль');
    expect((await outline(page)).slice(-2)).toEqual([DEMO[3], '    новая мысль']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.searchbar .count')).toHaveCount(0);
    await expect(editing(page)).toHaveText('новая мысль');
    expect(await outline(page)).toEqual([...DEMO.slice(0, 4), '    новая мысль', ...DEMO.slice(4)]);
  });
});

test.describe('search', () => {
  test('Ctrl+F, words in any case: matches with their path, hits highlighted', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await expect(page.locator('.search')).toBeFocused();
    await page.keyboard.type('ШЕРЕР анна');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[3]]);
    await expect(page.locator('.row mark')).toHaveText(['Анна', 'Шерер']);
    await expect(page.locator('.row .tag.hit')).toHaveText(['шерер']);
  });

  test('Enter edits the first match; Esc in the row returns to the full outline', async ({ page }) => {
    await page.locator('.search').fill('вторая');
    await page.keyboard.press('Enter');
    await expect(editing(page)).toHaveText('Часть вторая');
    await page.keyboard.type('!');
    await page.keyboard.press('Escape');
    await expect(page.locator('.search')).toHaveValue('');
    await expect(editing(page)).toHaveText('!Часть вторая');
    expect(await outline(page)).toHaveLength(DEMO.length);
  });

  test('exclusions and OR: "-word", "-#tag", "a OR b"', async ({ page }) => {
    await page.locator('.search').fill('часть -первая');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    expect(await outline(page)).toEqual([DEMO[0], DEMO[4]]);
    await page.locator('.search').fill('#салон OR #шерер');
    await expect(page.locator('.searchbar .count')).toHaveText('2 bullet’а');
    await page.locator('.search').fill('-#салон -#шерер том');
    await expect(page.locator('.searchbar .count')).toHaveText('2 bullet’а');
    // Excluded words are not highlighted.
    await page.locator('.search').fill('том -первый');
    await expect(page.locator('.row mark')).toHaveText(['Том']);
  });

  test('a clicked tag goes into the search box and combines with words', async ({ page }) => {
    await page.locator('.tag', { hasText: '#салон' }).click();
    await expect(page.locator('.search')).toHaveValue('#салон');
    await page.locator('.search').press('End');
    await page.locator('.search').pressSequentially(' prince');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    await page.locator('.search').pressSequentially(' нет-такого');
    await expect(page.locator('.searchbar .count')).toHaveText('0 bullet’ов');
    await expect(page.locator('.row')).toHaveCount(0);
    await page.locator('.search').press('Escape');
    await expect(page.locator('.search')).not.toBeFocused();
    expect(await outline(page)).toEqual(DEMO);
  });
});

test.describe('zoom', () => {
  const title = (page: Page) => page.locator('.zoom-title');
  const crumbs = (page: Page) => page.locator('.crumbs .crumb');

  test('clicking a bullet zooms in; breadcrumbs, back and forward zoom out and in', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await expect(title(page)).toHaveText('Часть первая');
    // The path from the root, the place itself included (not a link).
    await expect(crumbs(page)).toHaveText(['Главная', 'Том первый', 'Часть первая']);
    await expect(page.locator('.crumbs [aria-current="page"]')).toHaveText('Часть первая');
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
    expect(new URL(page.url()).hash).toMatch(/^#\/.+/);

    await page.goBack();
    await expect(title(page)).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);
    // Home: the path is the root alone.
    await expect(crumbs(page)).toHaveText(['Главная']);
    await page.goForward();
    await expect(title(page)).toHaveText('Часть первая');

    await crumbs(page).filter({ hasText: 'Том первый' }).click();
    await expect(title(page)).toHaveText('Том первый');
    await crumbs(page).filter({ hasText: 'Главная' }).click();
    expect(await outline(page)).toEqual(DEMO);
  });

  test('the title scrolls away with the list; the path stays, ending at the bullet', async ({ page }) => {
    await page.goto('/?sample=300');
    await expect(page.locator('.row').first()).toBeVisible();
    await page.locator('.row .bullet').first().click();
    await expect(title(page)).toBeVisible();
    const name = (await title(page).textContent())!;
    await expect(page.locator('.crumbs [aria-current="page"]')).toHaveText(name);
    const before = (await title(page).boundingBox())!.y;
    const path = (await page.locator('.crumbbar').boundingBox())!.y;
    const first = (await page.locator('.row').first().boundingBox())!;
    // The rows start under the title, not over it.
    expect(first.y).toBeGreaterThan(before + (await title(page).boundingBox())!.height);
    await page.locator('.scroller').evaluate((el) => (el.scrollTop = 200));
    await expect.poll(async () => (await title(page).boundingBox())!.y).toBeLessThan(before - 150);
    expect((await page.locator('.crumbbar').boundingBox())!.y).toBe(path);
    await expect(page.locator('.crumbs [aria-current="page"]')).toBeVisible();
  });

  test('a path wider than the screen scrolls instead of shortening crumbs, its end in view', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 });
    await page.locator('.row', { hasText: 'Eh bien' }).locator('.bullet').click();
    const nav = page.locator('.crumbs');
    await expect(crumbs(page)).toHaveCount(4);
    // Scrolled to the end: the parent shows whole, the start is out of view behind a faded edge.
    await expect(nav).toHaveClass(/clipped/);
    const box = (await nav.boundingBox())!;
    const parent = (await crumbs(page).filter({ hasText: 'Часть первая' }).boundingBox())!;
    expect(parent.x).toBeGreaterThanOrEqual(box.x);
    expect(parent.x + parent.width).toBeLessThanOrEqual(box.x + box.width);
    // No crumb above the current one is cut short.
    for (const c of await crumbs(page).filter({ hasNotText: 'Eh bien' }).all()) {
      expect(await c.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await nav.evaluate((el) => (el.scrollLeft = 0));
    await expect(nav).not.toHaveClass(/clipped/);
    await crumbs(page).filter({ hasText: 'Главная' }).click();
    await expect(title(page)).toHaveCount(0);
  });

  test('the title shows tags like a row: a click on one filters, a click elsewhere edits there', async ({ page }) => {
    await page.locator('.row', { hasText: 'Eh bien' }).locator('.bullet').click();
    await expect(title(page).locator('.tag')).toHaveText('#салон');
    await expect(title(page)).not.toHaveAttribute('contenteditable');
    // A click on the text puts the caret there; leaving shows the tags again.
    await title(page).click({ position: { x: 5, y: 10 } });
    await expect(title(page)).toHaveAttribute('contenteditable', 'plaintext-only');
    await expect(title(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(title(page).locator('.tag')).toHaveText('#салон');
    await title(page).locator('.tag').click();
    await expect(page.locator('.search')).toHaveValue('#салон');
  });

  test('every active piece of the title works as in a row: @tags and [[links]] too', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    await title(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' @иван [[Том второй]]');
    await page.keyboard.press('Escape');
    await expect(title(page).locator('.tag')).toHaveText('@иван');
    await expect(title(page).locator('.link')).toHaveText('Том второй');
    await title(page).locator('.tag').click();
    await expect(page.locator('.search')).toHaveValue('@иван');
    await page.locator('.searchbar .clear').click();
    await title(page).locator('.link').click();
    await expect(title(page)).toHaveText('Том второй');
  });

  test('Alt+→ zooms into the edited bullet, Alt+← zooms out back to it', async ({ page }) => {
    await edit(page, 'Часть первая');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(title(page)).toHaveText('Часть первая');
    await expect(editing(page)).toHaveText(/Eh bien/);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(title(page)).toHaveText('Том первый');
    await expect(editing(page)).toHaveText('Часть первая');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(title(page)).toHaveCount(0);
    await expect(editing(page)).toHaveText('Том первый');
  });

  test('the title is editable; Enter in it starts the first child of an empty bullet', async ({ page }) => {
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Alt+ArrowRight');
    // No children: the caret goes to the title.
    await expect(title(page)).toBeFocused();
    await page.keyboard.type(' (черновик)');
    await page.keyboard.press('Enter');
    await page.keyboard.type('первая мысль');
    expect(await outline(page)).toEqual(['первая мысль']);
    // Out one level at a time.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(title(page)).toHaveText('Том первый');
    await page.keyboard.press('Alt+ArrowLeft');
    expect(await outline(page)).toEqual([...DEMO.slice(0, 4), '  Часть вторая (черновик)', '    первая мысль', DEMO[5]]);
  });

  test('inside a zoom, search covers only the zoomed-in bullet and Shift+Tab cannot leave it', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await page.locator('.search').fill('Том');
    await expect(page.locator('.searchbar .count')).toHaveText('0 bullet’ов');
    await page.locator('.search').fill('шерер');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    await page.locator('.search').press('Escape');

    await edit(page, 'Анна Павловна');
    await page.keyboard.press('Shift+Tab');
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
  });

  test('the "+" under the list adds bullets without the keyboard, home or zoomed in', async ({ page }) => {
    // Home: a new last top-level bullet.
    await page.locator('.add').click();
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type('Том третий');
    expect(await outline(page)).toEqual([...DEMO, 'Том третий']);

    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    expect(await outline(page)).toEqual([]);
    await page.locator('.add').click();
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type('первый');
    await page.locator('.add').click();
    await page.keyboard.type('второй');
    expect(await outline(page)).toEqual(['первый', 'второй']);
    // The "+" sits just under the last row.
    const last = await page.locator('.row').last().boundingBox();
    const add = await page.locator('.add').boundingBox();
    expect(add!.y).toBeGreaterThanOrEqual(last!.y + last!.height - 1);
    expect(add!.y).toBeLessThan(last!.y + last!.height + 20);
    // One undo step per click.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual(['первый']);
    // Hidden while searching.
    await page.locator('.search').fill('перв');
    await expect(page.locator('.add')).toHaveCount(0);
  });

  test('the zoom survives a reload of a stored document', async ({ page }) => {
    await page.goto('/?db=e2e-zoom');
    await page.locator('.row .text').click();
    await page.keyboard.type('Глава');
    await page.keyboard.press('Enter');
    await page.keyboard.type('вложенная');
    await page.keyboard.press('Tab');
    await page.locator('.row', { hasText: 'Глава' }).locator('.bullet').click();
    await expect(title(page)).toHaveText('Глава');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(title(page)).toHaveText('Глава');
    expect(await outline(page)).toEqual(['вложенная']);
  });
});

test('the logo goes home: out of zoom and search, top level folded, one undo step', async ({ page }) => {
  await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
  await page.locator('.search').fill('шерер');
  await page.locator('.brand').click();
  await expect(page.locator('.zoom-title')).toHaveCount(0);
  await expect(page.locator('.search')).toHaveValue('');
  expect(new URL(page.url()).hash).toBe('');
  expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
  await expect(page.locator('.row', { hasText: 'Том первый' }).locator('.bullet')).toHaveClass(/collapsed/);
  await page.keyboard.press('Control+z');
  expect(await outline(page)).toEqual(DEMO);
});

test.describe('done and notes', () => {
  test('Ctrl+L makes a task (checkbox), then checks it; Ctrl+Shift+L makes it plain; undo works', async ({ page }) => {
    const row = page.locator('.row', { hasText: 'Часть вторая' });
    const box = row.locator('.bullet');
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Control+l');
    await expect(box).toHaveClass(/todo/);
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await expect(row).not.toHaveClass(/done/);
    await page.keyboard.press('Control+l');
    await expect(row).toHaveClass(/done/);
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Control+z');
    await expect(row).not.toHaveClass(/done/);
    await page.keyboard.press('Control+Shift+L');
    await expect(box).not.toHaveClass(/todo/);
    // The old key does nothing now: no task, no split.
    await page.keyboard.press('Control+Enter');
    await expect(box).not.toHaveClass(/todo/);
    expect(await outline(page)).toEqual(DEMO);
    // A Russian layout: the same physical key, "д".
    await editing(page).dispatchEvent('keydown', { key: 'д', code: 'KeyL', ctrlKey: true, bubbles: true });
    await expect(box).toHaveClass(/todo/);
  });

  test('a click on the checkbox checks the task; a click on a plain bullet still zooms in', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Control+l');
    const row = page.locator('.row', { hasText: 'Том второй' });
    await row.locator('.bullet').click();
    await expect(row).toHaveClass(/done/);
    await expect(editing(page)).toHaveText('Том второй'); // editing goes on
    await row.locator('.bullet').click();
    await expect(row).not.toHaveClass(/done/);
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    await expect(page.locator('.zoom-title')).toHaveText('Часть вторая');
  });

  test('Shift+Enter writes a note under the bullet; Esc and arrows move between text and note', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Shift+Enter');
    const note = page.locator('.note[contenteditable]');
    await expect(note).toBeFocused();
    await page.keyboard.type('первая строка');
    await page.keyboard.press('Enter');
    await page.keyboard.type('вторая #важно');
    await page.keyboard.press('Escape');
    await expect(editing(page)).toHaveText('Том второй');
    await expect(page.locator('.row', { hasText: 'Том второй' }).locator('.note')).toHaveText('первая строка\nвторая #важно');
    await expect(page.locator('.note .tag')).toHaveText('#важно');
    // Down from the text goes into its note.
    await page.keyboard.press('ArrowDown');
    await expect(note).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(editing(page)).toBeFocused();
    // A tag in a note filters to its bullet.
    await page.keyboard.press('Escape');
    await page.locator('.note .tag').click();
    expect(await outline(page)).toEqual(['Том второй']);
  });

  test('a note shows its first 3 lines until its bullet is edited; the zoomed-in bullet shows its whole note', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('один\nдва\nтри\nчетыре\nпять');
    await page.keyboard.press('Escape');
    const row = page.locator('.row', { hasText: 'Том второй' });
    const note = row.locator('.note');
    const lineHeight = await note.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    // Being edited (the caret in its text): all five lines.
    await expect(note).not.toHaveClass(/clamped/);
    expect((await note.boundingBox())!.height).toBeCloseTo(5 * lineHeight, 0);
    // Left: three lines, the rest behind an ellipsis.
    await page.keyboard.press('Escape');
    await expect(note).toHaveClass(/clamped/);
    expect((await note.boundingBox())!.height).toBeCloseTo(3 * lineHeight, 0);
    await expect(note).toHaveText('один\nдва\nтри\nчетыре\nпять');

    // Zoomed in, the title shows the whole note; Shift+Enter in the title edits it, Esc goes back.
    await row.locator('.bullet').click();
    const zoomNote = page.locator('.zoom-note');
    await expect(zoomNote).toHaveText('один\nдва\nтри\nчетыре\nпять');
    expect((await zoomNote.boundingBox())!.height).toBeCloseTo(5 * lineHeight, 0);
    await page.locator('.zoom-title').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Shift+Enter');
    await expect(zoomNote).toBeFocused();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nшесть #важно');
    await page.keyboard.press('Escape');
    await expect(page.locator('.zoom-title')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(zoomNote.locator('.tag')).toHaveText('#важно');
    // A click on the note edits it where the click was.
    await zoomNote.click({ position: { x: 3, y: 3 } });
    await expect(zoomNote).toBeFocused();
    await page.keyboard.press('Escape');
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await expect(note).toHaveText('один\nдва\nтри\nчетыре\nпять\nшесть #важно');
  });

  test('a bullet without a note gets one from the zoom title with Shift+Enter', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    await expect(page.locator('.zoom-note')).toHaveCount(0);
    await page.locator('.zoom-title').click();
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.zoom-note')).toBeFocused();
    await page.keyboard.type('описание');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.zoom-note')).toHaveText('описание');
  });

  test('Ctrl+O hides completed bullets: completing one moves the caret on; the choice is remembered', async ({ page }) => {
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Control+o');
    await expect(page.locator('.toast')).toContainText('Выполненные скрыты');
    await page.keyboard.press('Control+l'); // a task now, still open: stays
    expect(await outline(page)).toEqual(DEMO);
    await page.keyboard.press('Control+l');
    expect(await outline(page)).toEqual(DEMO.filter((l) => !l.includes('Часть вторая')));
    await expect(editing(page)).toHaveText('Том второй');
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(DEMO.length); // ?demo starts fresh, nothing is completed
    await page.locator('.row .text', { hasText: 'Том второй' }).click();
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Control+l');
    expect(await outline(page)).toEqual(DEMO.slice(0, 5)); // still hidden after the reload
    await page.keyboard.press('Control+o');
    expect(await outline(page)).toEqual(DEMO);
  });

  test('notes and completion survive a reload', async ({ page }) => {
    await page.goto('/?db=e2e-notes');
    await page.locator('.row .text').click();
    await page.keyboard.type('пункт');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('заметка');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Control+l');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('.row')).toHaveClass(/done/);
    await expect(page.locator('.row .note')).toHaveText('заметка');
  });
});

test('dragging across a row that is not being edited selects its text on the first press', async ({ page }) => {
  const text = page.locator('.row .text', { hasText: 'Так говорила' });
  await expect(text).not.toHaveAttribute('contenteditable');
  const box = (await text.boundingBox())!;
  const y = box.y + box.height / 4;
  // From before "Так" to somewhere past "говорила"; the row wraps, so stay on its first line.
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, y, { steps: 4 });
  await page.mouse.move(box.x + 130, y, { steps: 4 });
  await page.mouse.up();
  await expect(editing(page)).toBeFocused();
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected.startsWith('Так говори')).toBe(true);
  // Typing replaces the selection, as in any editor.
  await page.keyboard.type('Вот');
  const original = 'Так говорила в июле 1805 года известная Анна Павловна Шерер #шерер';
  await expect(editing(page)).toHaveText('Вот' + original.slice(selected.length));
});

test.describe('selecting several bullets', () => {
  const selected = (page: Page) => page.locator('.row.selected .text').allTextContents();

  test('Shift+↓ selects; Tab, Ctrl+L, copy, Delete and undo act on the block', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await selected(page)).toEqual(['Часть вторая', 'Том второй']);
    await expect(editing(page)).toHaveCount(0);

    await page.keyboard.press('Control+l');
    await expect(page.locator('.row .bullet.todo')).toHaveCount(2);
    await page.keyboard.press('Control+l');
    await expect(page.locator('.row.done')).toHaveCount(2);
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('- [x] Часть вторая\n- [x] Том второй\n');

    await page.keyboard.press('Shift+ArrowUp');
    expect(await selected(page)).toEqual(['Часть вторая']);
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    // From "Часть вторая" up two rows: both quotes of the first part.
    expect(await selected(page)).toEqual([DEMO[2].trim(), DEMO[3].trim(), 'Часть вторая']);

    await page.keyboard.press('Delete');
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[5]]);
    await page.keyboard.press('Control+z');
    expect((await outline(page)).length).toBe(DEMO.length);
  });

  test('Shift+click selects a range from the edited row; Esc clears it', async ({ page }) => {
    await edit(page, 'Часть первая');
    await page.locator('.row .text', { hasText: 'Том второй' }).click({ modifiers: ['Shift'] });
    expect(await selected(page)).toEqual(DEMO.slice(1).map((l) => l.trim()));
    // The first one has nowhere to go: Tab leaves the whole block as it is.
    await page.keyboard.press('Tab');
    expect(await outline(page)).toEqual(DEMO);
    // Shift+Tab lifts it, keeping the order.
    await page.keyboard.press('Shift+Tab');
    expect(await outline(page)).toEqual(['Том первый', 'Часть первая', ...DEMO.slice(2, 4).map((l) => l.slice(2)), 'Часть вторая', 'Том второй']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.row.selected')).toHaveCount(0);
  });
});

test.describe('drag and drop', () => {
  /** Drags a row's bullet onto the lower half of another row, `levels` deeper than that row's bullet. */
  async function dragTo(page: Page, from: string, onto: string, levels: number, cancel = false) {
    const bullet = page.locator('.row', { hasText: from }).locator('.bullet').first();
    const target = page.locator('.row', { hasText: onto }).first();
    const b = (await bullet.boundingBox())!;
    const t = (await target.locator('.bullet').boundingBox())!;
    const row = (await target.boundingBox())!;
    const indent = await page.locator('.indent-probe').evaluate((el) => el.getBoundingClientRect().width);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    const x = t.x + t.width / 2 + levels * indent;
    const y = row.y + row.height * 0.75;
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + ((x - b.x) * i) / 8, b.y + ((y - b.y) * i) / 8);
    await expect(page.locator('.drop-line')).toBeVisible();
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }

  test('dragging a bullet moves it with its subtree to the place and level of the line', async ({ page }) => {
    await dragTo(page, 'Часть первая', 'Том второй', 1);
    expect(await outline(page)).toEqual(['Том первый', '  Часть вторая', 'Том второй', '  Часть первая', ...DEMO.slice(2, 4)]);
    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual(DEMO);
  });

  test('Esc cancels a drag; a click without moving still zooms in', async ({ page }) => {
    await dragTo(page, 'Часть вторая', 'Том второй', 0, true);
    await expect(page.locator('.drop-line')).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    await expect(page.locator('.zoom-title')).toHaveText('Часть вторая');
  });
});

test.describe('export and import', () => {
  const menu = (page: Page) => page.getByRole('button', { name: 'Меню документа' });
  const item = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name });

  test('downloads the outline as Markdown and as OPML', async ({ page }) => {
    await menu(page).click();
    const [md] = await Promise.all([page.waitForEvent('download'), item(page, 'Скачать как Markdown').click()]);
    expect(md.suggestedFilename()).toMatch(/^listik-\d{4}-\d{2}-\d{2}\.md$/);
    const text = await readFile((await md.path())!, 'utf8');
    expect(text.split('\n').slice(0, 2)).toEqual(['- Том первый', '  - Часть первая']);
    expect(text).toContain('    - Так говорила в июле 1805 года');

    await menu(page).click();
    const [opml] = await Promise.all([page.waitForEvent('download'), item(page, /OPML/).click()]);
    expect(opml.suggestedFilename()).toMatch(/\.opml$/);
    expect(await readFile((await opml.path())!, 'utf8')).toContain('<outline text="Том первый">');
  });

  test('imports an OPML file into the current zoom, as one undo step', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    await menu(page).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), item(page, 'Импорт из файла…').click()]);
    const opml = '<?xml version="1.0"?><opml version="2.0"><body><outline text="Глава I"><outline text="Москва &amp; Петербург" /></outline><outline text="Глава II" /></body></opml>';
    await chooser.setFiles({ name: 'workflowy.opml', mimeType: 'text/xml', buffer: Buffer.from(opml) });
    await expect(page.locator('.toast')).toContainText('Импортировано 3 пункта');
    expect(await outline(page)).toEqual(['Глава I', '  Москва & Петербург', 'Глава II']);
    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual([]);
  });

  test('pasting an indented list builds a tree', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await editing(page).evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', '- план\n  - шаг 1\n  - шаг 2\n    - деталь\n- итог');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    expect((await outline(page)).slice(-5)).toEqual(['план', '  шаг 1', '  шаг 2', '    деталь', 'итог']);
  });

  test('a stored document offers automatic copies into a folder', async ({ page }) => {
    await page.goto('/?db=e2e-backup');
    await expect(page.locator('.row')).toHaveCount(1);
    await menu(page).click();
    await expect(item(page, 'Автокопия в папку…')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.menu')).toHaveCount(0);
  });
});

test('the shortcuts panel opens with ? and Ctrl+/ and closes with Esc', async ({ page }) => {
  await page.keyboard.press('?');
  const panel = page.getByRole('dialog', { name: 'Горячие клавиши' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('сделать задачей (чекбокс)');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await edit(page, 'Том второй');
  await page.keyboard.press('Control+/');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Закрыть' }).click();
  await expect(panel).toBeHidden();
});

test.describe('theme', () => {
  const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const CREAM = 'rgb(250, 249, 245)';
  const DARK = 'rgb(38, 38, 36)';

  test('follows the system until picked; the pick survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?demo');
    expect(await background(page)).toBe(DARK);
    // The switch lives in the menu, as everything but search does.
    await expect(page.locator('.topbar button')).toHaveCount(2);
    const menu = page.getByRole('button', { name: 'Меню документа' });
    await menu.click();
    await page.getByRole('menuitem', { name: 'Дневная тема' }).click();
    // The switch runs inside a view transition: it lands on the next frame.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await background(page)).toBe(CREAM);
    await menu.click();
    await expect(page.getByRole('menuitem', { name: 'Ночная тема' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    expect(await background(page)).toBe(CREAM);
    // A system change no longer overrides the pick.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await background(page)).toBe(CREAM);
  });
});

test.describe('text size', () => {
  const fontSize = (page: Page) => page.locator('.row .text').first().evaluate((el) => getComputedStyle(el).fontSize);
  const menu = (page: Page) => page.getByRole('button', { name: 'Меню документа' });

  test('the menu steps the outline text, keeps the menu open, and the size survives a reload', async ({ page }) => {
    expect(await fontSize(page)).toBe('17px');
    await menu(page).click();
    const larger = page.getByRole('button', { name: 'Крупнее' });
    await larger.click();
    await larger.click();
    await expect(page.locator('.menu')).toBeVisible();
    await expect(page.locator('.step-value')).toHaveText('130%');
    expect(await fontSize(page)).toBe('22.1px');
    // The chrome keeps its size; only the outline grows.
    expect(await page.locator('.search').evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px');
    // Rows are measured again: none overlaps the next.
    const boxes = await page.locator('.row').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect()).map((b) => [b.top, b.bottom]));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1] - 0.5);

    await page.reload();
    await expect(page.locator('.row')).toHaveCount(DEMO.length);
    expect(await fontSize(page)).toBe('22.1px');
    await menu(page).click();
    await page.getByRole('button', { name: 'Мельче' }).click();
    await page.getByRole('button', { name: 'Мельче' }).click();
    await page.getByRole('button', { name: 'Мельче' }).click();
    await expect(page.locator('.step-value')).toHaveText('85%');
    await expect(page.getByRole('button', { name: 'Мельче' })).toBeDisabled();
    expect(await fontSize(page)).toBe('14.45px');
  });
});

test.describe('phone screen', () => {
  const rightmost = (page: Page) =>
    page.locator('.topbar > *, .topbar-actions > *').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));

  test('the header fits; the theme switch works from the menu', async ({ page }) => {
    // A OnePlus 8 held upright, then the narrowest phones.
    for (const width of [412, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await rightmost(page)).toBeLessThanOrEqual(width);
      // A query with its count and the clear button still leaves room for the menu.
      await page.locator('.search').fill('#салон');
      await expect(page.locator('.searchbar .count')).toBeVisible();
      expect(await rightmost(page)).toBeLessThanOrEqual(width);
      await page.locator('.search').fill('');
      await page.getByRole('button', { name: 'Меню документа' }).click();
      const box = (await page.locator('.menu').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
    }

    await page.getByRole('button', { name: 'Меню документа' }).click();
    await page.getByRole('menuitem', { name: 'Ночная тема' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.menu')).toHaveCount(0);
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await expect(page.getByRole('menuitem', { name: 'Дневная тема' })).toBeVisible();
  });

  test('the end of a long list scrolls up to mid-screen', async ({ page }) => {
    await page.goto('/?sample=300');
    await expect(page.locator('.row').first()).toBeVisible();
    const scroller = page.locator('.scroller');
    // Scroll to the very end; virtualized rows settle as they render.
    for (let i = 0; i < 3; i++) {
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(100);
    }
    const box = (await scroller.boundingBox())!;
    const last = (await page.locator('.row').last().boundingBox())!;
    expect(last.y + last.height - box.y).toBeLessThan(box.height * 0.6);
  });

  test('the keyboard coming up keeps the edited row in view', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto('/?sample=300');
    await expect(page.locator('.row').first()).toBeVisible();
    // The lowest row that is fully on screen.
    const id = await page.locator('.row').evaluateAll((rows) => {
      const fits = rows.filter((r) => r.getBoundingClientRect().bottom <= innerHeight);
      return (fits[fits.length - 1] as HTMLElement).dataset.id!;
    });
    const row = page.locator(`.row[data-id="${id}"]`);
    await row.locator('.text').click();
    await expect(editing(page)).toBeFocused();
    // The keyboard takes ~40% of the screen (index.html: it shrinks the page).
    await page.setViewportSize({ width: 412, height: 540 });
    await expect.poll(async () => (await row.boundingBox())!.y + (await row.boundingBox())!.height).toBeLessThanOrEqual(540);
    await expect(editing(page)).toBeFocused();
  });
});

test.describe('touch screen', () => {
  // A OnePlus 8: no hardware keyboard, the pointer is a finger.
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  const bar = (page: Page) => page.getByRole('toolbar', { name: 'Правка пункта' });
  const action = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true });
  /** The on-screen keyboard shrinks the window (index.html: resizes-content); here, by ~40%. */
  const keyboard = (page: Page, up: boolean) => page.setViewportSize({ width: 412, height: up ? 540 : 915 });

  test('a bar under the list does what Tab, Ctrl+L and Ctrl+Z do; the keyboard stays', async ({ page }) => {
    await expect(bar(page)).toHaveCount(0);
    await page.locator('.row .text', { hasText: 'Часть вторая' }).tap();
    await expect(editing(page)).toBeFocused();
    await keyboard(page, true);
    await expect(bar(page)).toBeVisible();

    await action(page, 'Вынести').tap();
    expect((await outline(page)).slice(-2)).toEqual(['Часть вторая', 'Том второй']);
    await expect(editing(page)).toBeFocused();
    await action(page, 'Вложить').tap();
    await action(page, 'Переместить вверх').tap();
    expect((await outline(page))[1]).toBe('  Часть вторая');
    await action(page, 'Переместить вниз').tap();
    expect(await outline(page)).toEqual(DEMO);

    await action(page, 'Задача: сделать, отметить, снять отметку').tap();
    await expect(page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet.todo')).toHaveCount(1);
    await action(page, 'Отменить').tap();
    await expect(page.locator('.bullet.todo')).toHaveCount(0);
    await action(page, 'Повторить').tap();
    await expect(page.locator('.bullet.todo')).toHaveCount(1);

    await action(page, 'Заметка').tap();
    await expect(page.locator('.note[contenteditable]')).toBeFocused();
    await page.keyboard.type('с телефона');
    await action(page, 'Заметка').tap();
    await expect(editing(page)).toBeFocused();
    await expect(page.locator('.row', { hasText: 'Часть вторая' }).locator('.note')).toHaveText('с телефона');
    // The keyboard has its own key to hide it, and the bar goes with it; the row is still edited.
    await expect(action(page, 'Готово')).toHaveCount(0);
    await keyboard(page, false);
    await expect(bar(page)).toHaveCount(0);
    await expect(editing(page)).toBeFocused();
    await keyboard(page, true);
    await expect(bar(page)).toBeVisible();
  });

  test('in the zoom title the bar offers the note: made if there is none, and back to the title', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').tap();
    const title = page.locator('.zoom-title');
    await title.tap();
    await expect(title).toBeFocused();
    await keyboard(page, true);
    await expect(bar(page)).toBeVisible();
    // Only what applies to the title: no moving it about.
    await expect(action(page, 'Вложить')).toHaveCount(0);
    await action(page, 'Заметка').tap();
    const note = page.locator('.zoom-note');
    await expect(note).toBeFocused();
    await page.keyboard.type('с телефона');
    await action(page, 'Заметка').tap();
    await expect(title).toBeFocused();
    await expect(note).toHaveText('с телефона');
    // Undo takes typing back a word at a time.
    await action(page, 'Отменить').tap();
    await expect(note).toHaveText('с ');
  });

  test('typing at the bottom keeps the line, descenders and air, above the bar', async ({ page }) => {
    await page.goto('/?sample=300');
    await expect(page.locator('.row').first()).toBeVisible();
    const id = await page.locator('.row').evaluateAll((rows) => {
      const fits = rows.filter((r) => r.getBoundingClientRect().bottom <= innerHeight);
      return (fits[fits.length - 1] as HTMLElement).dataset.id!;
    });
    await page.locator(`.row[data-id="${id}"] .text`).tap();
    await keyboard(page, true);
    await expect(bar(page)).toBeVisible();
    await page.keyboard.press('Control+End');
    // Enough to wrap onto new lines, each a little lower.
    await page.keyboard.type(' рррр уууу дддд'.repeat(4));
    const gap = await page.evaluate(() => {
      const caret = getSelection()!.getRangeAt(0).getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(document.activeElement!).lineHeight);
      return (document.querySelector('.editbar')!.getBoundingClientRect().top - caret.bottom) / lh;
    });
    expect(gap).toBeGreaterThanOrEqual(0.5);
  });

  test('no bar while the keyboard is down, nor for the address bar coming and going', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await expect(editing(page)).toBeFocused();
    await expect(bar(page)).toHaveCount(0);
    await page.setViewportSize({ width: 412, height: 859 });
    await expect(bar(page)).toHaveCount(0);
  });

  test('suggestions: fewer with the keyboard up, above the bar, taken with a tap', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    await page.keyboard.press('Control+End');
    await editing(page).evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', ' ' + Array.from({ length: 20 }, (_, i) => `#тема${i}`).join(' '));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.keyboard.type(' #');
    const tags = page.getByRole('listbox', { name: 'Теги' });
    // 540 px × 0.3 / 40 px rows.
    await expect(tags.getByRole('option')).toHaveCount(4);
    const box = (await tags.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(412);
    expect(box.y + box.height).toBeLessThanOrEqual((await bar(page).boundingBox())!.y);
    await page.keyboard.type('шер');
    await tags.getByRole('option', { name: '#шерер' }).tap();
    await expect(editing(page)).toHaveText(/#шерер $/);
    await expect(editing(page)).toBeFocused();
  });

  test('"Оформление" swaps in bold and italic; picking one brings the main set back', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    const main = page.locator('.editbar-main');
    const formats = page.locator('.editbar-format');
    await expect(formats).toHaveAttribute('inert', '');
    await action(page, 'Оформление').tap();
    await expect(main).toHaveAttribute('inert', '');
    await expect(formats).not.toHaveAttribute('inert', '');

    await editing(page).evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, 4);
      range.setEnd(el.firstChild!, 10);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await action(page, 'Жирный').tap();
    await expect(editing(page)).toHaveText('Том **второй**');
    await expect(editing(page)).toBeFocused();
    await expect(formats).toHaveAttribute('inert', '');
    await expect(main).not.toHaveAttribute('inert', '');

    await action(page, 'Оформление').tap();
    await action(page, 'Назад').tap();
    await expect(main).not.toHaveAttribute('inert', '');
    await expect(editing(page)).toHaveText('Том **второй**');
  });

  test('the clock button puts the current time at the caret', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 19, 23, 40));
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    await page.keyboard.press('Control+Home');
    await action(page, 'Вставить время').tap();
    await expect(editing(page)).toHaveText('23:40Том второй');
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type(' ');
    await expect(editing(page)).toHaveText('23:40 Том второй');
  });

  test('Backspace at the start never joins two bullets; an empty one still goes', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await expect(editing(page)).toBeFocused();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    expect(await outline(page)).toEqual(DEMO);
    await expect(editing(page)).toHaveText('Том второй');

    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    expect(await outline(page)).toEqual([...DEMO, '']);
    await page.keyboard.press('Backspace');
    expect(await outline(page)).toEqual(DEMO);
    await expect(editing(page)).toHaveText('Том второй');
  });

  /** A finger down on a row's bullet, optionally held, moved in steps to (x, y), and lifted. */
  async function finger(page: Page, from: string, opts: { hold: number; to?: (b: { x: number; y: number }) => { x: number; y: number } }) {
    const cdp = await page.context().newCDPSession(page);
    const box = (await page.locator('.row', { hasText: from }).locator('.bullet').first().boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
    await touch('touchStart', start);
    await page.waitForTimeout(opts.hold);
    const end = opts.to?.(start);
    if (end) {
      for (let i = 1; i <= 8; i++) {
        await touch('touchMove', { x: start.x + ((end.x - start.x) * i) / 8, y: start.y + ((end.y - start.y) * i) / 8 });
      }
    }
    await touch('touchEnd');
    await cdp.detach();
  }

  test('a tap on a bullet zooms in; a held bullet drags; a swipe from it does neither', async ({ page }) => {
    // Swipe: the finger moves at once.
    await finger(page, 'Часть вторая', { hold: 0, to: (s) => ({ x: s.x, y: s.y + 60 }) });
    await expect(page.locator('.drop-line')).toHaveCount(0);
    await expect(page.locator('.zoom-title')).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);

    // Hold, then carry it below "Том второй", one level in.
    const target = (await page.locator('.row', { hasText: 'Том второй' }).boundingBox())!;
    const indent = await page.locator('.indent-probe').evaluate((el) => el.getBoundingClientRect().width);
    await finger(page, 'Часть первая', { hold: 500, to: () => ({ x: target.x + 10 + indent, y: target.y + target.height * 0.75 }) });
    expect(await outline(page)).toEqual(['Том первый', '  Часть вторая', 'Том второй', '  Часть первая', ...DEMO.slice(2, 4)]);

    // A short tap: in.
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').tap();
    await expect(page.locator('.zoom-title')).toHaveText('Часть вторая');
  });

  test('the menu speaks of gestures, not keys', async ({ page }) => {
    await page.getByRole('button', { name: 'Меню документа' }).tap();
    await expect(page.locator('.menu .hint', { hasText: /Ctrl|\?/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Жесты и клавиши' }).tap();
    const panel = page.getByRole('dialog', { name: 'Жесты и клавиши' });
    await expect(panel.locator('h3').first()).toHaveText('Касания');
    await expect(panel).toContainText('поднять пункт и перетащить');
    // The keys are still listed, for a keyboard attached to the phone.
    await expect(panel).toContainText('вложить / вынести');
    expect(await panel.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  });

  test('fold arrows show without hover and fold at a tap', async ({ page }) => {
    const toggle = page.locator('.row', { hasText: 'Том первый' }).locator('.toggle');
    await expect(toggle).toHaveCSS('opacity', '1');
    // The finger lands a little beside the 16px arrow: still the arrow.
    const box = (await toggle.boundingBox())!;
    await page.touchscreen.tap(box.x - 6, box.y + box.height / 2);
    expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
    await toggle.tap();
    expect(await outline(page)).toEqual(DEMO);
  });
});

test.describe('time', () => {
  test('/time becomes the current time, in a bullet and in its note; undo brings /time back', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 19, 9, 5));
    await edit(page, 'Том второй');
    await page.keyboard.type(' a/time и /time');
    await expect(editing(page)).toHaveText('Том второй a/time и 09:05');
    await page.keyboard.press('Control+z');
    await expect(editing(page)).toHaveText('Том второй a/time и /time');
    await page.keyboard.press('Control+Shift+z');
    await expect(editing(page)).toHaveText('Том второй a/time и 09:05');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' дальше');
    await expect(editing(page)).toHaveText('Том второй a/time и 09:05 дальше');

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('/time');
    await expect(page.locator('.note[contenteditable]')).toHaveText('09:05');
  });

  test('while a keyboard composes the word, /time waits for it to end', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 19, 9, 5));
    await edit(page, 'Том второй');
    await page.keyboard.type(' /');
    // As Android keyboards do: the word is composed, then committed.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'time', selectionStart: 4, selectionEnd: 4 });
    await expect(editing(page)).toHaveText('Том второй /time');
    await cdp.send('Input.insertText', { text: 'time' });
    await expect(editing(page)).toHaveText('Том второй 09:05');
    await cdp.detach();
  });
});

test.describe('suggestions', () => {
  const list = (page: Page, name: 'Теги' | 'Команды') => page.getByRole('listbox', { name });
  const options = (page: Page) => page.getByRole('option').allTextContents();
  /** Pastes one line into the edited row: many tags at once. */
  const paste = (page: Page, text: string) =>
    editing(page).evaluate((el, t) => {
      const data = new DataTransfer();
      data.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

  test('# offers existing tags, filters as you type, and Enter takes one', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.type(' #');
    await expect(list(page, 'Теги')).toBeVisible();
    expect(await options(page)).toEqual(['#салон1', '#шерер1']);
    await page.keyboard.type('ш');
    expect(await options(page)).toEqual(['#шерер1']);
    await page.keyboard.press('Enter');
    await expect(list(page, 'Теги')).toHaveCount(0);
    await expect(editing(page)).toHaveText('Том второй #шерер ');
    await page.keyboard.type('и');
    await expect(editing(page)).toHaveText('Том второй #шерер и');
    expect(await outline(page)).toHaveLength(DEMO.length);
  });

  test('@ offers @tags only, and a click on one filters by it, apart from the #tag of the same name', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.type(' @салон для встречи');
    await page.keyboard.press('Enter');
    await page.keyboard.type('встреча @');
    await expect(list(page, 'Теги')).toBeVisible();
    expect(await options(page)).toEqual(['@салон1']);
    await page.keyboard.press('Enter');
    await expect(editing(page)).toHaveText('встреча @салон ');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.locator('.row .tag', { hasText: '@салон' }).first().click();
    await expect(page.locator('.search')).toHaveValue('@салон');
    expect((await outline(page)).map((r) => r.trim())).toEqual(['Том второй @салон для встречи', 'встреча @салон']);
    await page.locator('.search').fill('#салон');
    await page.locator('.search').press('Enter');
    await expect(page.locator('.row .text', { hasText: 'Eh bien' })).toBeVisible();
    expect(await outline(page)).not.toContain('встреча @салон');
  });

  test('↑/↓ choose, a click takes, Esc closes and Enter splits again', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.type(' #');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { selected: true })).toHaveText('#шерер1');
    await page.getByRole('option', { name: '#салон' }).click();
    await expect(editing(page)).toHaveText('Том второй #салон ');

    await page.keyboard.type('#');
    await page.keyboard.press('Escape');
    await expect(list(page, 'Теги')).toHaveCount(0);
    await expect(editing(page)).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await outline(page)).toEqual([...DEMO.slice(0, -1), 'Том второй #салон #', '']);
  });

  test('/ offers commands; a few letters are enough', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 19, 9, 5));
    await edit(page, 'Том второй');
    await page.keyboard.type(' /');
    await expect(list(page, 'Команды')).toBeVisible();
    expect(await options(page)).toEqual(['/timeтекущее время, ЧЧ:ММ']);
    await page.keyboard.type('ti');
    await page.keyboard.press('Tab');
    await expect(editing(page)).toHaveText('Том второй 09:05');
    expect(await outline(page)).toEqual(DEMO.slice(0, -1).concat('Том второй 09:05'));
    await page.keyboard.type(' /x');
    await expect(list(page, 'Команды')).toHaveCount(0);
  });

  test('as many as fit a third of the window; in the middle of a word the whole word is replaced', async ({ page }) => {
    await edit(page, 'Том второй');
    await paste(page, ' ' + Array.from({ length: 20 }, (_, i) => `#тема${i}`).join(' '));
    await page.keyboard.press('Enter');
    await page.keyboard.type('#тем');
    // 720 px × 0.3 / 32 px rows.
    await expect(page.getByRole('option')).toHaveCount(6);
    await page.keyboard.type('а1');
    await expect(page.getByRole('option').first()).toHaveText('#тема11');
    // The caret back inside the word: what is before it is the query, and the whole word goes.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('option').first()).toHaveText('#тема01');
    await page.keyboard.press('Enter');
    await expect(editing(page)).toHaveText('#тема0 ');
  });
});

test.describe('links', () => {
  const list = (page: Page) => page.getByRole('listbox', { name: 'Ссылки' });
  const options = (page: Page) => page.getByRole('option').allTextContents();
  const crumbs = (page: Page) => page.locator('.crumbs .crumb');

  test('[[ closes itself and offers bullets by title; a click on the link zooms into the bullet where it is', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('см. [[');
    await expect(editing(page)).toHaveText('см. [[]]');
    await expect(list(page)).toBeVisible();
    await page.keyboard.type('втор');
    // Shorter titles first; the hint is where the bullet is.
    expect(await options(page)).toEqual(['Том второй', 'Часть втораяТом первый']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(list(page)).toHaveCount(0);
    await expect(editing(page)).toHaveText('см. [[Часть вторая]]');
    await page.keyboard.type(' и дальше');
    await expect(editing(page)).toHaveText('см. [[Часть вторая]] и дальше');
    await page.keyboard.press('Escape');

    const link = page.locator('.row .link');
    await expect(link).toHaveText('Часть вторая');
    await link.click();
    await expect(crumbs(page)).toHaveText(['Главная', 'Том первый', 'Часть вторая']);
    await expect(page.locator('.zoom-title')).toHaveText('Часть вторая');
    await page.goBack();
    await expect(crumbs(page)).toHaveText(['Главная']);
    await expect(page.locator('.row .link')).toHaveText('Часть вторая');
  });

  test('] steps over the closing brackets, Backspace takes out an empty pair, a link to nothing says so', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[[');
    await expect(editing(page)).toHaveText('[[]]');
    await page.keyboard.press('Backspace');
    await expect(editing(page)).toHaveText('[]');
    await page.keyboard.press('Backspace');
    await expect(editing(page)).toHaveText('');

    await page.keyboard.type('[[Нет такого]]!');
    await expect(editing(page)).toHaveText('[[Нет такого]]!');
    await page.keyboard.press('Escape');
    await page.locator('.row .link').click();
    await expect(page.locator('.toast')).toContainText('Нет пункта «Нет такого»');
    await expect(crumbs(page)).toHaveText(['Главная']);
  });
});

test.describe('mirrors', () => {
  const list = (page: Page) => page.getByRole('listbox', { name: 'Зеркала' });
  const crumbs = (page: Page) => page.locator('.crumbs .crumb');

  test('(( offers bullets; taking one makes the bullet a mirror: a diamond, the original\'s text, the dot leads to the original', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((');
    await expect(editing(page)).toHaveText('(())');
    await expect(list(page)).toBeVisible();
    await page.keyboard.type('Часть втор');
    await page.keyboard.press('Enter');
    await expect(list(page)).toHaveCount(0);
    const mirror = page.locator('.row.mirror');
    await expect(mirror).toHaveCount(1);
    await expect(mirror.locator('.bullet')).toHaveClass(/mirror/);
    await expect(editing(page)).toHaveText('Часть вторая');

    // The mirror's heading takes no edits: typing, erasing and pasting leave the original as it is.
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' (зеркало)');
    await page.keyboard.press('Backspace');
    await expect(editing(page)).toHaveText('Часть вторая');
    await expect(page.locator('.toast')).toContainText('Заголовок зеркала правится в оригинале');
    await page.keyboard.press('Escape');
    await expect(page.locator('.row .text', { hasText: 'Часть вторая' })).toHaveCount(2);
    // Typed in the original, it changes in the mirror.
    await edit(page, 'Часть вторая');
    await page.keyboard.type(' (зеркало');
    await page.keyboard.press('Escape');
    await expect(page.locator('.row .text', { hasText: 'Часть вторая (зеркало' })).toHaveCount(2);
    await expect(page.locator('.row.mirror .text')).toHaveText('Часть вторая (зеркало');

    // The mirror's dot leads to the original, where it stands in the outline.
    await page.locator('.row.mirror .bullet').click();
    await expect(crumbs(page)).toHaveText(['Главная', 'Том первый', 'Часть вторая (зеркало']);
  });

  test('a mirror shows everything under its original; edits there are the original\'s, the caret stays in the mirror', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Том перв');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const all = await outline(page);
    expect(all).toEqual([...DEMO, ...DEMO.slice(0, 5)]);
    await expect(page.locator('.row.mirror')).toHaveCount(1);

    // Enter at the end of a bullet inside the mirror: the new bullet is the original's, edited in the mirror.
    const inMirror = page.locator('.row[data-id*="/"]', { hasText: 'Часть вторая' });
    await inMirror.locator('.text').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Часть третья');
    await expect(page.locator('.row[data-id*="/"] .text[contenteditable]')).toHaveText('Часть третья');
    await expect(page.locator('.row .text', { hasText: 'Часть третья' })).toHaveCount(2);
    expect((await outline(page)).slice(0, 7)).toEqual([...DEMO.slice(0, 5), '  Часть третья', 'Том второй']);

    // The mirror folds on its own; the original stays open.
    await page.keyboard.press('Escape');
    await page.locator('.row.mirror .toggle').click();
    expect(await outline(page)).toEqual([...DEMO.slice(0, 5), '  Часть третья', 'Том второй', 'Том первый']);

    // Backspace at the start of the mirror takes out the link alone: the original keeps its title and bullets.
    await page.locator('.row.mirror .text').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.row.mirror')).toHaveCount(0);
    expect(await outline(page)).toEqual([...DEMO.slice(0, 5), '  Часть третья', 'Том второй']);
    await expect(editing(page)).toHaveText('Том второй');
  });

  test('deleting a mirror with what it shows selected leaves the original whole', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Том перв');
    await page.keyboard.press('Enter');
    // Shift+↓ from the mirror's heading selects it with the rows under it.
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.row.selected')).toHaveCount(5);
    await page.keyboard.press('Delete');
    expect(await outline(page)).toEqual(DEMO);
  });

  test('(( with other text puts the mirror below; ) steps over; Backspace takes out an empty pair', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('см. ((Том перв');
    await page.keyboard.press('Enter');
    await expect(page.locator('.row.mirror')).toHaveCount(1);
    await expect(page.locator('.row.mirror .text')).toHaveText('Том первый');
    await expect(page.locator('.row .text', { hasText: /^см\.\s*$/ })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    // Both ")" typed step over the brackets already there.
    await page.keyboard.type('((x))!');
    await expect(editing(page)).toHaveText('((x))!');
    await page.keyboard.press('Escape');
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((');
    await expect(editing(page)).toHaveText('(())');
    await page.keyboard.press('Backspace');
    await expect(editing(page)).toHaveText('()');
    await page.keyboard.press('Backspace');
    await expect(editing(page)).toHaveText('');
  });
});

test.describe('bold and italic', () => {
  test('**bold** and *italic* show styled, markers hidden; editing shows the markers', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.type(' **жирное** и *курсив*');
    await page.keyboard.press('Escape');
    const row = page.locator('.row', { hasText: 'Том второй' });
    await expect(row.locator('.md-bold')).toHaveText('жирное');
    await expect(row.locator('.md-italic')).toHaveText('курсив');
    await expect(row.locator('.md-marker').first()).toBeHidden();
    expect(await row.locator('.md-bold').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
    expect(await row.locator('.md-italic').evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
    // Visible text reads without the markers; the model keeps them.
    expect(await row.locator('.text').innerText()).toBe('Том второй жирное и курсив');
    await row.locator('.md-italic').click();
    await expect(editing(page)).toHaveText('Том второй **жирное** и *курсив*');
  });

  test('Ctrl+B and Ctrl+I wrap the selection, and unwrap it again', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Shift+Control+ArrowLeft');
    await page.keyboard.press('Control+b');
    await expect(editing(page)).toHaveText('Том **второй**');
    await page.keyboard.press('Control+i');
    await expect(editing(page)).toHaveText('Том ***второй***');
    await page.keyboard.press('Control+i');
    await page.keyboard.press('Control+b');
    await expect(editing(page)).toHaveText('Том второй');
    await page.keyboard.press('Control+z');
    await expect(editing(page)).toHaveText('Том **второй**');
  });
});

test('no editing bar with a mouse and a keyboard', async ({ page }) => {
  await edit(page, 'Том второй');
  await expect(page.locator('.editbar')).toHaveCount(0);
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
    await page.locator('.row', { hasText: 'Запись' }).locator('.toggle').click();
    await page.locator('.row', { hasText: 'Запись' }).locator('.toggle').click();
    // Writes are batched for 300 ms.
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(3);
    expect(await outline(page)).toEqual(['Запись', '  вложенная', '  ещё одна']);
  });

  test('compaction runs in a worker and keeps every edit', async ({ page }) => {
    await page.goto('/?demo');
    const result = await page.evaluate(async () => {
      // App modules, as Vite serves them to the page.
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { Persistence } = (await load('/src/persist/idb.ts')) as typeof import('../src/persist/idb.ts');
      const { VisibleRows } = (await load('/src/model/rows.ts')) as typeof import('../src/model/rows.ts');
      const cmd = (await load('/src/model/commands.ts')) as typeof import('../src/model/commands.ts');
      const { doc, persistence } = await Persistence.open('e2e-compact');
      const ctx = { doc, rows: new VisibleRows(doc) };
      const first = ctx.rows.ids[0];
      doc.transact(() => cmd.setText(ctx, first, 'до пересборки'));
      await persistence.flush();
      const compacting = persistence.compact();
      // Edits made while the worker compacts must survive it.
      doc.transact(() => { cmd.split(ctx, first, 13); });
      doc.transact(() => cmd.setText(ctx, ctx.rows.ids[1], 'во время пересборки'));
      await compacting;
      await persistence.flush();
      persistence.close();
      const reopened = await Persistence.open('e2e-compact');
      reopened.persistence.close();
      const texts = [...reopened.doc.get(reopened.doc.root).children].map((id) => reopened.doc.get(id).text);
      return { texts, error: String(persistence.error) };
    });
    expect(result).toEqual({ texts: ['до пересборки', 'во время пересборки'], error: 'null' });
  });

  test('a second tab is read-only until the first one closes, then takes over', async ({ context, page }) => {
    await page.goto('/?db=e2e-tabs');
    await expect(page.locator('.row')).toHaveCount(1);
    await page.locator('.row .text').click();
    await page.keyboard.type('из первой вкладки');
    await page.waitForTimeout(500); // writes are batched for 300 ms

    const second = await context.newPage();
    await second.goto('/?db=e2e-tabs');
    await expect(second.locator('.banner')).toContainText('только просмотр');
    await expect(second.locator('.row .text')).toHaveText('из первой вкладки');
    await second.locator('.row .text').click();
    await expect(second.locator('.text[contenteditable]')).toHaveCount(0);

    await page.close();
    await expect(second.locator('.banner')).toHaveCount(0, { timeout: 10_000 });
    await second.locator('.row .text').click();
    await second.keyboard.press('Control+End');
    await second.keyboard.type(' и второй');
    await expect(second.locator('.text[contenteditable]')).toHaveText('из первой вкладки и второй');
  });

  test('demo and sample documents never touch stored data', async ({ page }) => {
    await page.goto('/?demo&db=e2e');
    await edit(page, 'Том второй');
    await page.keyboard.type(' изменён');
    await page.waitForTimeout(500);
    await page.goto('/?db=e2e');
    // The stored document loads asynchronously.
    await expect(page.locator('.row')).toHaveCount(1);
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
    await page.keyboard.press('Control+End');
    const started = Date.now();
    await page.keyboard.type('abcdefghij');
    await page.keyboard.press('Enter');
    await page.keyboard.type('новый');
    await expect(editing(page)).toHaveText('новый');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('200k bullets: filtering by a tag takes one frame', async ({ page }) => {
    await page.goto('/?sample=200000');
    const tag = page.locator('.tag').first();
    await expect(tag).toBeVisible();
    // Measure the steady state: let post-load work (GC, idle index build) settle first.
    await page.waitForTimeout(1000);
    // From the click to the next painted frame, measured in the page.
    const ms = await tag.evaluate(async (el) => {
      const started = performance.now();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      return performance.now() - started;
    });
    await expect(page.locator('.searchbar .count')).toBeVisible();
    const count = Number((await page.locator('.searchbar .count').textContent())!.split(' ')[0]);
    console.log(`filter: ${count} matches in ${Math.round(ms)} ms`);
    expect(count).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(100);
    // Every rendered bullet is a match or on the path to one.
    expect(await page.locator('.row').count()).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    await expect(page.locator('.searchbar .count')).toHaveCount(0);
  });
  test('200k bullets: text search takes about a frame', async ({ page }) => {
    await page.goto('/?sample=200000');
    await expect(page.locator('.row').first()).toBeVisible();
    // Measure the steady state: let post-load work (GC, idle index build) settle first.
    await page.waitForTimeout(1000);
    // From the keystroke to the painted result, measured in the page (the search runs on the next frame).
    const ms = await page.locator('.search').evaluate(async (el) => {
      const input = el as HTMLInputElement;
      const started = performance.now();
      input.value = 'наташа смотрел';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      await frame();
      await frame();
      return performance.now() - started;
    });
    const count = Number((await page.locator('.searchbar .count').textContent())!.split(' ')[0]);
    console.log(`search: ${count} matches in ${Math.round(ms)} ms`);
    expect(count).toBeGreaterThan(100);
    // A smoke check with room for a busy machine (wall clock, two frames, GC);
    // `npm run bench` holds the real numbers.
    expect(ms).toBeLessThan(150);
    await expect(page.locator('.row mark').first()).toBeVisible();
  });

  test('200k bullets: the logo folds ~700 chapters in about a frame', async ({ page }) => {
    await page.goto('/?sample=200000');
    await expect(page.locator('.row').first()).toBeVisible();
    await page.waitForTimeout(1000);
    const ms = await page.locator('.brand').evaluate(async (el) => {
      const started = performance.now();
      (el as HTMLElement).click();
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      return performance.now() - started;
    });
    const rows = await page.locator('.row').count();
    console.log(`home: folded in ${Math.round(ms)} ms, ${rows} rows rendered`);
    await expect(page.locator('.row').first()).toHaveText('Глава 1');
    await expect(page.locator('.row[data-depth="1"]')).toHaveCount(0);
    // Wall clock on a shared machine, after the heaviest tests: a smoke check.
    // (Without bulk rebuilds this took 124 ms; with them, ~20-45 ms.)
    expect(ms).toBeLessThan(100);
  });
});
