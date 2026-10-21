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

test.describe('saved searches', () => {
  const star = (page: Page) => page.locator('.searchbar .star');
  const list = (page: Page) => page.getByRole('list', { name: 'Избранные поиски' });

  test('the star saves what is typed; focused, the box lists saved searches, last saved first; a press runs one, × takes it out', async ({ page }) => {
    const search = page.locator('.search');
    await search.fill('#салон');
    await expect(star(page)).toHaveAttribute('aria-pressed', 'false');
    await star(page).click();
    await expect(star(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(star(page).locator('path')).toHaveAttribute('d', /M12/);
    await search.fill('Анна');
    await star(page).click();
    await search.press('Escape');

    // Focus on an empty box: the saved searches, the last saved first.
    await search.click();
    await expect(list(page).getByRole('listitem')).toHaveText(['Анна', '#салон']);
    // Typing narrows them.
    await search.pressSequentially('#с');
    await expect(list(page).getByRole('listitem')).toHaveText(['#салон']);
    await list(page).getByRole('button', { name: '#салон', exact: true }).click();
    await expect(search).toHaveValue('#салон');
    await expect(search).toBeFocused();
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    await expect(star(page)).toHaveAttribute('aria-pressed', 'true');

    // Kept in this browser.
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(DEMO.length);
    await search.click();
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await list(page).getByRole('button', { name: 'Убрать «Анна» из избранного' }).click();
    await expect(list(page).getByRole('listitem')).toHaveText(['#салон']);
    await search.press('Escape');
    await expect(list(page)).toHaveCount(0);
  });

  test('at most 20 kept, the oldest letting go; a long list scrolls, about five rows on a phone with the keyboard up', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('listik-saved-searches', JSON.stringify(Array.from({ length: 20 }, (_, i) => `поиск ${i}`))));
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(DEMO.length);
    const search = page.locator('.search');
    await search.fill('новый');
    await star(page).click();
    await expect(page.locator('.toast')).toContainText('не больше 20');
    await search.fill('');
    await expect(list(page).getByRole('listitem')).toHaveCount(20);
    await expect(list(page).getByRole('listitem').first()).toHaveText('новый');
    await expect(list(page).getByRole('listitem').last()).toHaveText('поиск 18');
    const menu = page.locator('.search-menu');
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(menu).toHaveClass(/more/);
    await menu.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(menu).not.toHaveClass(/more/);
    // A OnePlus 8 with the keyboard up: 412 × 540.
    await page.setViewportSize({ width: 412, height: 540 });
    const height = await menu.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(0.4 * 540 + 1);
    expect(height).toBeGreaterThan(150);
  });
});

test.describe('go to a place', () => {
  const line = (page: Page) => page.getByRole('dialog', { name: 'Перейти к пункту' });
  const places = (page: Page) => page.getByRole('listbox', { name: 'Места' });
  const recent = (page: Page) => page.getByRole('listbox', { name: 'Недавние места' });
  const title = (page: Page) => page.locator('.zoom-title');

  test('Ctrl+K: a line in the middle of the screen; a name lists places with their path, the first chosen; the outline is not searched; Enter goes in, the caret on its first bullet', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(line(page).getByRole('textbox')).toBeFocused();
    const box = (await line(page).boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
    expect(box.y).toBeGreaterThan(100);
    await page.keyboard.type('часть пер');
    await expect(places(page).getByRole('option')).toHaveText(['Часть первая' + 'Том первый']);
    await expect(places(page).getByRole('option', { selected: true })).toHaveText(/^Часть первая/);
    // What is typed is a name, not a search: the outline stays whole.
    await expect(page.locator('.search')).toHaveValue('');
    await expect(page.locator('.searchbar .count')).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);
    await page.keyboard.press('Enter');
    await expect(title(page)).toHaveText('Часть первая');
    await expect(line(page)).toHaveCount(0);
    await expect(editing(page)).toHaveText(DEMO[2].trim());
  });

  test('↓ chooses another place, a click goes there without editing; Esc closes, the caret back; a name nothing has says so', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('часть');
    const options = places(page).getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await places(page).getByRole('option', { name: /Часть вторая/ }).click();
    await expect(title(page)).toHaveText('Часть вторая');
    await expect(editing(page)).toHaveCount(0);

    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await edit(page, 'Том второй');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('нет такого');
    await expect(line(page)).toContainText('Нет пункта с таким названием');
    await page.keyboard.press('Escape');
    await expect(line(page)).toHaveCount(0);
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type('|');
    await expect(editing(page)).toHaveText('Том второ|й');
  });

  test('the search box lists no places; Ctrl+K from it opens the line, the search staying; so does the menu', async ({ page }) => {
    const search = page.locator('.search');
    await search.click();
    await search.pressSequentially('часть');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(line(page).getByRole('textbox')).toBeFocused();
    await expect(search).toHaveValue('часть');
    // A press outside closes it.
    await page.mouse.click(5, 300);
    await expect(line(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await page.getByRole('menuitem', { name: /Перейти к пункту/ }).click();
    await expect(line(page).getByRole('textbox')).toBeFocused();
  });

  test('before anything is typed, the places gone to lately, the newest first and chosen, without the one you are in', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await page.locator('.row', { hasText: 'Том второй' }).locator('.bullet').click();
    await expect(title(page)).toHaveText('Том второй');
    await page.keyboard.press('Control+k');
    await expect(recent(page).getByRole('option')).toHaveText(['Часть первая' + 'Том первый']);
    await expect(recent(page).getByRole('option', { selected: true })).toHaveText(/^Часть первая/);
    await page.keyboard.press('Enter');
    await expect(title(page)).toHaveText('Часть первая');
    await page.keyboard.press('Control+k');
    await expect(recent(page).getByRole('option')).toHaveText(['Том второй']);
  });
});

