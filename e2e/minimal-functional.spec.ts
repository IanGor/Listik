import { expect, test, type Page } from '@playwright/test';

interface StoredOutline {
  lines: string[];
  task?: string;
  mirror?: { copy: string; original: string };
}

/** Load data that could already exist when a user opens the new interface. */
async function openStoredOutline(page: Page, name: string, outline: StoredOutline) {
  await page.goto('/?demo');
  await page.evaluate(async ({ name, lines, task, mirror }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { build } = (await load('/tests/helpers.ts')) as typeof import('../tests/helpers');
    const { openDb, writeSnapshot } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db');
    const { serialize } = (await load('/src/persist/serialize.ts')) as typeof import('../src/persist/serialize');
    const { plainCodec } = (await load('/src/persist/codec.ts')) as typeof import('../src/persist/codec');

    const doc = build(lines);
    if (task) doc.apply({ t: 'setTodo', id: task, from: false, to: true });
    if (mirror) doc.apply({ t: 'setMirror', id: mirror.copy, from: null, to: mirror.original });

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
    mirror: { copy: 'Копия', original: 'Общий текст' },
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
