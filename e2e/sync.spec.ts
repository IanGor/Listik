import { expect, test, type Page } from '@playwright/test';

const SYNC = 'http://127.0.0.1:5182';
const PASS = 'очень длинный пароль';

const rows = (page: Page) => page.locator('.row .text').evaluateAll((els) => els.map((e) => e.textContent));

/** The menu button, once its hint tells the sync state: sync is on. */
const syncOn = (page: Page) => page.locator('.menu-button[title^="Документ. "]');

async function openSyncDialog(page: Page) {
  await page.locator('.topbar [aria-label="Меню документа"]').click();
  await page.getByRole('menuitem', { name: /Синхронизация/ }).click();
  await expect(page.locator('.sync-dialog')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('two browsers share one encrypted document through the server', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto('/?db=e2e-sync-a&empty');
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
  await expect(syncOn(a)).toBeVisible();
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
  await b.goto('/?db=e2e-sync-b&empty');
  await expect(b.locator('.row')).toHaveCount(1);
  await openSyncDialog(b);
  await b.getByRole('tab', { name: 'Подключиться к существующему' }).click();
  await b.locator('.sync-dialog input[type="url"]').fill(SYNC);
  await b.locator('.sync-dialog input[type="text"]').fill(code);
  await b.locator('.sync-dialog input[type="password"]').fill(PASS);
  await b.getByRole('button', { name: 'Подключиться' }).click();
  await expect(b.locator('.row .text').first()).toHaveText('общий пункт', { timeout: 30_000 });
  await expect(syncOn(b)).toBeVisible();

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

test('a local copy that does not open with the key is restored from the server', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto('/?db=e2e-sync-damaged&empty');
  await a.locator('.row .text').click();
  await a.keyboard.type('с сервера');
  await a.waitForTimeout(400);
  await openSyncDialog(a);
  await a.locator('.sync-dialog input[type="url"]').fill(SYNC);
  const passwords = a.locator('.sync-dialog input[type="password"]');
  await passwords.nth(0).fill(PASS);
  await passwords.nth(1).fill(PASS);
  await a.getByRole('button', { name: 'Создать и включить' }).click();
  await expect(a.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30_000 });

  // Wait until everything is on the server, then add a batch sealed with a
  // key this device does not have, as an older version could leave behind.
  // The outbox is stored sealed with the document's key: read through the vault's.
  const storedState = () => a.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openVault } = (await load('/src/sync/setup.ts')) as typeof import('../src/sync/setup.ts');
    const { dataKey } = (await load('/src/sync/crypto.ts')) as typeof import('../src/sync/crypto.ts');
    const { readSyncState } = (await load('/src/sync/engine.ts')) as typeof import('../src/sync/engine.ts');
    const opened = await openVault('e2e-sync-damaged');
    const state = opened.secret ? await readSyncState(opened.db, await dataKey(opened.secret.dek)) : undefined;
    opened.db.close();
    return state ? { head: state.head, outbox: state.outbox.length } : null;
  });
  await expect.poll(async () => (await storedState())?.outbox, { timeout: 15_000 }).toBe(0);
  await a.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openDb, done } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db.ts');
    const { encryptedCodec } = (await load('/src/persist/codec.ts')) as typeof import('../src/persist/codec.ts');
    const { dataKey } = (await load('/src/sync/crypto.ts')) as typeof import('../src/sync/crypto.ts');
    const stranger = encryptedCodec(await dataKey(crypto.getRandomValues(new Uint8Array(32))));
    const record = await stranger.encodeBatch([]);
    const db = await openDb('e2e-sync-damaged');
    const tx = db.transaction('oplog', 'readwrite');
    tx.objectStore('oplog').add(record);
    await done(tx);
    db.close();
  });

  await a.reload();
  await expect(a.locator('.unlock')).toContainText('прежним ключом');
  await a.getByRole('button', { name: 'Загрузить с сервера' }).click();
  await expect(a.locator('.row .text').first()).toHaveText('с сервера', { timeout: 30_000 });
  await expect(syncOn(a)).toBeVisible();
});

