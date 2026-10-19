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
    await expect(crumbs(page)).toHaveText(['Главная', 'Том первый']);
    expect(await outline(page)).toEqual([DEMO[2].trim(), DEMO[3].trim()]);
    expect(new URL(page.url()).hash).toMatch(/^#\/.+/);

    await page.goBack();
    await expect(title(page)).toHaveCount(0);
    expect(await outline(page)).toEqual(DEMO);
    await page.goForward();
    await expect(title(page)).toHaveText('Часть первая');

    await crumbs(page).filter({ hasText: 'Том первый' }).click();
    await expect(title(page)).toHaveText('Том первый');
    await crumbs(page).filter({ hasText: 'Главная' }).click();
    expect(await outline(page)).toEqual(DEMO);
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

  test('the "+" under a zoomed-in list adds bullets without the keyboard', async ({ page }) => {
    await expect(page.locator('.add')).toHaveCount(0); // not on the home page
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
  test('Ctrl+Enter makes a task (checkbox), then checks it; Ctrl+Shift+Enter makes it plain; undo works', async ({ page }) => {
    const row = page.locator('.row', { hasText: 'Часть вторая' });
    const box = row.locator('.bullet');
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Control+Enter');
    await expect(box).toHaveClass(/todo/);
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await expect(row).not.toHaveClass(/done/);
    await page.keyboard.press('Control+Enter');
    await expect(row).toHaveClass(/done/);
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Control+z');
    await expect(row).not.toHaveClass(/done/);
    await page.keyboard.press('Control+Shift+Enter');
    await expect(box).not.toHaveClass(/todo/);
  });

  test('a click on the checkbox checks the task; a click on a plain bullet still zooms in', async ({ page }) => {
    await edit(page, 'Том второй');
    await page.keyboard.press('Control+Enter');
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

  test('Ctrl+O hides completed bullets: completing one moves the caret on; the choice is remembered', async ({ page }) => {
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Control+o');
    await expect(page.locator('.toast')).toContainText('Выполненные скрыты');
    await page.keyboard.press('Control+Enter'); // a task now, still open: stays
    expect(await outline(page)).toEqual(DEMO);
    await page.keyboard.press('Control+Enter');
    expect(await outline(page)).toEqual(DEMO.filter((l) => !l.includes('Часть вторая')));
    await expect(editing(page)).toHaveText('Том второй');
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(DEMO.length); // ?demo starts fresh, nothing is completed
    await page.locator('.row .text', { hasText: 'Том второй' }).click();
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Control+Enter');
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
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Control+Enter');
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

  test('Shift+↓ selects; Tab, Ctrl+Enter, copy, Delete and undo act on the block', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await edit(page, 'Часть вторая');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await selected(page)).toEqual(['Часть вторая', 'Том второй']);
    await expect(editing(page)).toHaveCount(0);

    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.row .bullet.todo')).toHaveCount(2);
    await page.keyboard.press('Control+Enter');
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
  const DARK = 'rgb(28, 27, 24)';

  test('follows the system until picked; the pick survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?demo');
    expect(await background(page)).toBe(DARK);
    await expect(page.locator('.theme-toggle')).toHaveAttribute('aria-label', 'Дневная тема');

    await page.locator('.theme-toggle').click();
    // The switch runs inside a view transition: it lands on the next frame.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await background(page)).toBe(CREAM);
    await expect(page.locator('.theme-toggle')).toHaveAttribute('aria-label', 'Ночная тема');

    await page.reload();
    expect(await background(page)).toBe(CREAM);
    // A system change no longer overrides the pick.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await background(page)).toBe(CREAM);
  });
});

test.describe('phone screen', () => {
  const rightmost = (page: Page) =>
    page.locator('.topbar > *, .topbar-actions > *').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));

  test('the header fits; the theme switch moves into the menu and back', async ({ page }) => {
    // A OnePlus 8 held upright, then the narrowest phones.
    for (const width of [412, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.locator('.theme-toggle')).toHaveCount(0);
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
    await page.keyboard.press('Escape');

    // Turned sideways or on a laptop the switch is back in the header, not in the menu.
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(page.locator('.theme-toggle')).toHaveAttribute('aria-label', 'Дневная тема');
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await expect(page.getByRole('menuitem', { name: /тема/ })).toHaveCount(0);
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

  test('a bar under the list does what Tab, Ctrl+Enter and Ctrl+Z do; the keyboard stays', async ({ page }) => {
    await expect(bar(page)).toHaveCount(0);
    await page.locator('.row .text', { hasText: 'Часть вторая' }).tap();
    await expect(editing(page)).toBeFocused();
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

    await action(page, 'Готово').tap();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.locator('[contenteditable]')).toHaveCount(0);
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
