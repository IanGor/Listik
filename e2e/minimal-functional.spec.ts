import { expect, test, type Page } from '@playwright/test';

interface StoredOutline {
  lines: string[];
  task?: string;
  mirrors?: { copy: string; original: string }[];
}

/** Load data that could already exist when a user opens the new interface. */
async function openStoredOutline(page: Page, name: string, outline: StoredOutline) {
  await page.goto('/?demo');
  await page.evaluate(async ({ name, lines, task, mirrors }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { build } = (await load('/tests/helpers.ts')) as typeof import('../tests/helpers');
    const { openDb, writeSnapshot } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db');
    const { serialize } = (await load('/src/persist/serialize.ts')) as typeof import('../src/persist/serialize');
    const { plainCodec } = (await load('/src/persist/codec.ts')) as typeof import('../src/persist/codec');

    const doc = build(lines);
    if (task) doc.apply({ t: 'setTodo', id: task, from: false, to: true });
    for (const mirror of mirrors ?? []) doc.apply({ t: 'setMirror', id: mirror.copy, from: null, to: mirror.original });

    const db = await openDb(name);
    try {
      await writeSnapshot(db, await plainCodec.encodeSnapshot(serialize(doc)));
    } finally {
      db.close();
    }
  }, { name, ...outline });
  await page.goto(`/?db=${name}&empty`);
}

test('inline formatting and internal links work in a stored outline', async ({ page }) => {
  await openStoredOutline(page, 'minimal-internal-link', {
    lines: ['**Жирный** *курсив* [[Цель]]', 'Раздел', '  Цель', '    Содержимое цели'],
  });

  const row = page.locator('.row').first();
  await expect(row.getByText('Жирный', { exact: true })).toHaveCSS('font-weight', '700');
  await expect(row.getByText('курсив', { exact: true })).toHaveCSS('font-style', 'italic');
  await row.getByText('Цель', { exact: true }).click();
  await expect(page.locator('.crumb.current')).toHaveText('Цель');
  await expect(page.locator('.row')).toHaveText('Содержимое цели');

  await page.getByRole('navigation', { name: 'Путь' }).getByRole('button', { name: 'Раздел' }).click();
  await expect(page.locator('.crumb.current')).toHaveText('Раздел');
  await expect(page.locator('.row').first().locator('.text')).toHaveText('Цель');
  await page.getByRole('button', { name: 'Главная', exact: true }).click();
  await expect(row.getByText('курсив', { exact: true })).toBeVisible();
});

test('expanded branches show guides at each level of nesting', async ({ page }) => {
  await openStoredOutline(page, 'minimal-branch-guides', {
    lines: ['Родитель', '  Дочерний пункт', '    Вложенный пункт', 'Соседняя ветка'],
  });
  const rows = page.locator('.row');
  await expect(rows.locator('.text')).toHaveText(['Родитель', 'Дочерний пункт', 'Вложенный пункт', 'Соседняя ветка']);
  const readGuides = () => rows.evaluateAll((elements) => elements.map((row) => {
    const guide = getComputedStyle(row, '::before');
    return guide.content === 'none' || guide.backgroundImage === 'none' ? 0 : parseFloat(guide.width);
  }));
  const [root, child, grandchild, sibling] = await readGuides();
  expect(root).toBe(0);
  expect(child).toBeGreaterThan(0);
  expect(grandchild).toBeGreaterThan(child);
  expect(sibling).toBe(0);
  await rows.first().getByRole('button', { name: 'Свернуть пункт' }).click();
  await expect(rows).toHaveCount(2);
  expect(await readGuides()).toEqual([0, 0]);
});