test.describe('move to a place', () => {
  const targets = (page: Page) => page.getByRole('listbox', { name: 'Куда переместить' });
  const input = (page: Page) => page.getByRole('dialog', { name: 'Переместить' }).getByRole('textbox');

  test('Ctrl+Shift+M: the line asks where to; a name and Enter move the bullet last there, the caret stays here; undo and the toast', async ({ page }) => {
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Control+Shift+m');
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveAttribute('placeholder', 'Переместить «Часть вторая» в…');
    await page.keyboard.type('том вт');
    // The outline is left as it is: the name is no search.
    expect(await outline(page)).toEqual(DEMO);
    await expect(targets(page).getByRole('option', { selected: true })).toHaveText('Том второй');
    await page.keyboard.press('Enter');
    expect(await outline(page)).toEqual([...DEMO.slice(0, 4), 'Том второй', '  Часть вторая']);
    // On, to the row that followed it.
    await expect(editing(page)).toHaveText('Том второй');
    await expect(input(page)).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Перемещено в');

    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual(DEMO);
    await expect(editing(page)).toHaveText('Часть вторая');

    // Where bullets went lately comes first, before anything is typed.
    await page.keyboard.press('Control+Shift+m');
    await expect(targets(page).getByRole('option').first()).toHaveText('Том второй');
    // The toast's place leads there, to the moved bullet.
    await page.keyboard.press('Enter');
    await page.locator('.toast').getByRole('button', { name: 'Том второй' }).click();
    await expect(page.locator('.zoom-title')).toHaveText('Том второй');
    await expect(editing(page)).toHaveText('Часть вторая');
  });

  test('a bullet is never offered itself or what is inside it; Esc moves nothing and the caret goes back', async ({ page }) => {
    await edit(page, 'Часть первая');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Shift+m');
    await page.keyboard.type('часть');
    await expect(targets(page).getByRole('option')).toHaveText(['Часть вторая' + 'Том первый']);
    await page.keyboard.type(' пер');
    await expect(targets(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type('|');
    await expect(editing(page)).toHaveText('Часть перва|я');
    expect(await outline(page)).toHaveLength(DEMO.length);
  });

  test('selected bullets move together, in their order', async ({ page }) => {
    await edit(page, 'Часть первая');
    // Down through its own bullets to the next part.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+Shift+m');
    await expect(input(page)).toHaveAttribute('placeholder', 'Переместить 2 пункта в…');
    await page.keyboard.type('том вт');
    await page.keyboard.press('Enter');
    expect(await outline(page)).toEqual(['Том первый', 'Том второй', '  Часть первая', '    ' + DEMO[2].trim(), '    ' + DEMO[3].trim(), '  Часть вторая']);
    await expect(page.locator('.toast')).toContainText('2 пункта перемещены в');
  });
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
    // Nothing found says so, instead of a blank page.
    await expect(page.locator('.no-results')).toHaveText('Ничего не найдено');
    await search.press('Escape');
    await expect(page.locator('.no-results')).toHaveCount(0);
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

  test('a path only a little too wide does not scroll: the place\'s own crumb gives way', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 800 });
    await page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet').click();
    await title(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' — очень длинный заголовок пункта');
    await page.keyboard.press('Escape');
    const nav = page.locator('.crumbs');
    // "Главная" whole and unfaded; the current crumb ends in an ellipsis instead.
    await expect(nav).not.toHaveClass(/clipped/);
    expect(await nav.evaluate((el) => el.scrollLeft)).toBe(0);
    const current = page.locator('.crumbs [aria-current="page"]');
    expect(await current.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
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

  test('Backspace takes out an empty first bullet under the title, the caret going to the title\'s end', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await edit(page, 'Eh bien');
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    expect(await outline(page)).toEqual(['', DEMO[2].trim(), DEMO[3].trim()]);
    await page.keyboard.press('Backspace');
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
    await expect(page.locator('.zoom-title[contenteditable]')).toBeFocused();
    // With text, the first row stays: there is nothing to join it to.
    await edit(page, 'Eh bien');
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Backspace');
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
  });

  test('going into a bullet found by a search clears the search: the bullet shows whole', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.locator('.search').fill('Часть первая');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    // Found folded, as matches are; its bullet leads inside.
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1]]);
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await expect(title(page)).toHaveText('Часть первая');
    await expect(page.locator('.search')).toHaveValue('');
    await expect(page.locator('.searchbar .count')).toHaveCount(0);
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
  });

  test('going up by the path keeps the search: its results show at every level', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await page.locator('.search').fill('шерер');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    expect(await outline(page)).toEqual([DEMO[3].trim()]);
    // The box's list of places lies over the path: out of the box first.
    await page.locator('.search').blur();
    await crumbs(page).filter({ hasText: 'Том первый' }).click();
    await expect(title(page)).toHaveText('Том первый');
    await expect(page.locator('.search')).toHaveValue('шерер');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    expect(await outline(page)).toEqual([DEMO[1].trim(), `  ${DEMO[3].trim()}`]);
    await crumbs(page).filter({ hasText: 'Главная' }).click();
    await expect(title(page)).toHaveCount(0);
    await expect(page.locator('.search')).toHaveValue('шерер');
    expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[3]]);
    // Wider up, more is found: what the search covers is the place.
    await page.locator('.search').fill('Часть');
    await expect(page.locator('.searchbar .count')).toHaveText('2 bullet’а');
  });

  test('gone up by the path to the very bullet searched for: everything inside it shows', async ({ page }) => {
    await page.locator('.row', { hasText: 'Eh bien' }).locator('.bullet').click();
    await page.locator('.search').fill('Часть первая');
    await expect(page.locator('.searchbar .count')).toHaveText('0 bullet’ов');
    await page.locator('.search').blur();
    await crumbs(page).filter({ hasText: 'Часть первая' }).click();
    await expect(title(page)).toHaveText('Часть первая');
    await expect(page.locator('.search')).toHaveValue('Часть первая');
    await expect(page.locator('.searchbar .count')).toHaveText('1 bullet');
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
    // One level up the search shows its path again.
    await crumbs(page).filter({ hasText: 'Том первый' }).click();
    expect(await outline(page)).toEqual([DEMO[1].trim()]);
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
    await page.goto('/?db=e2e-zoom&empty');
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

test('a click on a guide line folds the bullet whose line it is; the line lights under the pointer', async ({ page }) => {
  const row = page.locator('.row', { hasText: 'Анна Павловна' });
  const box = (await row.boundingBox())!;
  const indent = await page.locator('.indent-probe').evaluate((el) => el.getBoundingClientRect().width);
  // The second line of a row two levels down: "Часть первая"'s.
  await page.mouse.move(box.x + indent + 10, box.y + 10);
  await expect(page.locator('.guide-hot')).toHaveCount(1);
  await page.mouse.down();
  await page.mouse.up();
  expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[4], DEMO[5]]);
  await expect(page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet')).toHaveClass(/collapsed/);
  // Off the line, nothing.
  await page.mouse.move(box.x + indent + 22, box.y + 10);
  await expect(page.locator('.guide-hot')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect(await outline(page)).toEqual(DEMO);
});

test('the place\'s own crumb folds the first level inside, an overview; again, it opens what it folded', async ({ page }) => {
  await page.locator('.row', { hasText: 'Том первый' }).locator('.bullet').click();
  expect(await outline(page)).toEqual(DEMO.slice(1, 5).map((l) => l.slice(2)));
  const crumb = page.locator('.crumbs .crumb.current');
  await expect(crumb).toHaveText('Том первый');
  await crumb.click();
  expect(await outline(page)).toEqual(['Часть первая', 'Часть вторая']);
  await crumb.click();
  expect(await outline(page)).toEqual(DEMO.slice(1, 5).map((l) => l.slice(2)));
  // At home, "Главная" does the same.
  await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
  const home = page.locator('.crumbs .crumb', { hasText: 'Главная' });
  await home.click();
  expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
  await home.click();
  expect(await outline(page)).toEqual(DEMO);
});

test('"Главная" goes home with the search, and there folds the top level: out of the search, one undo step', async ({ page }) => {
  await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
  await page.locator('.search').fill('шерер');
  await page.locator('.search').blur();
  await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
  await expect(page.locator('.zoom-title')).toHaveCount(0);
  await expect(page.locator('.search')).toHaveValue('шерер');
  expect(await outline(page)).toEqual([DEMO[0], DEMO[1], DEMO[3]]);
  await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
  await expect(page.locator('.zoom-title')).toHaveCount(0);
  await expect(page.locator('.search')).toHaveValue('');
  expect(new URL(page.url()).hash).toBe('');
  expect(await outline(page)).toEqual(['Том первый', 'Том второй']);
  await expect(page.locator('.row', { hasText: 'Том первый' }).locator('.bullet')).toHaveClass(/collapsed/);
  await page.keyboard.press('Control+z');
  expect(await outline(page)).toEqual(DEMO);
});

test.describe('structure and calendar', () => {
  const create = async (page: Page) => {
    await page.locator('.menu-button').click();
    await page.getByRole('menuitem', { name: /Создать структуру/ }).click();
  };
  const two = (n: number) => String(n).padStart(2, '0');
  const WEEKDAYS = ['@воскресенье', '@понедельник', '@вторник', '@среда', '@четверг', '@пятница', '@суббота'];
  const dayText = (d: Date) => `@d${two(d.getDate())} @m${two(d.getMonth() + 1)} ${WEEKDAYS[d.getDay()]}`;
  const now = new Date();
  const shifted = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const today = dayText(now);
  const year = `@y${now.getFullYear()}`;
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const STRUCTURE = ['Inbox', '@q1', '@q2', '@q3', '@q4', 'Projects', 'Hubs', 'Reference', 'Archive'];
  const SLOTS = Array.from({ length: 19 }, (_, i) => `${two(9 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
  /** A day as it is first entered: notes and a todo list, each with an empty bullet, then the hours. */
  const DAY = ['#notes', '  ', 'todo', '  ', ...SLOTS];
  const title = (page: Page) => page.locator('.zoom-title');
  const caret = (page: Page) => page.locator('.text[contenteditable]:focus');

  test('the menu puts it last at the top level and goes to today, filled, with no caret; undo takes it back', async ({ page }) => {
    await create(page);
    await expect(title(page)).toHaveText(today);
    expect(await outline(page)).toEqual(DAY);
    // The bullet under "todo" is plain, as under the notes: no checkbox.
    await expect(page.locator('.row').nth(3).locator('.bullet')).not.toHaveClass(/todo/);
    await expect(caret(page)).toHaveCount(0);
    for (const crumb of [`@q${quarter}`, year, new RegExp(`^@m${two(now.getMonth() + 1)}$`), /^@w\d\d$/]) {
      await expect(page.locator('.crumbs .crumb', { hasText: crumb })).toHaveCount(1);
    }
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await expect(title(page)).toHaveCount(0);
    expect(await outline(page)).toEqual([...DEMO, ...STRUCTURE]);
    // The menu offers it again: a second one would go last too.
    await page.locator('.menu-button').click();
    await expect(page.getByRole('menuitem', { name: /Создать структуру/ })).toHaveCount(1);
    await page.keyboard.press('Escape');
    // The day's template, then the structure.
    for (let i = 0; i < 2; i++) await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual(DEMO);
  });

  test('the logo opens today, as it was left; nothing comes in twice', async ({ page }) => {
    await page.locator('.brand').click();
    await expect(page.locator('.toast')).toContainText('Структуры ещё нет');
    await create(page);
    await expect(title(page)).toHaveText(today);
    await page.locator('.row .text').nth(1).click();
    await page.keyboard.type('утро');
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await expect(title(page)).toHaveCount(0);
    await page.locator('.brand').click();
    await expect(title(page)).toHaveText(today);
    await expect(caret(page)).toHaveCount(0);
    expect(await outline(page)).toEqual(['#notes', '  утро', ...DAY.slice(2)]);
    expect(new URL(page.url()).hash).not.toBe('');
  });

  test('‹ › and Ctrl+Alt+←/→ step to the day, week, month or quarter before and after', async ({ page }) => {
    await expect(page.locator('.period-steps')).toHaveCount(0);
    await create(page);
    await page.keyboard.press('Control+Alt+ArrowRight');
    await expect(title(page)).toHaveText(dayText(shifted(1)));
    // Entered for the first time: filled.
    expect(await outline(page)).toEqual(DAY);
    await page.getByRole('button', { name: 'Следующий день' }).click();
    await expect(title(page)).toHaveText(dayText(shifted(2)));
    await page.keyboard.press('Control+Alt+ArrowLeft');
    await page.getByRole('button', { name: 'Предыдущий день' }).click();
    await expect(title(page)).toHaveText(today);
    await page.locator('.crumbs .crumb', { hasText: /^@w\d\d$/ }).click();
    const week = await title(page).textContent();
    await page.getByRole('button', { name: 'Следующая неделя' }).click();
    await expect(title(page)).toHaveText(/^@w\d\d$/);
    await page.getByRole('button', { name: 'Предыдущая неделя' }).click();
    await expect(title(page)).toHaveText(week!);
    await page.locator('.crumbs .crumb', { hasText: /^@m/ }).click();
    await page.getByRole('button', { name: 'Следующий месяц' }).click();
    await expect(title(page)).toHaveText(`@m${two(((now.getMonth() + 1) % 12) + 1)}`);
    await page.locator('.crumbs .crumb', { hasText: /^@y/ }).click();
    await page.getByRole('button', { name: 'Предыдущий квартал' }).click();
    // Before the first quarter, the year before comes in.
    await expect(title(page)).toHaveText(quarter === 1 ? `@y${now.getFullYear() - 1}` : year);
    const before = ((quarter + 2) % 4) + 1;
    await page.locator('.crumbs .crumb', { hasText: `@q${before}` }).click();
    await expect(title(page)).toHaveText(`@q${before}`);
    await expect(page.locator('.period-steps')).toHaveCount(0);
  });

  test('"today" in "Перейти к…": today\'s day first, Enter goes there as the logo does', async ({ page }) => {
    await create(page);
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await expect(title(page)).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('today');
    const first = page.getByRole('listbox', { name: 'Места' }).getByRole('option').first();
    await expect(first).toHaveText(/^Сегодня\d\d\.\d\d\.\d{4}$/);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(title(page)).toHaveText(today);
    await expect(page.getByRole('dialog', { name: 'Перейти к пункту' })).toHaveCount(0);
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('сег');
    await page.getByRole('option', { name: /^Сегодня/ }).click();
    await expect(title(page)).toHaveText(today);
  });

  test('a new document starts with it, on today; a reload stays where it was', async ({ page }) => {
    await page.goto('/?db=e2e-calendar');
    await expect(title(page)).toHaveText(today);
    expect(await outline(page)).toEqual(DAY);
    await page.locator('.row .text').nth(1).click();
    await page.keyboard.type('запись');
    await page.waitForTimeout(500);
    await page.goto('/?db=e2e-calendar');
    await expect(title(page)).toHaveText(today);
    expect(await outline(page)).toEqual(['#notes', '  запись', ...DAY.slice(2)]);
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    // In place of the lone empty bullet.
    expect(await outline(page)).toEqual(STRUCTURE);
    await page.locator('.row', { hasText: '@q1' }).locator('.bullet').click();
    await page.waitForTimeout(300);
    await page.reload();
    await expect(title(page)).toHaveText('@q1');
  });
});

test.describe('quick capture', () => {
  const line = (page: Page) => page.getByRole('dialog', { name: 'Запись в Inbox' });
  const field = (page: Page) => line(page).getByRole('textbox');

  test('Ctrl+Shift+Space while editing: a thought goes last into the Inbox, made if missing; the caret comes back where it was', async ({ page }) => {
    await edit(page, 'Часть вторая');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Shift+Space');
    await expect(field(page)).toBeFocused();
    await page.keyboard.type('позвонить #задача в /time');
    await expect(field(page)).toHaveValue(/^позвонить #задача в \d\d:\d\d$/);
    await page.keyboard.press('Enter');
    await expect(line(page)).toHaveCount(0);
    expect((await outline(page)).slice(-2)).toEqual(['Inbox', expect.stringMatching(/^  позвонить #задача в \d\d:\d\d$/)]);
    await expect(page.locator('.toast')).toContainText('Записано в Inbox');
    // Back in the row, one character before its end, as it was.
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type('!');
    await expect(editing(page)).toHaveText('Часть втора!я');

    // The tray in the header: the next one goes last, into the same Inbox.
    await page.getByRole('button', { name: 'Записать в Inbox' }).click();
    await page.keyboard.type('вторая мысль');
    await page.keyboard.press('Enter');
    expect((await outline(page)).slice(-2)).toEqual([expect.stringMatching(/^  позвонить/), '  вторая мысль']);
    await expect(page.locator('.row .text', { hasText: /^Inbox$/ })).toHaveCount(1);
    // "Отменить" takes it back.
    await page.locator('.toast').getByRole('button', { name: 'Отменить' }).click();
    expect((await outline(page)).at(-1)).toMatch(/^  позвонить/);

    // "Inbox" in the toast leads to the note just made, the caret at its end, to go on writing.
    await page.keyboard.press('Control+Shift+Space');
    await page.keyboard.type('дописать потом');
    await page.keyboard.press('Enter');
    await page.locator('.toast').getByRole('button', { name: 'Inbox' }).click();
    await expect(page.locator('.zoom-title')).toHaveText('Inbox');
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(editing(page)).toHaveText('дописать потом');
    await page.keyboard.type(': подробности');
    await expect(editing(page)).toHaveText('дописать потом: подробности');
  });

  test('an Inbox with emoji and formatting around its name is found: capture and a link to nothing both go there', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('📥 **Inbox** ✅');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+Space');
    await page.keyboard.type('мысль');
    await page.keyboard.press('Enter');
    await expect(page.locator('.row .text', { hasText: /Inbox/ })).toHaveCount(1);
    expect((await outline(page)).at(-1)).toBe('  мысль');
    // A link to nothing makes its bullet there too.
    await edit(page, 'Том второй');
    await page.keyboard.type(' [[Новая тема');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.row .link').click();
    await expect(page.locator('.crumbs .crumb').nth(1)).toContainText('Inbox');
    await expect(page.locator('.zoom-title')).toHaveText('Новая тема');
  });

  test('Esc closes the line and keeps what was typed for next time; nothing is written', async ({ page }) => {
    await page.keyboard.press('Control+Shift+Space');
    await page.keyboard.type('не дописал');
    await page.keyboard.press('Escape');
    await expect(line(page)).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);
    await page.keyboard.press('Control+Shift+Space');
    await expect(field(page)).toHaveValue('не дописал');
  });
});

test.describe('trash', () => {
  const panel = (page: Page) => page.getByRole('complementary', { name: 'Корзина' });
  const openTrash = async (page: Page) => {
    await page.locator('.menu-button').click();
    await page.getByRole('menuitem', { name: /Корзина/ }).click();
  };

  test('a panel beside the outline lists what is deleted as it goes; "Вернуть" puts it back, the caret in it; undo deletes it again', async ({ page }) => {
    await edit(page, 'Часть первая');
    await page.keyboard.press('Control+Shift+Backspace');
    // An empty line taken out is not listed.
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await openTrash(page);
    await expect(panel(page)).toBeVisible();
    const items = panel(page).locator('.trash-item');
    await expect(items).toHaveCount(1);
    await expect(items.first().locator('.trash-text')).toHaveText('Часть первая');
    await expect(items.first().locator('.trash-meta')).toContainText('+2 вложенных');
    await expect(items.first().locator('.trash-meta')).toContainText('Главная › Том первый');
    await expect(panel(page).locator('.trash-day h3')).toHaveText(['Сегодня']);

    // The outline goes on working, the panel open; a new deletion shows at once, on top.
    await edit(page, 'Том второй');
    await page.keyboard.type('!');
    await expect(editing(page)).toHaveText('Том второй!');
    await page.keyboard.press('Control+Shift+Backspace');
    await expect(items.first().locator('.trash-text')).toHaveText('Том второй!');
    await expect(items).toHaveCount(2);

    await items.nth(1).getByRole('button', { name: 'Вернуть' }).click();
    expect(await outline(page)).toEqual(['Том первый', ...DEMO.slice(1, 5)]);
    await expect(editing(page)).toBeFocused();
    await expect(editing(page)).toHaveText('Часть первая');
    await expect(items).toHaveCount(1);
    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual(['Том первый', '  Часть вторая']);
    await expect(items).toHaveCount(2);
    // It stays open through a reload; the filter narrows it down.
    await page.reload();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Закрыть корзину' }).click();
    await expect(panel(page)).toHaveCount(0);
  });

  test('a bullet erased letter by letter and then taken out goes to the trash with its text', async ({ page }) => {
    await edit(page, 'Часть вторая');
    for (let i = 0; i < 'Часть вторая'.length; i++) await page.keyboard.press('Backspace');
    await expect(editing(page)).toHaveText('');
    await page.keyboard.press('Backspace');
    expect(await outline(page)).toEqual(DEMO.filter((l) => !l.includes('Часть вторая')));
    await openTrash(page);
    const item = panel(page).locator('.trash-item');
    await expect(item.locator('.trash-text')).toHaveText(['Часть вторая']);
    await item.getByRole('button', { name: 'Вернуть' }).click();
    expect(await outline(page)).toEqual(DEMO);
    await expect(editing(page)).toHaveText('Часть вторая');
    // Undo brings back the empty bullet it was when deleted.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.row .text', { hasText: 'Часть вторая' })).toHaveCount(0);
    expect(await outline(page)).toEqual([...DEMO.slice(0, 4), '  ', DEMO[5]]);
  });

  test('a block whose place is not on the screen: the view goes there; one whose place is gone goes last', async ({ page }) => {
    await edit(page, 'Анна Павловна');
    await page.keyboard.press('Control+Shift+Backspace');
    await page.locator('.row', { hasText: 'Том второй' }).locator('.bullet').click();
    await expect(page.locator('.zoom-title')).toHaveText('Том второй');
    await openTrash(page);
    await panel(page).getByRole('button', { name: 'Вернуть' }).click();
    await expect(page.locator('.zoom-title')).toHaveText('Часть первая');
    await expect(editing(page)).toContainText('Анна Павловна');
    // Deleted, then its place too: back at the end of the top level.
    await page.keyboard.press('Control+Shift+Backspace');
    await page.locator('.crumbs .crumb', { hasText: 'Главная' }).click();
    await edit(page, 'Часть первая');
    await page.keyboard.press('Control+Shift+Backspace');
    const old = panel(page).locator('.trash-item').nth(1);
    await expect(old.locator('.trash-meta')).toContainText('из удалённого пункта');
    await old.getByRole('button', { name: 'Вернуть' }).click();
    await expect(page.locator('.toast')).toContainText('Прежнего места уже нет');
    expect((await outline(page)).at(-1)).toBe(DEMO[3].trim());
    await expect(editing(page)).toContainText('Анна Павловна');
  });
});

test.describe('done and notes', () => {
  test('Ctrl+L goes round: a task (checkbox), checked, plain again; a click on the box only checks; Ctrl+Shift+L makes it plain; undo works', async ({ page }) => {
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
    // The third press: a plain bullet again; the fourth, a task again.
    await page.keyboard.press('Control+l');
    await expect(box).not.toHaveClass(/todo/);
    await expect(row).not.toHaveClass(/done/);
    await page.keyboard.press('Control+l');
    await expect(box).toHaveClass(/todo/);
    // A click on the box only checks and unchecks; the caret stays in the row.
    await box.click();
    await expect(row).toHaveClass(/done/);
    await box.click();
    await expect(row).not.toHaveClass(/done/);
    await expect(box).toHaveClass(/todo/);
    await expect(editing(page)).toHaveText('Часть вторая');
    await page.keyboard.press('Control+l');
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

  test('a completed bullet stays where it is, struck through; nothing hides it', async ({ page }) => {
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Control+l');
    const row = page.locator('.row', { hasText: 'Часть вторая' });
    await expect(row).toHaveClass(/done/);
    await expect(row.locator('.text')).toHaveCSS('text-decoration-line', 'line-through');
    expect(await outline(page)).toEqual(DEMO);
    await expect(editing(page)).toHaveText('Часть вторая');
    await page.keyboard.press('Escape');
    await page.locator('.menu-button').click();
    await expect(page.getByRole('menuitem', { name: /выполненные/i })).toHaveCount(0);
  });

  test('notes and completion survive a reload', async ({ page }) => {
    await page.goto('/?db=e2e-notes&empty');
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
    await page.goto('/?db=e2e-backup&empty');
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

  test('follows the system; a pick holds until the system switches, a reload too; then the system leads again', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => background(page)).toBe(DARK);
    // The switch lives in the menu, as everything but search and quick capture does: the logo, the tray, the menu.
    await expect(page.locator('.topbar button')).toHaveCount(3);
    const menu = page.getByRole('button', { name: 'Меню документа' });
    await menu.click();
    await page.getByRole('menuitem', { name: 'Дневная тема' }).click();
    // The switch runs inside a view transition: it lands on the next frame.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => background(page)).toBe(CREAM);
    await menu.click();
    await expect(page.getByRole('menuitem', { name: 'Ночная тема' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The system is as it was: the pick holds, after a reload too.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => background(page)).toBe(CREAM);

    // The system switches: the app goes with it, and the pick is gone.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // The theme was light already: wait for the switch itself (the pick let go). Two switches
    // within a frame never fire a change, as the query ends where it began.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('listik-theme'))).toBeNull();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => background(page)).toBe(DARK);
    await page.reload();
    await expect.poll(() => background(page)).toBe(DARK);
  });

  test('a pick made under another system theme is dropped at the start', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?demo');
    await page.evaluate(() => {
      localStorage.setItem('listik-theme', 'dark');
      localStorage.setItem('listik-theme-system', 'dark');
    });
    await page.reload();
    await expect.poll(() => background(page)).toBe(CREAM);
  });

  test('a system that tells no theme gets the dark one', async ({ page }) => {
    // A browser without prefers-color-scheme: neither light nor dark matches.
    await page.addInitScript(() => {
      const own = window.matchMedia.bind(window);
      window.matchMedia = (q: string) => (q.includes('prefers-color-scheme') ? { ...own('(max-width: 0px)'), matches: false, media: 'not all', addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList : own(q));
    });
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await background(page)).toBe(DARK);
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
  /** A button of the set in view (the others are inert, sliding away). */
  const action = (page: Page, name: string) => bar(page).locator('.editbar-set:not([inert])').getByRole('button', { name, exact: true });
  /** The on-screen keyboard shrinks the window (index.html: resizes-content); here, by ~40%. */
  const keyboard = (page: Page, up: boolean) => page.setViewportSize({ width: 412, height: up ? 540 : 915 });

  test('quick capture comes first in the menu; no tray in the header; the line sits at the bottom', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Записать в Inbox' })).toBeHidden();
    // Turned sideways the window is wider than 640px, still no tray.
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(page.getByRole('button', { name: 'Записать в Inbox' })).toBeHidden();
    await page.setViewportSize({ width: 412, height: 915 });
    await page.getByRole('button', { name: 'Меню документа' }).tap();
    await expect(page.getByRole('menuitem').first()).toHaveText('Записать в Inbox');
    await page.getByRole('menuitem', { name: 'Записать в Inbox' }).tap();
    const line = page.getByRole('dialog', { name: 'Запись в Inbox' });
    await expect(line.getByRole('textbox')).toBeFocused();
    await expect.poll(async () => { const b = (await line.boundingBox())!; return Math.round(b.y + b.height); }).toBe(915);
    await page.keyboard.type('с телефона');
    await page.keyboard.press('Enter');
    expect((await outline(page)).slice(-2)).toEqual(['Inbox', '  с телефона']);
    // The message and its action on one line, not squeezed into half the screen.
    const toast = page.getByRole('status');
    await expect(toast).toContainText('Отменить');
    expect((await toast.boundingBox())!.height).toBeLessThan(50);
  });

  test('the trash is a sheet under the outline, inside the screen; it steps aside for the keyboard', async ({ page }) => {
    await page.locator('.menu-button').tap();
    await page.getByRole('menuitem', { name: /Корзина/ }).tap();
    const sheet = page.getByRole('complementary', { name: 'Корзина' });
    await expect(sheet).toBeVisible();
    // Once it has slid up.
    await expect.poll(async () => { const b = (await sheet.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(915 + 1);
    expect((await sheet.boundingBox())!.width).toBe(412);
    await page.locator('.row .text', { hasText: 'Часть вторая' }).tap();
    await keyboard(page, true);
    await expect(sheet).toHaveCount(0);
    await keyboard(page, false);
    await expect(sheet).toBeVisible();
  });

  test('a landscape phone with the keyboard up: no path, slimmer header and bar, the line in full above the bar', async ({ page }) => {
    await page.setViewportSize({ width: 915, height: 412 });
    await page.locator('.row .text', { hasText: 'Так говорила' }).tap();
    await page.setViewportSize({ width: 915, height: 190 });
    await expect(bar(page)).toBeVisible();
    await expect(page.locator('.crumbbar')).toBeHidden();
    const row = editing(page);
    await expect.poll(async () => { const r = (await row.boundingBox())!; return r.y + r.height; })
      .toBeLessThanOrEqual((await bar(page).boundingBox())!.y);
    expect((await row.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator('.topbar').boundingBox())!.height);
    // The keyboard down: the path is back.
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(page.locator('.crumbbar')).toBeVisible();
  });

  test('ten levels deep the text still has room: past the 4th a level indents less', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await page.keyboard.press('Control+End');
    for (let d = 1; d <= 10; d++) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.type(`уровень ${d}`);
    }
    await page.keyboard.press('Escape');
    const text = (d: number) => page.locator(`.row[data-depth="${d}"] .text`).last().boundingBox();
    // 28 px a level up to the 4th, 12 px after it.
    expect(Math.round((await text(4))!.x - (await text(3))!.x)).toBe(28);
    expect(Math.round((await text(5))!.x - (await text(4))!.x)).toBe(12);
    expect((await text(10))!.width).toBeGreaterThan(100);
    // A guide line deep down is still where its bullet is: a tap on it folds that bullet.
    const parent = (await page.locator('.row', { hasText: 'уровень 6' }).locator('.bullet').boundingBox())!;
    const child = (await page.locator('.row', { hasText: 'уровень 8' }).boundingBox())!;
    await page.touchscreen.tap(parent.x + parent.width / 2, child.y + child.height / 2);
    await expect(page.locator('.row', { hasText: 'уровень 7' })).toHaveCount(0);
  });

  test('the trash filter takes the keyboard: the sheet stays, without the edit bar', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Так говорила' }).tap();
    await page.keyboard.press('Control+Shift+Backspace');
    await page.locator('.menu-button').tap();
    await page.getByRole('menuitem', { name: /Корзина/ }).tap();
    const sheet = page.getByRole('complementary', { name: 'Корзина' });
    const filter = sheet.getByRole('searchbox', { name: 'Найти в удалённом' });
    await filter.tap();
    await keyboard(page, true);
    await expect(sheet).toBeVisible();
    await expect(filter).toBeFocused();
    await expect(bar(page)).toHaveCount(0);
    await page.keyboard.type('Шер');
    await expect(sheet.locator('.trash-item')).toHaveCount(1);
    // Back in a row, the keyboard is the outline's again: the sheet steps aside, the bar comes.
    await keyboard(page, false);
    await page.locator('.row .text', { hasText: 'Часть вторая' }).tap();
    await keyboard(page, true);
    await expect(sheet).toHaveCount(0);
    await expect(bar(page)).toBeVisible();
  });

  test('the search box lists no recent places: nothing drops over the outline', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').tap();
    await expect(page.locator('.zoom-title')).toHaveText('Часть первая');
    await page.locator('.search').tap();
    await expect(page.locator('.search')).toBeFocused();
    await expect(page.locator('.search-menu')).toHaveCount(0);
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });

  test('"Куда…" in the move set: a line at the top asks where to, a tap on a place moves the bullet', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Часть вторая' }).tap();
    await keyboard(page, true);
    await action(page, 'Переместить').tap();
    await action(page, 'Куда…').tap();
    const line = page.getByRole('dialog', { name: 'Переместить' });
    await expect(line.getByRole('textbox')).toBeFocused();
    expect((await line.boundingBox())!.y).toBeLessThan(20);
    await page.keyboard.type('том вт');
    await page.getByRole('listbox', { name: 'Куда переместить' }).getByRole('option', { name: /Том второй/ }).tap();
    expect(await outline(page)).toEqual([...DEMO.slice(0, 4), 'Том второй', '  Часть вторая']);
  });

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
    // Up and down share a set, which stays for a run of moves.
    await action(page, 'Переместить').tap();
    await action(page, 'Вверх').tap();
    expect((await outline(page))[1]).toBe('  Часть вторая');
    await action(page, 'Вниз').tap();
    expect(await outline(page)).toEqual(DEMO);
    await action(page, 'Вверх').tap();
    await action(page, 'Вниз').tap();
    expect(await outline(page)).toEqual(DEMO);
    // Out and in live in the main set only: no button twice.
    await expect(action(page, 'Вынести')).toHaveCount(0);
    await expect(action(page, 'Вложить')).toHaveCount(0);
    await page.locator('.editbar-move').getByRole('button', { name: 'Назад' }).tap();

    await action(page, 'Задача: сделать, отметить, убрать').tap();
    await expect(page.locator('.row', { hasText: 'Часть вторая' }).locator('.bullet.todo')).toHaveCount(1);
    await action(page, 'Отменить').tap();
    await expect(page.locator('.bullet.todo')).toHaveCount(0);
    // Redo is rare: behind "Ещё".
    await action(page, 'Ещё').tap();
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

  test('"Ещё" swaps in bold and italic; picking one brings the main set back', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    const main = page.locator('.editbar-main');
    const formats = page.locator('.editbar-extra');
    // The main set fits the phone without scrolling.
    expect(await main.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(formats).toHaveAttribute('inert', '');
    await action(page, 'Ещё').tap();
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

    await action(page, 'Ещё').tap();
    await formats.getByRole('button', { name: 'Назад' }).tap();
    await expect(main).not.toHaveAttribute('inert', '');
    await expect(editing(page)).toHaveText('Том **второй**');
  });

  test('the clock button puts the current time at the caret', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 19, 23, 40));
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    await page.keyboard.press('Control+Home');
    await action(page, 'Ещё').tap();
    await action(page, 'Время').tap();
    await expect(editing(page)).toHaveText('23:40Том второй');
    await expect(editing(page)).toBeFocused();
    await page.keyboard.type(' ');
    await expect(editing(page)).toHaveText('23:40 Том второй');
  });

  test('a link is one press, a mirror is in "Ещё": the caret between the brackets, and the suggestions open', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await keyboard(page, true);
    await action(page, 'Ещё').tap();
    await action(page, 'Зеркало').tap();
    await expect(editing(page)).toHaveText('(())');
    const mirrors = page.getByRole('listbox', { name: 'Зеркала' });
    await expect(mirrors).toBeVisible();
    // The set went back to the main one after the pick.
    await expect(page.locator('.editbar-extra')).toHaveAttribute('inert', '');
    await page.keyboard.type('Часть втор');
    await mirrors.getByRole('option').first().tap();
    await expect(page.locator('.row.mirror')).toHaveCount(2);

    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' см. ');
    await action(page, 'Ссылка').tap();
    await expect(editing(page)).toHaveText('Том второй см. [[]]');
    await expect(page.getByRole('listbox', { name: 'Ссылки' })).toBeVisible();

    // In a note a mirror is just brackets: its button is off there.
    await action(page, 'Заметка').tap();
    await action(page, 'Ещё').tap();
    await expect(action(page, 'Зеркало')).toBeDisabled();
  });

  test('# starts a tag, a space before it after a word, and offers the tags there are', async ({ page }) => {
    await edit(page, 'Том второй');
    await keyboard(page, true);
    await action(page, 'Тег').tap();
    await expect(editing(page)).toHaveText('Том второй #');
    const tags = page.getByRole('listbox', { name: 'Теги' });
    await expect(tags.getByRole('option')).toHaveText([/#салон/, /#шерер/]);
    await tags.getByRole('option', { name: /#шерер/ }).tap();
    await expect(editing(page)).toHaveText(/^Том второй #шерер/);
    // After a space, or at the very start, just the #.
    await page.keyboard.press('Control+Home');
    await action(page, 'Тег').tap();
    await expect(editing(page)).toHaveText(/^#Том второй/);
  });

  test('"Удалить" in "Ещё" takes the bullet with what is inside it; undo brings it back', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Часть первая' }).tap();
    await keyboard(page, true);
    await action(page, 'Ещё').tap();
    await action(page, 'Удалить').tap();
    expect(await outline(page)).toEqual(['Том первый', '  Часть вторая', 'Том второй']);
    // The keyboard stays, on the row above.
    await expect(editing(page)).toHaveText('Том первый');
    await expect(bar(page)).toBeVisible();
    await action(page, 'Отменить').tap();
    expect(await outline(page)).toEqual(DEMO);
  });

  test('the main set: nine buttons a finger wide, in four groups — the tree, the bullet, typing, history', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    const main = page.locator('.editbar-main');
    const names = await main.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
    expect(names).toEqual(['Вынести', 'Вложить', 'Переместить', 'Задача: сделать, отметить, убрать', 'Заметка', 'Тег', 'Ссылка', 'Отменить', 'Ещё']);
    await expect(main.locator('.editbar-sep')).toHaveCount(3);
    for (const b of await main.getByRole('button').all()) expect((await b.boundingBox())!.width).toBeGreaterThanOrEqual(43);
  });

  test('the main set fits a small phone; a wider set scrolls under a finger, "Назад" staying put', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 19, 23, 40));
    await page.setViewportSize({ width: 320, height: 800 });
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await page.setViewportSize({ width: 320, height: 480 });
    await expect(bar(page)).toBeVisible();
    const main = page.locator('.editbar-main');
    expect(await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(main).not.toHaveClass(/more/);

    await action(page, 'Ещё').tap();
    const insert = page.locator('.editbar-extra');
    expect(await insert.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(insert).toHaveClass(/more/);
    const back = insert.getByRole('button', { name: 'Назад' });
    const left = async () => Math.round((await back.boundingBox())!.x - (await insert.boundingBox())!.x);
    // Once the set has slid in: "Назад" at its left edge, before and after scrolling.
    await expect.poll(left).toBe(0);
    await insert.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect(insert).not.toHaveClass(/more/);
    // Sticky settles on the frame after the scroll.
    await expect.poll(left).toBe(0);
    await page.keyboard.press('Control+Home');
    await action(page, 'Время').tap();
    await expect(editing(page)).toHaveText('23:40Том второй');
    // Opened again, the set starts at its beginning.
    await action(page, 'Ещё').tap();
    expect(await insert.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  test('quick taps between the sets, while they slide, leave the bar in place', async ({ page }) => {
    await page.locator('.row .text', { hasText: 'Том второй' }).tap();
    await keyboard(page, true);
    await action(page, 'Ещё').tap();
    await page.locator('.editbar-extra').getByRole('button', { name: 'Назад' }).tap();
    // No waiting for the slide: the next set at once.
    await action(page, 'Переместить').tap();
    const move = page.locator('.editbar-move');
    const left = async () => Math.round((await move.getByRole('button', { name: 'Назад' }).boundingBox())!.x);
    await expect.poll(left).toBe(8);
    expect(await page.locator('.editbar').evaluate((el) => el.scrollLeft)).toBe(0);
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

  test('a tapped button does not stay lit: no hover on a touch screen', async ({ page }) => {
    // A stored document opens on today, with ‹ › beside the path.
    await page.goto('/?db=hover');
    const next = page.locator('.period-step').last();
    await next.tap();
    await expect(next).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const crumb = page.locator('.crumb').first();
    await crumb.tap();
    await expect(page.locator('.crumb').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });

  test('small buttons are a finger wide to hit, looking the same', async ({ page }) => {
    expect((await page.locator('.brand').boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect((await page.locator('.crumb').first().boundingBox())!.height).toBeGreaterThanOrEqual(36);
    // The "+" is drawn 24px; a tap just beside it still adds a bullet.
    const add = (await page.getByRole('button', { name: 'Новый пункт' }).boundingBox())!;
    expect(add.width).toBe(24);
    await page.touchscreen.tap(add.x + add.width / 2, add.y + add.height + 8);
    expect(await outline(page)).toEqual([...DEMO, '']);
  });

  test('fields are 16px at least, so a phone does not zoom in on them', async ({ page }) => {
    await expect(page.locator('.search')).toHaveCSS('font-size', '16px');
    await page.locator('.row .text', { hasText: 'Так говорила' }).tap();
    await page.keyboard.press('Control+Shift+Backspace');
    await page.locator('.menu-button').tap();
    await page.getByRole('menuitem', { name: /Корзина/ }).tap();
    await expect(page.locator('.trash-filter')).toHaveCSS('font-size', '16px');
    await page.locator('.menu-button').tap();
    await page.getByRole('menuitem', { name: 'Записать в Inbox' }).tap();
    await expect(page.locator('.capture-input')).toHaveCSS('font-size', '16px');
  });

  test('the search field keeps its room: the count is a bare number', async ({ page }) => {
    await page.locator('.search').tap();
    await page.keyboard.type('#шерер');
    await expect(page.locator('.searchbar .count')).toHaveText('1');
    await expect(page.locator('.searchbar .count')).toHaveAttribute('title', '1 bullet');
  });

  test('on a 320px phone the menu stays inside the window; long items wrap', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    // A stored document: its menu has the longest items (sync, backup).
    await page.goto('/?db=menu&empty');
    await page.getByRole('button', { name: 'Меню документа' }).tap();
    const menu = page.getByRole('menu');
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await menu.getByRole('menuitem').evaluateAll((items) => items.filter((b) => b.scrollWidth > b.clientWidth).length)).toBe(0);
  });

  test('the menu speaks of gestures, not keys', async ({ page }) => {
    await page.getByRole('button', { name: 'Меню документа' }).tap();
    await expect(page.locator('.menu .hint', { hasText: /Ctrl|\?/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Жесты и клавиши' }).tap();
    const panel = page.getByRole('dialog', { name: 'Жесты и клавиши' });
    await expect(panel.locator('h3').first()).toHaveText('Касания');
    await expect(panel).toContainText('поднять пункт и перетащить');
    // The arrows stand at the end of the row on a touch screen.
    await expect(panel).toContainText('стрелка в конце строки');
    // The keys are still listed, for a keyboard attached to the phone.
    await expect(panel).toContainText('вложить / вынести');
    expect(await panel.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
    // A pointer's doing is said in words, not cut into keycaps; no keycap sticks out of its column.
    await expect(panel.locator('kbd', { hasText: /^(клик|знак)$/ })).toHaveCount(0);
    await expect(panel.locator('dt.gesture', { hasText: 'клик по вертикальной линии' })).toHaveCount(1);
    expect(await panel.locator('dt').evaluateAll((ds) => ds.filter((d) => d.scrollWidth > d.clientWidth + 1).length)).toBe(0);
    // The descriptions of every section stand in one column.
    expect(new Set(await panel.locator('dd').evaluateAll((ds) => ds.map((d) => Math.round(d.getBoundingClientRect().x)))).size).toBe(1);
  });

  test('fold arrows show without hover, stand in one column at the end of the rows, and fold at a tap', async ({ page }) => {
    const toggle = page.locator('.row', { hasText: 'Том первый' }).locator('.toggle');
    await expect(toggle).toHaveCSS('opacity', '1');
    // One column at the right, whatever the depth; the text wraps short of it.
    const inner = (await page.locator('.row', { hasText: 'Часть первая' }).locator('.toggle').boundingBox())!;
    const box = (await toggle.boundingBox())!;
    expect(inner.x).toBeCloseTo(box.x, 0);
    const row = (await page.locator('.row', { hasText: 'Том первый' }).boundingBox())!;
    expect(box.x + box.width).toBeCloseTo(row.x + row.width, 0);
    const long = page.locator('.row', { hasText: 'Eh bien' });
    const text = (await long.locator('.text').boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(inner.x);
    // The bullet, on the left, still zooms; the finger may land a little beside the arrow.
    await page.touchscreen.tap(box.x + box.width + 3, box.y + box.height / 2);
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

test.describe('open tasks under a bullet', () => {
  test('a folded bullet shows its first open task above its note; ticking it brings the next; unfolded, it goes', async ({ page }) => {
    for (const t of ['Eh bien', 'Анна Павловна']) {
      await edit(page, t);
      await page.keyboard.press('Control+l');
    }
    await edit(page, 'Часть первая');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('созвон в пятницу');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const row = page.locator('.row', { hasText: 'Часть первая' }).first();
    // Open: the tasks show in the list, nothing under the bullet.
    await expect(row.locator('.pending')).toHaveCount(0);
    await row.locator('.toggle').click();
    await expect(row.locator('.pending-text')).toContainText('Eh bien');
    await expect(row.locator('.pending-more')).toHaveText('+1');
    // The task above the note, the note a line below.
    const order = await row.locator('.pending, .note').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]));
    expect(order).toEqual(['pending', 'note']);
    // Ticked from here: the next one, top first, takes its place.
    await row.locator('.pending-box').click();
    await expect(row.locator('.pending-text')).toContainText('Анна Павловна');
    await expect(row.locator('.pending-more')).toHaveCount(0);
    await row.locator('.pending-box').click();
    await expect(row.locator('.pending')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(row.locator('.pending-text')).toContainText('Анна Павловна');
  });

  test('a link and a mirror show the open task of the bullet they lead to; its text leads to the task', async ({ page }) => {
    await edit(page, 'Анна Павловна');
    await page.keyboard.press('Control+l');
    await edit(page, 'Том второй');
    await page.keyboard.type(' см. [[Часть первая');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const link = page.locator('.row', { hasText: 'Том второй' });
    await expect(link.locator('.pending-text')).toContainText('Анна Павловна');
    // A mirror, folded.
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Часть перв');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const mirror = page.locator('.row.mirror').last();
    await mirror.locator('.toggle').click();
    await expect(mirror.locator('.pending-text')).toContainText('Анна Павловна');
    // The text leads to where the task is, the caret at its end.
    await link.locator('.pending-text').click();
    await expect(page.locator('.zoom-title')).toHaveText('Часть первая');
    await expect(editing(page)).toContainText('Анна Павловна');
  });
});

test.describe('templates', () => {
  test('a bullet tagged #template is offered for /: what is inside it comes in at the row\'s level, without its own bullet; tasks unchecked', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Встреча #template');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Повестка');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Итоги');
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Escape');

    // In an empty bullet: it takes the first, the rest follow at its level.
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/встр');
    const option = page.getByRole('option', { name: /Встреча/ });
    await expect(option).toContainText('шаблон');
    await page.keyboard.press('Enter');
    await expect(editing(page)).toHaveText('Повестка');
    expect((await outline(page)).slice(4, 8)).toEqual(['  Часть вторая', '  Повестка', '  Итоги', 'Том второй']);
    // Copied unchecked, a task still.
    const copy = page.locator('.row', { hasText: 'Итоги' }).first();
    await expect(copy.locator('.bullet')).toHaveClass(/todo/);
    await expect(copy).not.toHaveClass(/done/);

    // In a bullet with text: it all comes in after it, and /template lists them all.
    await page.keyboard.press('Escape');
    await edit(page, 'Часть первая');
    await page.keyboard.type(' /template');
    await expect(page.getByRole('option', { name: /Встреча/ })).toHaveCount(1);
    await page.getByRole('option', { name: /Встреча/ }).click();
    await expect(editing(page)).toHaveText('Повестка');
    expect((await outline(page)).slice(1, 6)).toEqual(['  Часть первая ', '    ' + DEMO[2].trim(), '    ' + DEMO[3].trim(), '  Повестка', '  Итоги']);
    // One undo step takes it back.
    await page.keyboard.press('Control+z');
    expect((await outline(page)).slice(1, 5)).toEqual(['  Часть первая /template', '    ' + DEMO[2].trim(), '    ' + DEMO[3].trim(), '  Часть вторая']);
  });

  test('no templates yet: /template says how to make one', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.type(' /templ');
    await expect(page.getByRole('option', { name: /Шаблонов нет/ })).toHaveCount(1);
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

  test('a retitled bullet takes its links along once the caret leaves it; one undo step brings the old ones back', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('см. [[Часть вторая]] и [[Том первый]]');
    await page.keyboard.press('Escape');

    await edit(page, 'Часть вторая');
    await page.keyboard.type(' (Шерер)');
    // While the title is typed, links stay as they are.
    await expect(page.locator('.row .link').first()).toHaveText('Часть вторая');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.row .link')).toHaveText(['Часть вторая (Шерер)', 'Том первый']);
    await expect(page.locator('.toast')).toContainText('Ссылки на «Часть вторая (Шерер)» обновлены в 1 пункте');
    await page.locator('.row .link').first().click();
    await expect(crumbs(page)).toHaveText(['Главная', 'Том первый', 'Часть вторая (Шерер)']);

    await page.goBack();
    await expect(crumbs(page)).toHaveText(['Главная']);
    // Undo: the old links, the caret right in that bullet.
    await page.keyboard.press('Control+z');
    await expect(editing(page)).toHaveText('см. [[Часть вторая]] и [[Том первый]]');
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

  test('a link to nothing, with an Inbox: its bullet is made last there once followed, and opened; undo takes it out', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Inbox');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Старое');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('[[Новая тема]]');
    await page.keyboard.press('Escape');
    // Writing the link makes nothing.
    await expect(page.locator('.row')).toHaveCount(DEMO.length + 3);
    await expect(page.locator('.row', { hasText: /^Новая тема$/ })).toHaveCount(0);
    await page.locator('.row .link').click();
    await expect(page.locator('.zoom-title')).toHaveText('Новая тема');
    await expect(crumbs(page)).toHaveText(['Главная', 'Inbox', 'Новая тема']);
    await page.locator('.crumbs .crumb', { hasText: 'Inbox' }).click();
    expect(await outline(page)).toEqual(['Старое', 'Новая тема']);
    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual(['Старое']);
  });
});

test.describe('backlinks', () => {
  const chips = (page: Page) => page.getByRole('navigation', { name: 'Ссылки сюда' }).getByRole('button');
  const title = (page: Page) => page.locator('.zoom-title');

  test('under a bullet linked to: a chip per place, the way back first; a chip leads there, caret on the link', async ({ page }) => {
    // Two places link to "Часть вторая": under "Том второй", and at the top level.
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('см. [[Часть вторая]]');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.add').click();
    await page.keyboard.type('и [[Часть вторая]]');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Followed from "Том второй": that place comes first, marked as the way back.
    await page.locator('.row', { hasText: 'см.' }).locator('.link').click();
    await expect(title(page)).toHaveText('Часть вторая');
    await expect(chips(page)).toHaveText(['←Том второй', 'Главная']);
    await expect(chips(page).first()).toHaveClass(/back/);

    // Another place: there, with the caret right after the link.
    await chips(page).filter({ hasText: 'Главная' }).click();
    await expect(title(page)).toHaveCount(0);
    await expect(editing(page)).toHaveText('и [[Часть вторая]]');
    expect(await editing(page).evaluate(() => getSelection()!.anchorOffset)).toBe('и [[Часть вторая]]'.length);
    await page.keyboard.press('Escape');

    // Followed from the top level now: the way back is "Главная".
    await page.locator('.row', { hasText: 'и [[' }).locator('.link').click();
    await expect(chips(page)).toHaveText(['←Главная', 'Том второй']);
    await chips(page).filter({ hasText: 'Том второй' }).click();
    await expect(title(page)).toHaveText('Том второй');
    await expect(editing(page)).toHaveText('см. [[Часть вторая]]');
  });

  test('no links here, no backlinks', async ({ page }) => {
    await page.locator('.row', { hasText: 'Часть первая' }).locator('.bullet').click();
    await expect(title(page)).toHaveText('Часть первая');
    await expect(page.getByRole('navigation', { name: 'Ссылки сюда' })).toHaveCount(0);
  });
});

test.describe('web addresses', () => {
  test('an address in the text opens in the browser; the row is not edited; a click beside it edits', async ({ page, context }) => {
    await context.route('https://example.com/**', (route) => route.fulfill({ body: 'ok', contentType: 'text/plain' }));
    await edit(page, 'Том второй');
    await page.keyboard.type(' — см. https://example.com/a_b_c.');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const url = page.locator('.row', { hasText: 'Том второй' }).locator('a.url');
    await expect(url).toHaveText('https://example.com/a_b_c');
    await expect(url).toHaveAttribute('href', 'https://example.com/a_b_c');
    await expect(url).toHaveAttribute('target', '_blank');
    // No italic made of the address's underscores.
    await expect(page.locator('.row', { hasText: 'Том второй' }).locator('.md-italic')).toHaveCount(0);
    const [popup] = await Promise.all([page.waitForEvent('popup'), url.click()]);
    await expect.poll(() => popup.url()).toBe('https://example.com/a_b_c');
    await popup.close();
    await expect(editing(page)).toHaveCount(0);
    await page.locator('.row .text', { hasText: 'Том второй' }).click({ position: { x: 5, y: 5 } });
    await expect(editing(page)).toBeFocused();
  });
});

test.describe('mirrors', () => {
  const list = (page: Page) => page.getByRole('listbox', { name: 'Зеркала' });
  const crumbs = (page: Page) => page.locator('.crumbs .crumb');

  test('(( offers bullets; taking one makes two copies: a diamond on each, either one edits both, a dot leads to where it lives', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((');
    await expect(editing(page)).toHaveText('(())');
    await expect(list(page)).toBeVisible();
    await page.keyboard.type('Часть втор');
    await page.keyboard.press('Enter');
    await expect(list(page)).toHaveCount(0);
    const copies = page.locator('.row.mirror');
    await expect(copies).toHaveCount(2);
    await expect(copies.locator('.bullet')).toHaveClass([/mirror/, /mirror/]);
    await expect(editing(page)).toHaveText('Часть вторая');

    // Typed in the new copy, it changes in both.
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' (зеркало)');
    await page.keyboard.press('Escape');
    await expect(page.locator('.row.mirror .text')).toHaveText(['Часть вторая (зеркало)', 'Часть вторая (зеркало)']);
    // And in the first one too.
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(page.locator('.row.mirror .text')).toHaveText(['Часть вторая (зеркало', 'Часть вторая (зеркало']);

    // A dot leads to where the bullet lives in the outline.
    await copies.last().locator('.bullet').click();
    await expect(crumbs(page)).toHaveText(['Главная', 'Том первый', 'Часть вторая (зеркало']);
  });

  test('a copy shows everything under it; edits there show in every copy; folding is each copy\'s own', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Том перв');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    expect(await outline(page)).toEqual([...DEMO, ...DEMO.slice(0, 5)]);
    await expect(page.locator('.row.mirror')).toHaveCount(2);

    // Enter at the end of a bullet inside the copy: the new bullet shows in both, edited in this one.
    const inMirror = page.locator('.row[data-id*="/"]', { hasText: 'Часть вторая' });
    await inMirror.locator('.text').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Часть третья');
    await expect(page.locator('.row[data-id*="/"] .text[contenteditable]')).toHaveText('Часть третья');
    await expect(page.locator('.row .text', { hasText: 'Часть третья' })).toHaveCount(2);
    expect((await outline(page)).slice(0, 7)).toEqual([...DEMO.slice(0, 5), '  Часть третья', 'Том второй']);

    // A bullet folded inside one copy stays open in the other, and back.
    await page.keyboard.press('Escape');
    const top = [...DEMO.slice(0, 5), '  Часть третья', 'Том второй'];
    await page.locator('.row[data-id*="/"]', { hasText: 'Часть первая' }).locator('.toggle').click();
    expect(await outline(page)).toEqual([...top, 'Том первый', '  Часть первая', '  Часть вторая', '  Часть третья']);
    await page.locator('.row:not([data-id*="/"])', { hasText: 'Часть первая' }).locator('.toggle').click();
    expect(await outline(page)).toEqual(['Том первый', '  Часть первая', '  Часть вторая', '  Часть третья', 'Том второй', 'Том первый', '  Часть первая', '  Часть вторая', '  Часть третья']);
    await page.locator('.row[data-id*="/"]', { hasText: 'Часть первая' }).locator('.toggle').click();
    expect(await outline(page)).toEqual(['Том первый', '  Часть первая', '  Часть вторая', '  Часть третья', 'Том второй', ...top.slice(0, 6)]);

    // The copy folds on its own too.
    await page.locator('.row.mirror').last().locator('.toggle').click();
    expect(await outline(page)).toEqual(['Том первый', '  Часть первая', '  Часть вторая', '  Часть третья', 'Том второй', 'Том первый']);

    // Backspace at the start of a copy takes out that copy alone: the other keeps the title and bullets, now a plain bullet.
    await page.locator('.row.mirror').last().locator('.text').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.row.mirror')).toHaveCount(0);
    expect(await outline(page)).toEqual(['Том первый', '  Часть первая', '  Часть вторая', '  Часть третья', 'Том второй']);
    await expect(editing(page)).toHaveText('Том второй');
  });

  test('deleting the copy that lives in the outline leaves the other with everything', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Том перв');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.locator('.row .text', { hasText: 'Том первый' }).first().click();
    await page.keyboard.press('Control+Shift+Backspace');
    expect(await outline(page)).toEqual(['Том второй', ...DEMO.slice(0, 5)]);
    await expect(page.locator('.row.mirror')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    expect(await outline(page)).toEqual([...DEMO, ...DEMO.slice(0, 5)]);
    await expect(page.locator('.row.mirror')).toHaveCount(2);
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
    await expect(page.locator('.row.mirror')).toHaveCount(2);
    await expect(page.locator('.row.mirror .text')).toHaveText(['Том первый', 'Том первый']);
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

  test('a mirror of nothing yet, with an Inbox: the original is made last there, by the suggestion or by closing ))', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Inbox');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Новая тема');
    const create = page.getByRole('option', { name: 'Создать «Новая тема» в Inbox' });
    await expect(create).toHaveCount(1);
    await create.click();
    await expect(page.locator('.row.mirror .text')).toHaveText(['Новая тема', 'Новая тема']);
    expect(await outline(page)).toEqual([...DEMO, 'Inbox', '  Новая тема', 'Новая тема']);
    await page.keyboard.press('Escape');
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Вторая))');
    await expect(page.locator('.row.mirror .text')).toHaveText(['Вторая', 'Новая тема', 'Вторая', 'Новая тема']);
    expect(await outline(page)).toEqual([...DEMO, 'Вторая', 'Inbox', '  Новая тема', '  Вторая', 'Новая тема']);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.row.mirror')).toHaveCount(2);
    expect((await outline(page)).filter((r) => r.trim() === 'Вторая')).toEqual([]);
    // An existing title gets no such offer.
    await edit(page, 'Том второй');
    await page.keyboard.press('Enter');
    await page.keyboard.type('((Том второй');
    await expect(page.getByRole('option', { name: 'Том второй' })).toHaveCount(1);
    await expect(page.getByRole('option', { name: /Создать/ })).toHaveCount(0);
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
  test('a bullet folded under a copy stays so there after a reload, open in the other', async ({ page }) => {
    await page.goto('/?db=e2e-folds&empty');
    await page.locator('.row .text').first().click();
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('c');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('((a');
    await page.getByRole('option', { name: /^a/ }).first().click();
    await page.keyboard.press('Escape');
    expect(await outline(page)).toEqual(['a', '  b', '    c', 'a', '  b', '    c']);
    await page.locator('.row[data-id*="/"]', { hasText: 'b' }).locator('.toggle').click();
    expect(await outline(page)).toEqual(['a', '  b', '    c', 'a', '  b']);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(5);
    expect(await outline(page)).toEqual(['a', '  b', '    c', 'a', '  b']);
  });

  test('edits survive a reload', async ({ page }) => {
    await page.goto('/?db=e2e&empty');
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
    await page.goto('/?db=e2e-tabs&empty');
    await expect(page.locator('.row')).toHaveCount(1);
    await page.locator('.row .text').click();
    await page.keyboard.type('из первой вкладки');
    await page.waitForTimeout(500); // writes are batched for 300 ms

    const second = await context.newPage();
    await second.goto('/?db=e2e-tabs&empty');
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
    await page.goto('/?db=e2e&empty');
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

  test('200k bullets: "Главная" folds ~700 chapters in about a frame', async ({ page }) => {
    await page.goto('/?sample=200000');
    await expect(page.locator('.row').first()).toBeVisible();
    await page.waitForTimeout(1000);
    const ms = await page.locator('.crumbs .crumb', { hasText: 'Главная' }).evaluate(async (el) => {
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
