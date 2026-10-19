import { expect, test, type Page } from '@playwright/test';

const SYNC = 'http://127.0.0.1:5182';
const PASS = 'очень длинный пароль';

const rows = (page: Page) => page.locator('.row .text').evaluateAll((els) => els.map((e) => e.textContent));

async function openSyncDialog(page: Page) {
  await page.locator('.topbar [aria-label="Меню документа"]').click();
  await page.getByRole('menuitem', { name: /Синхронизация/ }).click();
  await expect(page.locator('.sync-dialog')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('two browsers share one encrypted document through the server', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto('/?db=e2e-sync-a');
  await expect(a.locator('.row')).toHaveCount(1);
  await a.locator('.row .text').click();
  await a.keyboard.type('общий пункт');
  await a.waitForTimeout(400);

  // A creates the shared document.
  await openSyncDialog(a);
  await a.locator('.sync-dialog input[type="url"]').fill(SYNC);
  const passwords = a.locator('.sync-dialog input[type="password"]');
  await passwords.nth(0).fill(PASS);
  await passwords.nth(1).fill(PASS);
  await a.getByRole('button', { name: 'Создать и включить' }).click();
  await expect(a.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30_000 });
  await expect(a.locator('.sync-indicator')).toBeVisible();
  await openSyncDialog(a);
  const code = (await a.locator('.doc-code').textContent())!.trim();
  expect(code.length).toBeGreaterThan(10);
  await a.keyboard.press('Escape');

  // Locally, only ciphertext is stored now.
  const stored = await a.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openDb, readAll } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db.ts');
    const db = await openDb('e2e-sync-a');
    const all = await readAll(db);
    db.close();
    const enc = (x: unknown) => typeof x === 'object' && x !== null && (x as { enc?: number }).enc === 1;
    return { snapshot: enc(all.snapshot), batches: all.batches.map(enc) };
  });
  expect(stored.snapshot).toBe(true);
  expect(stored.batches.every(Boolean)).toBe(true);

  // B joins with the code and the passphrase; its own document is replaced.
  const b = await (await browser.newContext()).newPage();
  await b.goto('/?db=e2e-sync-b');
  await expect(b.locator('.row')).toHaveCount(1);
  await openSyncDialog(b);
  await b.getByRole('tab', { name: 'Подключиться к существующему' }).click();
  await b.locator('.sync-dialog input[type="url"]').fill(SYNC);
  await b.locator('.sync-dialog input[type="text"]').fill(code);
  await b.locator('.sync-dialog input[type="password"]').fill(PASS);
  await b.getByRole('button', { name: 'Подключиться' }).click();
  await expect(b.locator('.row .text').first()).toHaveText('общий пункт', { timeout: 30_000 });
  await expect(b.locator('.sync-indicator')).toBeVisible();

  // B types; A gets it through the event stream. A edits; B gets it.
  await b.locator('.row .text').first().click();
  await b.keyboard.press('Control+End');
  await b.keyboard.press('Enter');
  await b.keyboard.type('с другого устройства');
  await expect.poll(() => rows(a), { timeout: 15_000 }).toEqual(['общий пункт', 'с другого устройства']);
  await a.locator('.row .text').first().click();
  await a.keyboard.press('Control+End');
  await a.keyboard.type(' — правка');
  await expect.poll(() => rows(b), { timeout: 15_000 }).toEqual(['общий пункт — правка', 'с другого устройства']);

  // A move on A and an edit of the same bullet on B both survive.
  await a.locator('.row .text', { hasText: 'с другого' }).click();
  await a.keyboard.press('Tab');
  await b.locator('.row .text', { hasText: 'с другого' }).click();
  await b.keyboard.press('Control+End');
  await b.keyboard.type(', дописано');
  await expect.poll(() => rows(a), { timeout: 15_000 }).toEqual(['общий пункт — правка', 'с другого устройства, дописано']);
  await expect.poll(() => b.locator('.row').last().getAttribute('data-depth'), { timeout: 15_000 }).toBe('1');

  // A reload needs no passphrase; after "forget", it does.
  await a.reload();
  await expect(a.locator('.row')).toHaveCount(2);
  await openSyncDialog(a);
  await a.getByRole('button', { name: 'Забыть пароль здесь' }).click();
  // The key is forgotten once the toast shows; a reload before that races the write.
  await expect(a.locator('.toast')).toContainText('спросят пароль');
  await a.reload();
  await expect(a.locator('.unlock')).toBeVisible();
  await a.locator('.unlock input[type="password"]').fill('не тот пароль');
  await a.getByRole('button', { name: 'Открыть' }).click();
  await expect(a.locator('.form-error')).toHaveText('Пароль не подходит', { timeout: 30_000 });
  await a.locator('.unlock input[type="password"]').fill(PASS);
  await a.getByRole('button', { name: 'Открыть' }).click();
  await expect(a.locator('.row')).toHaveCount(2, { timeout: 30_000 });
  expect(await rows(a)).toEqual(['общий пункт — правка', 'с другого устройства, дописано']);
});