test('Shift+arrows select text by line and then extend and shrink through visible rows', async ({ page }) => {
  const parent = 'first\nother\nthird';
  await openStoredOutline(page, 'minimal-key-selection', {
    lines: ['Before', parent, '  Child [+]', '    Hidden', '  Next child', 'After'],
  });
  const rows = page.locator('.row');
  const selected = page.locator('.row.selected .text');
  const editor = rows.locator('.text[contenteditable]');
  const selectedText = () => page.evaluate(() => getSelection()?.toString());
  await rows.nth(1).locator('.text').click();
  await editor.press('Control+Home');
  for (const text of ['first\n', 'first\nother\n', parent]) {
    await page.keyboard.press('Shift+ArrowDown');
    expect(await selectedText()).toBe(text);
    await expect(editor).toBeFocused();
  }

  await page.keyboard.press('Shift+ArrowDown');
  await expect(selected).toHaveText([parent]);
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('Shift+ArrowDown');
  await expect(selected).toHaveText([parent, 'Child']);
  await page.keyboard.press('Shift+ArrowDown');
  await expect(selected).toHaveText([parent, 'Child', 'Next child']);
  await page.keyboard.press('Shift+ArrowUp');
  await expect(selected).toHaveText([parent, 'Child']);
  await page.keyboard.press('Shift+ArrowUp');
  await expect(selected).toHaveText([parent]);
  await page.keyboard.press('Shift+ArrowUp');
  await expect(selected).toHaveText(['Before', parent]);
  await page.keyboard.press('Escape');
  await expect(selected).toHaveCount(0);

  await rows.nth(1).locator('.text').click();
  await editor.press('Control+End');
  for (const text of ['\nthird', '\nother\nthird', parent]) {
    await page.keyboard.press('Shift+ArrowUp');
    expect(await selectedText()).toBe(text);
    await expect(editor).toBeFocused();
  }
  await page.keyboard.press('Shift+ArrowUp');
  await expect(selected).toHaveText([parent]);
});

test('Shift+arrows follow soft wrapping before selecting the row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const wrapped = 'word '.repeat(24).trimEnd();
  await openStoredOutline(page, 'minimal-wrapped-selection', { lines: [wrapped] });
  const editor = page.locator('.row .text[contenteditable]');
  const selected = page.locator('.row.selected .text');
  await page.locator('.row .text').click();
  await editor.press('Control+Home');
  await editor.press('ArrowRight');
  const focusLine = () => editor.evaluate((el) => {
    const selection = getSelection()!;
    const range = document.createRange();
    range.setStart(selection.focusNode!, selection.focusOffset);
    const height = parseFloat(getComputedStyle(el).lineHeight);
    return Math.floor((range.getBoundingClientRect().top - el.getBoundingClientRect().top) / height);
  });
  const first = await focusLine();
  await page.keyboard.press('Shift+ArrowDown');
  expect(await focusLine()).toBe(first + 1);
  await page.keyboard.press('Shift+ArrowDown');
  expect(await focusLine()).toBe(first + 2);
  await expect(selected).toHaveCount(0);

  await editor.press('Control+End');
  await editor.press('Shift+ArrowDown');
  await expect(selected).toHaveText([wrapped]);
});

test('keyboard selection keeps its moving endpoint in view', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 300 });
  const lines = Array.from({ length: 50 }, (_, index) => `Item ${index + 1}`);
  await openStoredOutline(page, 'minimal-selection-scroll', { lines });
  await page.getByText('Item 1', { exact: true }).click();
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.row.selected').getByText('Item 20', { exact: true })).toBeInViewport();
  await expect(page.locator('.row.selected').getByText('Item 21', { exact: true })).toHaveCount(0);
});

