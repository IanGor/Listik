const fs = require('node:fs');
const { join } = require('node:path');
const { parse } = require('smol-toml');

async function readTheme(root) {
  const managed = fs.existsSync(root);
  const state = { version: 1, managed, palette: null };
  try {
    const file = join(root, 'theme/colors.toml');
    if ((await fs.promises.stat(file)).size > 65536) return state;
    const data = parse(await fs.promises.readFile(file, 'utf8'));
    const colors = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)) colors[key] = value.toLowerCase();
    }
    if (!colors.background || !colors.foreground) return state;
    const mode = data.mode === 'light' || (data.mode === undefined && fs.existsSync(join(root, 'theme/light.mode'))) ? 'light' : 'dark';
    return { version: 1, managed: true, palette: { mode, colors } };
  } catch { return state; }
}

function watchTheme(root, listener, initial) {
  let stopped = false;
  let busy = false;
  let last = initial ?? { version: 1, managed: fs.existsSync(root), palette: null };
  let published = '';
  const refresh = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const next = await readTheme(root);
      if (stopped) return;
      last = { ...next, managed: last.managed || next.managed, palette: next.palette ?? last.palette };
      const serialized = JSON.stringify(last);
      if (serialized !== published) { published = serialized; listener(last); }
    } finally { busy = false; }
  };
  // Polling also catches in-place edits and recreating the watched directory.
  const poll = setInterval(refresh, 500);
  poll.unref();
  let watcher;
  try { watcher = fs.watch(root, { persistent: false }, () => void refresh()); } catch { /* Poll retries when the directory appears. */ }
  void refresh();
  return () => { stopped = true; clearInterval(poll); watcher?.close(); };
}
module.exports = { readTheme, watchTheme };
