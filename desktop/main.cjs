const { app, BrowserWindow, shell, nativeTheme } = require('electron');
const { join } = require('node:path');
const { APP_URL, isAppURL, isExternalURL } = require('./policy.cjs');

// Test entry points call start with a private profile and their own local site.
// Production always uses APP_URL; the remote page cannot configure this.
async function start({ site = APP_URL, profile } = {}) {
  app.setName('Listik');
  if (profile) app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let window;
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  await app.whenReady();
  const background = () => nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5';
  window = new BrowserWindow({
    width: 1100, height: 800, minWidth: 360, minHeight: 400, show: false,
    title: 'Listik', backgroundColor: background(), icon: join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
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
  const updateBackground = () => window.setBackgroundColor(background());
  nativeTheme.on('updated', updateBackground);
  const external = (url) => { if (isExternalURL(url)) void shell.openExternal(url).catch(console.error); };
  contents.on('will-navigate', (event, url) => {
    if (!isAppURL(url, site)) { event.preventDefault(); external(url); }
    else if (contents.getURL().startsWith('file:')) { event.preventDefault(); void load(); }
  });
  contents.on('will-redirect', (event, url) => { if (!isAppURL(url, site)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  const session = contents.session;
  // Listik embeds no pages.
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
  window.on('closed', () => { nativeTheme.removeListener('updated', updateBackground); window = null; });
  app.on('window-all-closed', () => app.quit());
  await load();
  return { window, load };
}
if (require.main === module) void start();
module.exports = { start };