test('Shift+click selects the exact interval through text or a bullet dot', async ({ page }) => {
  const parent = 'Parent\nsecond line';
  await openStoredOutline(page, 'minimal-click-selection', {
    lines: ['Before', parent, '  Child', '    Grandchild', 'After'],
  });
  const rows = page.locator('.row');
  const selected = page.locator('.row.selected .text');
  const dot = (index: number) => rows.nth(index).getByRole('button', { name: 'Открыть пункт' });
  await rows.first().locator('.text').click();
  await rows.nth(1).locator('.text').click({ modifiers: ['Shift'] });
  await expect(selected).toHaveText(['Before', parent]);
  await expect(rows.locator('[contenteditable]')).toHaveCount(0);
  const style = await rows.nth(1).evaluate((row) => ({
    fill: getComputedStyle(row, '::after').backgroundColor,
    guide: getComputedStyle(row.querySelector('.body')!, '::before').width,
  }));
  expect(style.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(style.guide).toBe('1px');

  await dot(2).click({ modifiers: ['Shift'] });
  await expect(selected).toHaveText(['Before', parent, 'Child']);
  await expect(page.locator('.crumb.current')).toHaveAccessibleName('Главная');
  await page.keyboard.press('Escape');
  await expect(selected).toHaveCount(0);

  await rows.nth(2).locator('.text').click();
  await rows.nth(2).locator('.text').click({ modifiers: ['Shift'] });
  await expect(selected).toHaveText(['Child']);
  await dot(0).click({ modifiers: ['Shift'] });
  await expect(selected).toHaveText(['Before', parent, 'Child']);
  await dot(1).click();
  await expect(page.locator('.crumb.current')).toHaveText(parent);
  await expect(selected).toHaveCount(0);
});

test('tags have a theme-aware fill and stay editable as text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?db=minimal-tags&empty');
  const text = page.locator('.row .text');
  const editor = page.locator('.row .text[contenteditable]');
  await text.click();
  await editor.fill('Заметка #работа @дом');
  await editor.press('Escape');

  const tags = text.locator('.tag');
  await expect(tags).toHaveText(['#работа', '@дом']);
  for (const tag of await tags.all()) await expect(tag).toHaveCSS('box-shadow', 'none');
  const first = (await tags.first().boundingBox())!;
  const second = (await tags.last().boundingBox())!;
  expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(6);
  await expect(tags.first()).toHaveCSS('background-color', 'rgba(20, 20, 19, 0.06)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(tags.first()).toHaveCSS('background-color', 'rgba(250, 249, 245, 0.08)');
  await tags.first().click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('Заметка #работа @дом');
});

test('an unresolved link edits its source and leaves Inbox alone', async ({ page }) => {
  await openStoredOutline(page, 'minimal-unresolved-link', {
    lines: ['📥 Inbox', 'Ссылка на [[Несуществующий пункт]]'],
  });

  const row = page.locator('.row').last();
  await row.getByText('Несуществующий пункт', { exact: true }).click();
  await expect(row.locator('[contenteditable]')).toBeFocused();
  await expect(page.locator('.crumb.current')).toHaveAccessibleName('Главная');

  const inbox = page.locator('.row').filter({ hasText: '📥 Inbox' });
  await inbox.getByRole('button', { name: 'Открыть пункт' }).click();
  await expect(page.locator('.crumb.current')).toHaveText('📥 Inbox');
  await expect(page.locator('.row')).toHaveCount(0);
});

test('an existing mirror opens its children and edits the shared text', async ({ page }) => {
  await openStoredOutline(page, 'minimal-existing-mirror', {
    lines: ['Источник', '  Общий текст', '    Дочерний пункт', 'Зеркала', '  Копия'],
    mirrors: [{ copy: 'Копия', original: 'Общий текст' }],
  });

  const rows = page.locator('.row');
  const copies = rows.filter({ has: page.locator('.text', { hasText: /^Общий текст$/ }) });
  const home = page.getByRole('button', { name: 'Главная', exact: true });
  await expect(copies).toHaveCount(2);
  await copies.last().getByRole('button', { name: 'Открыть пункт' }).click();
  await expect(page.locator('.crumb.current')).toHaveText('Общий текст');
  await expect(rows.locator('.text')).toHaveText('Дочерний пункт');

  await home.click();
  await copies.last().locator('.text').click();
  const editor = rows.locator('[contenteditable]');
  await editor.fill('Обновлённый текст');
  await editor.press('Escape');
  await expect(rows.locator('.text', { hasText: /^Обновлённый текст$/ })).toHaveCount(2);

  await expect(async () => {
    const updated = await page.evaluate(async () => {
      const file = '/src/persist/idb.ts';
      const { Persistence } = (await import(/* @vite-ignore */ file)) as typeof import('../src/persist/idb');
      return (await Persistence.read('minimal-existing-mirror')).get('Общий текст').text;
    });
    expect(updated).toBe('Обновлённый текст');
  }).toPass({ timeout: 5000 });
  await page.reload();
  await expect(rows.locator('.text', { hasText: /^Обновлённый текст$/ })).toHaveCount(2);
});

