// Real Electron and compositor checks; run with node tests/window-smoke.cjs.
const { _electron, expect } = require('../../node_modules/@playwright/test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'listik-window-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Listik window test</title><input id="note"><script>note.value=localStorage.getItem("note")||"";note.oninput=()=>localStorage.setItem("note",note.value)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}/`;
  let app;
  const failures = [];
  try {
    app = await _electron.launch({ chromiumSandbox: true, executablePath: require('../node_modules/electron'), args: [join(__dirname, 'smoke.cjs')], env: { ...process.env, LISTIK_TEST_SITE: site, LISTIK_TEST_PROFILE: join(root, 'profile'), LISTIK_TEST_THEME: join(root, 'no-omarchy') } });
    const page = await app.firstWindow({ timeout: 10000 });
    await page.locator('#note').fill('saved locally');
    await page.evaluate(() => { window.reloadMarker = true; });
    try {
      const reloaded = page.waitForEvent('domcontentloaded', { timeout: 3000 });
      reloaded.catch(() => {});
      await app.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] }); });
      await reloaded;
      assert.equal(await page.evaluate(() => window.reloadMarker), undefined);
      await expect(page.locator('#note')).toHaveValue('saved locally');
      console.log('PASS Ctrl+R reloads and preserves saved local state');
      await page.evaluate(() => { window.reloadMarker = true; });
      const forceReloaded = page.waitForEvent('domcontentloaded', { timeout: 3000 });
      forceReloaded.catch(() => {});
      await app.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control', 'shift'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control', 'shift'] }); });
      await forceReloaded;
      assert.equal(await page.evaluate(() => window.reloadMarker), undefined);
      console.log('PASS Ctrl+Shift+R reloads');
    } catch (error) { console.error('FAIL reload:', error.message); failures.push(error); }
    const pid = app.process().pid;
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }));
    const client = clients.find(c => c.pid === pid);
    assert(client, 'Test window must be visible in Hyprland');
    const exited = new Promise(resolve => app.process().once('exit', resolve));
    execFileSync('hyprctl', ['dispatch', `hl.dsp.window.close({ window = "address:${client.address}" })`]);
    await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Closing through Hyprland did not terminate Electron')), 5000); timer.unref(); })]);
    console.log('PASS Hyprland close (Super+W action) terminates Electron process');
    app = null;
    if (failures.length) throw failures[0];
  } finally {
    await app?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