test('the sync state lives in the menu: a dot on its button while changes wait', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const a = await context.newPage();
  await a.goto('/?db=e2e-sync-phone&empty');
  await expect(a.locator('.row')).toHaveCount(1);
  await openSyncDialog(a);
  await a.locator('.sync-dialog input[type="url"]').fill(SYNC);
  const passwords = a.locator('.sync-dialog input[type="password"]');
  await passwords.nth(0).fill(PASS);
  await passwords.nth(1).fill(PASS);
  await a.getByRole('button', { name: 'Создать и включить' }).click();
  await expect(a.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30_000 });

  const dot = a.locator('.menu-button .sync-dot');
  await expect(dot).toHaveCount(0, { timeout: 15_000 });
  await a.locator('.topbar [aria-label="Меню документа"]').click();
  await expect(a.locator('.menu-note')).toContainText('Синхронизировано');
  await a.keyboard.press('Escape');

  await context.setOffline(true);
  await a.locator('.row .text').click();
  await a.keyboard.type('без сети');
  await expect(dot).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
  await expect(dot).toHaveCount(0, { timeout: 30_000 });
  await context.close();
});

test('a log with a gap opens, and the server gives back what the gap took; so does the button in the sync dialog', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto('/?db=e2e-sync-gap&empty');
  await a.locator('.row .text').click();
  await a.keyboard.type('с сервера');
  await a.waitForTimeout(400);
  await openSyncDialog(a);
  await a.locator('.sync-dialog input[type="url"]').fill(SYNC);
  const passwords = a.locator('.sync-dialog input[type="password"]');
  await passwords.nth(0).fill(PASS);
  await passwords.nth(1).fill(PASS);
  await a.getByRole('button', { name: 'Создать и включить' }).click();
  await expect(a.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30_000 });

  const outbox = () => a.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openVault } = (await load('/src/sync/setup.ts')) as typeof import('../src/sync/setup.ts');
    const { dataKey } = (await load('/src/sync/crypto.ts')) as typeof import('../src/sync/crypto.ts');
    const { readSyncState } = (await load('/src/sync/engine.ts')) as typeof import('../src/sync/engine.ts');
    const opened = await openVault('e2e-sync-gap');
    const state = opened.secret ? await readSyncState(opened.db, await dataKey(opened.secret.dek)) : undefined;
    opened.db.close();
    return state?.outbox.length ?? -1;
  });
  // A new bullet, then an edit of the first one: both on the server.
  await a.locator('.row .text').first().click();
  await a.keyboard.press('Control+End');
  await a.keyboard.press('Enter');
  // The new bullet's batch on disk before its text: the gap below takes the bullet, not its typing too.
  await a.waitForTimeout(200);
  await a.keyboard.type('раз');
  await a.locator('.row .text').first().click();
  await a.keyboard.press('Control+End');
  await a.keyboard.type('!');
  await a.keyboard.press('Escape');
  await expect.poll(outbox, { timeout: 15_000 }).toBe(0);

  // The batch that inserted the bullet never reached the disk here, as a dropped write left it before.
  await a.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openVault } = (await load('/src/sync/setup.ts')) as typeof import('../src/sync/setup.ts');
    const { dataKey } = (await load('/src/sync/crypto.ts')) as typeof import('../src/sync/crypto.ts');
    const { encryptedCodec } = (await load('/src/persist/codec.ts')) as typeof import('../src/persist/codec.ts');
    const { done } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db.ts');
    const opened = await openVault('e2e-sync-gap');
    const codec = encryptedCodec(await dataKey(opened.secret!.dek));
    const read = opened.db.transaction('oplog').objectStore('oplog');
    const [keys, records] = await Promise.all([
      new Promise<IDBValidKey[]>((resolve) => { read.getAllKeys().onsuccess = (e) => resolve((e.target as IDBRequest<IDBValidKey[]>).result); }),
      new Promise<unknown[]>((resolve) => { read.getAll().onsuccess = (e) => resolve((e.target as IDBRequest<unknown[]>).result); }),
    ]);
    let gap: IDBValidKey | null = null;
    for (let i = 0; i < records.length && gap === null; i++) {
      if ((await codec.decodeBatch(records[i])).some((op) => op.t === 'insert')) gap = keys[i];
    }
    const tx = opened.db.transaction('oplog', 'readwrite');
    tx.objectStore('oplog').delete(gap!);
    await done(tx);
    opened.db.close();
  });

  await a.reload();
  await expect(a.locator('.row .text')).toHaveText(['с сервера!']);
  await expect(a.locator('.toast')).toContainText('не дошла до диска');
  await a.locator('.toast').getByRole('button', { name: 'Взять с сервера' }).click();
  await expect(a.locator('.row .text')).toHaveText(['с сервера!', 'раз'], { timeout: 30_000 });
  await expect(a.locator('.toast')).toContainText('Документ загружен с сервера');
  await expect(syncOn(a)).toBeVisible();

  // The same by hand: the dialog's button, after a confirmation.
  a.once('dialog', (d) => void d.accept());
  await openSyncDialog(a);
  await a.getByRole('button', { name: 'Загрузить с сервера' }).click();
  await expect(a.locator('.toast')).toContainText('Документ загружен с сервера', { timeout: 30_000 });
  await expect(a.locator('.row .text')).toHaveText(['с сервера!', 'раз']);
});

