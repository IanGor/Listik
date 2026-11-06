const { _electron, chromium, expect } = require('../../node_modules/@playwright/test');
const { mkdtemp, mkdir, writeFile, readFile, cp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const repo = join(__dirname, '../..');
const site = 'http://127.0.0.1:5271/';
let preview, sync, electron, browser;
const palette = (mode, bg, fg) => `mode = "${mode}"\nbackground = "${bg}"\nforeground = "${fg}"\naccent = "#7e9cd8"\n`;
async function waitServer(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(`Server did not start: ${url}`);
}
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'listik-desktop-smoke-'));
  const theme = join(root, 'omarchy');
  const profile = join(root, 'profile');
  const web = join(root, 'site');
  await cp(join(repo, 'dist'), web, { recursive: true });
  const originalHTML = await readFile(join(web, 'index.html'), 'utf8');
  const webVersion = version => writeFile(join(web, 'index.html'), originalHTML.replace('<head>', `<head><meta name="smoke-version" content="${version}">`));
  await webVersion(1);
  await mkdir(join(theme, 'theme'), { recursive: true });
  await writeFile(join(theme, 'theme/colors.toml'), palette('dark', '#1f1f28', '#dcd7ba'));
  const launch = () => _electron.launch({ chromiumSandbox: true, executablePath: require('../node_modules/electron'), args: [join(__dirname, 'smoke.cjs')], env: { ...process.env, LISTIK_TEST_SITE: site, LISTIK_TEST_PROFILE: profile, LISTIK_TEST_THEME: theme }, timeout: 30000 });
  try {
    // A fresh installation offline must show a local retry page without a bridge.
    console.log('Launching Electron'); electron = await launch(); console.log('Electron launched');
    let page = await electron.firstWindow({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Не удалось открыть Listik' })).toBeVisible();
    assert.equal(await page.evaluate(() => typeof window.listikDesktop), 'undefined');
    const retried = page.waitForEvent('domcontentloaded');
    await electron.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
    });
    await retried;
    await expect(page.getByRole('heading', { name: 'Не удалось открыть Listik' })).toBeVisible();
    preview = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), 'preview', '--outDir', web, '--host', '127.0.0.1', '--port', '5271', '--strictPort'], { cwd: repo, stdio: 'ignore' });
    sync = spawn(process.execPath, [join(repo, 'server/index.js')], { cwd: repo, env: { ...process.env, LISTIK_DATA: join(root, 'sync'), LISTIK_PORT: '5272', LISTIK_ORIGINS: '*', LISTIK_ALLOW_CREATE: '1' }, stdio: 'ignore' });
    await waitServer(site);
    await waitServer('http://127.0.0.1:5272/health');
    await page.getByRole('link', { name: 'Повторить' }).click();
    await expect(page.locator('.row').first()).toBeVisible();
    assert.deepEqual(await page.evaluate(() => ({ node: typeof window.require, mode: window.listikDesktop.getTheme().palette.mode })), { node: 'undefined', mode: 'dark' });
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox), true);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(31, 31, 40)');
    await writeFile(join(theme, 'theme/colors.toml'), palette('light', '#faf9f5', '#1f1e1c'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // Same-origin subframes must not gain the preload bridge.
    await page.evaluate(() => { const f = document.createElement('iframe'); f.src = '/?db=child&empty'; document.body.append(f); });
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames().find(f => f !== page.mainFrame());
    // A blank frame created by the trusted page inherits its origin; the
    // boundary is preventing a foreign document from ever loading into it.
    await page.waitForTimeout(500);
    assert.notEqual(frame.url(), site + '?db=child&empty', 'child document navigation must be blocked');
    assert.equal(await frame.evaluate(() => typeof window.listikDesktop), 'undefined');
    await page.evaluate(() => document.querySelector('iframe').remove());
    // Populate a remote encrypted document with the existing browser flow.
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
    const source = await browser.newPage();
    await source.goto(site + '?db=source&empty');
    await source.locator('.row .text').click();
    await source.keyboard.type('from server');
    await source.waitForTimeout(400);
    await source.getByRole('button', { name: 'Меню документа' }).click();
    await source.getByRole('menuitem', { name: /Синхронизация/ }).click();
    await source.locator('.sync-dialog input[type="url"]').fill('http://127.0.0.1:5272');
    const pw = source.locator('.sync-dialog input[type="password"]');
    await pw.nth(0).fill('desktop smoke password');
    await pw.nth(1).fill('desktop smoke password');
    await source.getByRole('button', { name: 'Создать и включить' }).click();
    await expect(source.locator('.toast')).toContainText('Синхронизация включена', { timeout: 30000 });
    await source.getByRole('button', { name: 'Меню документа' }).click();
    await source.getByRole('menuitem', { name: /Синхронизация/ }).click();
    const code = await source.locator('.sync-dialog .doc-code').textContent();
    await page.getByRole('button', { name: 'Меню документа' }).click();
    await page.getByRole('menuitem', { name: /Синхронизация/ }).click();
    await page.getByRole('tab', { name: 'Подключиться к существующему' }).click();
    await page.locator('.sync-dialog input[type="url"]').fill('http://127.0.0.1:5272');
    await page.locator('[data-action="SyncDialog.16"]').fill(code);
    await page.locator('.sync-dialog input[type="password"]').fill('desktop smoke password');
    await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
    console.log('source rows:', await source.locator('.row .text').allTextContents());
    console.log('sync code length:', code?.length);
    await expect(page.locator('.row .text').first()).toHaveText('from server', { timeout: 30000 });
    await browser.close(); browser = null;
    await page.evaluate(() => navigator.serviceWorker.ready);
    await webVersion(2);
    await expect(page.locator('meta[name="smoke-version"]')).toHaveAttribute('content', '1');
    await page.reload();
    await expect(page.locator('meta[name="smoke-version"]')).toHaveAttribute('content', '2');
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect(page.locator('.row .text').first()).toHaveText('from server');
    await mkdir(join(repo, 'test-results/omarchy'), { recursive: true });
    await page.screenshot({ path: join(repo, 'test-results/omarchy/electron.png') });
    await electron.close(); electron = null;
    preview.kill(); await new Promise(r => preview.once('exit', r)); preview = null;
    electron = await launch(); page = await electron.firstWindow({ timeout: 15000 });
    await expect(page.locator('.row .text').first()).toHaveText('from server', { timeout: 15000 });
    console.log('PASS Electron: sandbox, isolated bridge, live theme, fresh-profile server sync, persistent profile, next-load web update, offline restart, first-run retry');
  } finally {
    await browser?.close(); await electron?.close(); preview?.kill(); sync?.kill();
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