test('existing tasks can be checked and unchecked by pointer and keyboard', async ({ page }) => {
  await openStoredOutline(page, 'minimal-existing-task', { lines: ['Дело'], task: 'Дело' });

  const box = page.getByRole('checkbox');
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  await expect(box).toHaveAccessibleName('Снять отметку');
  await box.press('Space');
  await expect(box).not.toBeChecked();
  await box.press('Enter');
  await expect(box).toBeChecked();
});

test('reload restores the open branch and its scroll position', async ({ page }) => {
  await openStoredOutline(page, 'minimal-reload-position', {
    lines: ['Длинная ветка [+]', ...Array.from({ length: 150 }, (_, index) => `  Пункт ${index + 1}`)],
  });

  await page.getByRole('button', { name: 'Открыть пункт' }).click();
  const scroller = page.locator('.scroller');
  await expect(scroller).toBeVisible();
  await scroller.hover();
  await page.mouse.wheel(0, 1200);
  const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
  await expect.poll(scrollTop).toBeGreaterThan(1000);
  const offset = await scrollTop();

  await page.reload();
  await expect(page.locator('.crumb.current')).toHaveText('Длинная ветка');
  await expect.poll(async () => Math.abs(await scrollTop() - offset)).toBeLessThanOrEqual(2);
});

