import { expect, test, type Page } from '@playwright/test';

const password = 'Пароль тестового документа';
const storedText = 'Сохранённый пункт';
const syncServer = 'http://127.0.0.1:5182';

async function seedEncryptedDocument(page: Page, name: string, damaged: boolean) {
  await page.goto('/?demo');
  await page.evaluate(async ({ name, damaged, password, storedText, syncServer }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { Persistence } = (await load('/src/persist/idb.ts')) as typeof import('../src/persist/idb');
    const { createSync, forgetOnDevice, openVault } = (await load('/src/sync/setup.ts')) as typeof import('../src/sync/setup');
    const { encryptedCodec } = (await load('/src/persist/codec.ts')) as typeof import('../src/persist/codec');
    const { dataKey } = (await load('/src/sync/crypto.ts')) as typeof import('../src/sync/crypto');
    const { done } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db');
    const { doc, persistence } = await Persistence.open(name);
    const id = doc.get(doc.root).children[0];
    doc.apply({ t: 'setText', id, from: '', to: storedText });
    await persistence.settle();
    const opened = await openVault(name);
    const handle = await createSync(doc, opened, persistence, syncServer, password);
    handle.engine.stop();
    if (damaged) {
      const wrongKey = await dataKey(crypto.getRandomValues(new Uint8Array(32)));
      const batch = await encryptedCodec(wrongKey).encodeBatch([]);
      const tx = opened.db.transaction('oplog', 'readwrite');
      tx.objectStore('oplog').add(batch);
      await done(tx);
    } else {
      await forgetOnDevice(opened);
    }
    opened.db.close();
  }, { name, damaged, password, storedText, syncServer });
}

test('an existing encrypted document opens with the password and respects remember on device', async ({ page }) => {
  await seedEncryptedDocument(page, 'minimal-locked', false);
  await page.goto('/?db=minimal-locked&empty');
  const input = page.getByLabel('Пароль', { exact: true });
  const open = page.getByRole('button', { name: 'Открыть', exact: true });
  await input.fill('Неверный пароль');
  await open.click();
  await expect(page.getByRole('alert')).toHaveText('Пароль не подходит');

  await input.fill(password);
  await page.getByRole('checkbox', { name: 'Запомнить на этом устройстве' }).uncheck();
  await open.click();
  await expect(page.locator('.minimal-outline .row .text')).toHaveText(storedText);
  await page.reload();
  await expect(input).toBeVisible();

  await input.fill(password);
  await open.click();
  await expect(page.locator('.minimal-outline .row .text')).toHaveText(storedText);
  await page.reload();
  await expect(page.locator('.minimal-outline .row .text')).toHaveText(storedText);
});

test('a damaged local copy can be restored into the new interface', async ({ page }) => {
  await seedEncryptedDocument(page, 'minimal-damaged', true);
  await page.goto('/?db=minimal-damaged&empty');
  const restore = page.getByRole('button', { name: 'Загрузить с сервера', exact: true });
  await restore.click();
  await expect(page.locator('.minimal-outline .row .text')).toHaveText(storedText);
  await expect(restore).toHaveCount(0);
});

test('a second tab can read the outline and becomes editable when the writer closes', async ({ context, page }) => {
  const url = '/?db=minimal-readonly&empty';
  await page.goto(url);
  const writerText = page.locator('.row .text');
  await writerText.click();
  await page.locator('.row .text[contenteditable]').fill(storedText);

  const reader = await context.newPage();
  await reader.goto(url);
  await expect(reader.getByRole('status')).toContainText('только просмотр');
  const readerText = reader.locator('.minimal-outline .row .text');
  await expect(readerText).toHaveText(storedText);
  await readerText.click();
  await expect(reader.locator('.row .text[contenteditable]')).toHaveCount(0);

  await page.close();
  await expect(reader.getByRole('status')).toHaveCount(0);
  await readerText.click();
  const editor = reader.locator('.row .text[contenteditable]');
  await editor.fill('Правка из второй вкладки');
  await editor.press('Escape');
  await expect(readerText).toHaveText('Правка из второй вкладки');
});
