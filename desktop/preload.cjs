const { contextBridge, ipcRenderer } = require('electron');
// Main independently checks the exact webContents, top frame and project URL.
if (process.isMainFrame) {
  const initial = ipcRenderer.sendSync('listik:theme');
  if (initial?.version === 1) {
    let state = initial;
    const listeners = new Set();
    ipcRenderer.on('listik:theme-changed', (_event, next) => {
      state = next;
      for (const listener of listeners) listener(next);
    });
    contextBridge.exposeInMainWorld('listikDesktop', {
      version: 1,
      getTheme: () => state,
      setBackground: (color) => { if (/^#[\da-f]{6}$/i.test(color)) ipcRenderer.send('listik:background', color); },
      onTheme: (callback) => {
        if (typeof callback !== 'function') throw new TypeError('Expected a callback');
        listeners.add(callback);
        callback(state);
        return () => listeners.delete(callback);
      },
    });
  }
}