test('a passphrase changed on one device: another is told, takes the new one, and what it typed meanwhile arrives', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto('/?db=e2e-sync-pass-a&empty');
  await a.locator('.row .text').click();
  await a.keyboard.type('до смены');
  await a.waitForTimeout(400);
  await openSyncDialog(a);
  await a.locator('.sync-dialog input[type="url"]').fill(SYNC);
  const passwords = a.locator('.sync-dialog input[type="password"]');
  await passwords.nth(0).fill(PASS);
  await passwords.nth(1).fill(PASS);
  await a.getByRole('button', { name: 'Создать и включить' }).click();
  await expect(a.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30_000 });
  await openSyncDialog(a);
  const code = (await a.locator('.doc-code').textContent())!.trim();
  await a.keyboard.press('Escape');

  const b = await (await browser.newContext()).newPage();
  await b.goto('/?db=e2e-sync-pass-b&empty');
  await openSyncDialog(b);
  await b.getByRole('tab', { name: 'Подключиться к существующему' }).click();
  await b.locator('.sync-dialog input[type="url"]').fill(SYNC);
  await b.locator('.sync-dialog input[type="text"]').fill(code);
  await b.locator('.sync-dialog input[type="password"]').fill(PASS);
  await b.getByRole('button', { name: 'Подключиться' }).click();
  await expect(b.locator('.row .text').first()).toHaveText('до смены', { timeout: 30_000 });

  // A changes the passphrase (and reloads with the new token).
  const NEW = 'совсем другой пароль';
  await openSyncDialog(a); // opens on the passphrase form
  const fresh = a.locator('.sync-dialog form input[type="password"]');
  await fresh.nth(0).fill(NEW);
  await fresh.nth(1).fill(NEW);
  await a.locator('.sync-dialog form').getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(syncOn(a)).toBeVisible({ timeout: 30_000 });

  // B types: its push is refused, it says so and stops asking; the edit waits.
  await b.locator('.row .text').first().click();
  await b.keyboard.press('Control+End');
  await b.keyboard.type(', и после');
  await b.keyboard.press('Escape');
  await expect(b.locator('.toast')).toContainText('Пароль синхронизации сменили', { timeout: 15_000 });
  await b.locator('.toast').getByRole('button', { name: 'Ввести новый' }).click();
  await b.locator('.sync-dialog form input[type="password"]').fill(NEW);
  await b.locator('.sync-dialog').getByRole('button', { name: 'Продолжить' }).click();
  await expect(b.locator('.row .text').first()).toHaveText('до смены, и после', { timeout: 30_000 });
  await expect.poll(() => rows(a), { timeout: 30_000 }).toEqual(['до смены, и после']);
});
