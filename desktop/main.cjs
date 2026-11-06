const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { existsSync } = require('node:fs');
const { readTheme, watchTheme } = require('./omarchy.cjs');
const { APP_URL, isAppURL, isExternalURL, isTrustedSender } = require('./policy.cjs');

// Test entry points call start with a private profile and their own local site.
// Production always uses APP_URL; the remote page cannot configure this.
async function start({ site = APP_URL, profile, themeRoot } = {}) {
  app.setName('Listik');
  if (profile) app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let window;
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  await app.whenReady();
  const roots = [join(homedir(), '.local/state/omarchy/current'), join(homedir(), '.config/omarchy/current')];
  const root = themeRoot ?? roots.find(existsSync) ?? roots[0];
  let state = await readTheme(root);
  const background = () => state.palette?.colors.background ?? (nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5');
  window = new BrowserWindow({
    width: 1100, height: 800, minWidth: 360, minHeight: 400, show: false,
    title: 'Listik', backgroundColor: background(), icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.setMenu(null);
  const contents = window.webContents;
  // Removing Electron's menu also removes its built-in reload accelerators.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta || input.code !== 'KeyR') return;
    event.preventDefault();
    if (!isAppURL(contents.getURL(), site)) void load();
    else if (input.shift) contents.reloadIgnoringCache();
    else contents.reload();
  });
  ipcMain.on('listik:theme', (event) => {
    event.returnValue = isTrustedSender(event, contents, site) ? state : null;
  });
  const stop = watchTheme(root, (next) => {
    state = next;
    if (window.isDestroyed()) return;
    window.setBackgroundColor(background());
    if (isAppURL(contents.getURL(), site)) contents.send('listik:theme-changed', state);
  }, state);
  const external = (url) => { if (isExternalURL(url)) void shell.openExternal(url).catch(console.error); };
  contents.on('will-navigate', (event, url) => {
    if (!isAppURL(url, site)) { event.preventDefault(); external(url); }
    else if (contents.getURL().startsWith('file:')) { event.preventDefault(); void load(); }
  });
  contents.on('will-redirect', (event, url) => { if (!isAppURL(url, site)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  const session = contents.session;
  // Listik embeds no pages. A same-origin foreign project in an iframe could
  // otherwise access the top window's bridge through parent.listikDesktop.
  contents.on('will-frame-navigate', (event) => { if (!event.isMainFrame) event.preventDefault(); });
  // Ordinary keyboard paste stays native; allow only clipboard writes.
  const permission = (wc, name, details) => wc === contents && ['clipboard-sanitized-write'].includes(name) && isAppURL(details?.requestingUrl ?? contents.getURL(), site);
  session.setPermissionRequestHandler((wc, name, callback, details) => callback(permission(wc, name, details)));
  session.setPermissionCheckHandler((wc, name, _origin, details) => permission(wc, name, details));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  const load = async () => {
    try { await window.loadURL(site); }
    catch (error) {
      if (!window || window.isDestroyed() || error.code === 'ERR_ABORTED') return;
      console.error('Listik: unable to load the site:', error.code ?? error.message);
      await window.loadFile(join(__dirname, 'error.html'), { query: { site } });
      window.show();
    }
  };
  window.on('closed', () => { stop(); ipcMain.removeAllListeners('listik:theme'); window = null; });
  app.on('window-all-closed', () => app.quit());
  await load();
  return { window, root, load };
}
if (require.main === module) void start();
module.exports = { start };