test('Backspace and Delete remove selected bullets while keeping unselected descendants', async ({ page }) => {
  const original = ['Before', 'Parent', 'Child', 'Grandchild', 'Sibling', 'After'];
  await openStoredOutline(page, 'minimal-delete-selection', {
    lines: ['Before', 'Parent', '  Child', '    Grandchild', '  Sibling', 'After'],
  });
  const rows = page.locator('.row');
  const text = rows.locator('.text');
  for (const key of ['Backspace', 'Delete']) {
    await text.nth(1).click();
    await text.nth(2).click({ modifiers: ['Shift'] });
    await expect(page.locator('.row.selected .text')).toHaveText(['Parent', 'Child']);
    await page.keyboard.press(key);
    await expect(text).toHaveText(['Before', 'Grandchild', 'Sibling', 'After']);
    for (const row of await rows.all()) await expect(row).toHaveAttribute('data-depth', '0');
    await expect(page.locator('.row.selected')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+z');
    await expect(text).toHaveText(original);
    await expect(rows.nth(3)).toHaveAttribute('data-depth', '2');
    await expect(rows.nth(4)).toHaveAttribute('data-depth', '1');
  }
});

test('vertical arrows end a whole-bullet selection at its moving end', async ({ page }) => {
  await openStoredOutline(page, 'minimal-end-selection', { lines: ['Above', 'Anchor', 'Below'] });
  const text = page.locator('.row .text');
  for (const [key, head] of [['ArrowUp', 0], ['ArrowDown', 2]] as const) {
    await text.nth(1).click();
    await text.nth(head).click({ modifiers: ['Shift'] });
    await expect(page.locator('.row.selected')).toHaveCount(2);
    await page.keyboard.press(key);
    await expect(page.locator('.row.selected')).toHaveCount(0);
    await expect(text.nth(head)).toBeFocused();
    await expect(text).toHaveText(['Above', 'Anchor', 'Below']);
  }
});

test('deleting selected copies keeps the surviving mirror and folded descendants', async ({ page }) => {
  await openStoredOutline(page, 'minimal-delete-mirrors', {
    lines: ['Shared [+]', '  Keep first', '  Keep second', 'Selected copy [+]', 'Surviving copy [+]'],
    task: 'Shared',
    mirrors: [
      { copy: 'Selected copy', original: 'Shared' },
      { copy: 'Surviving copy', original: 'Shared' },
    ],
  });
  const rows = page.locator('.row');
  const text = rows.locator('.text');
  await expect(text).toHaveText(['Shared', 'Shared', 'Shared']);
  await text.nth(1).click();
  await text.nth(0).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  await expect(text).toHaveText(['Keep first', 'Keep second', 'Shared']);
  await expect(rows.nth(0)).toHaveAttribute('data-depth', '0');
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '0');
  await expect(rows.last().getByRole('checkbox')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  await expect(text).toHaveText(['Shared', 'Shared', 'Shared']);
  await text.nth(1).click();
  await text.nth(1).click({ modifiers: ['Shift'] });
  await expect(page.locator('.row.selected')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(text).toHaveText(['Shared', 'Shared']);
  await rows.first().getByRole('button', { name: 'Открыть пункт' }).click();
  await expect(text).toHaveText(['Keep first', 'Keep second']);
});

test('plain arrows enter the visible part of a scrolled outline and then navigate', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 390 });
  await openStoredOutline(page, 'minimal-arrow-entry', {
    lines: Array.from({ length: 160 }, (_, i) => `Bullet ${i + 1}`),
  });
  const scroller = page.locator('.scroller');
  const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
  const editor = page.locator('.row .text[contenteditable]');
  const fullyVisible = () => scroller.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll('.row')].flatMap((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom ? [row.textContent] : [];
    });
  });

  await page.getByText('Bullet 2', { exact: true }).click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  await expect(editor).toHaveText('Bullet 2');
  expect(await page.evaluate(() => getSelection()?.focusOffset)).toBe(4);
  await page.keyboard.press('Escape');

  await scroller.evaluate((el) => { el.scrollTop = 2300; });
  await expect.poll(async () => (await fullyVisible())[0]).toMatch(/^Bullet [5-9]\d$/);
  const expected = await fullyVisible();
  const before = await scrollTop();
  await page.keyboard.press('ArrowDown');
  await expect(editor).toHaveText(expected[0]!);
  expect(await scrollTop()).toBe(before);
  await page.keyboard.press('ArrowDown');
  await expect(editor).toHaveText(expected[1]!);
  await page.keyboard.press('Escape');

  await scroller.evaluate((el) => { el.scrollTop = 3500; });
  await expect.poll(async () => (await fullyVisible()).at(-1)).toMatch(/^Bullet 1\d\d$/);
  const last = (await fullyVisible()).at(-1)!;
  const farther = await scrollTop();
  await page.keyboard.press('ArrowUp');
  await expect(editor).toHaveText(last);
  expect(await scrollTop()).toBe(farther);
});

test('arrows enter a long bullet at a visible line without moving the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 390 });
  const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
  await openStoredOutline(page, 'minimal-arrow-entry-long', { lines: [lines] });
  const scroller = page.locator('.scroller');
  const editor = page.locator('.row .text[contenteditable]');
  for (const [arrow, top] of [['ArrowDown', 900], ['ArrowUp', 1600]] as const) {
    const before = await scroller.evaluate((el, at) => {
      el.scrollTop = at;
      return el.scrollTop;
    }, top);
    expect(before).toBe(top);
    await page.keyboard.press(arrow);
    await expect(editor).toBeFocused();
    expect(await scroller.evaluate((el) => {
      const caret = getSelection()!.getRangeAt(0).getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return caret.height > 0 && caret.top >= box.top && caret.bottom <= box.bottom;
    })).toBe(true);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);
    await page.keyboard.press('Escape');
  }
});
