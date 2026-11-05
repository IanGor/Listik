const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, rename } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readTheme, watchTheme } = require('../omarchy.cjs');
const palette = 'background = "#112233"\nforeground = "#EEEEEE"\naccent = "#aabbcc"\n';

test('reads TOML colors and mode, rejects invalid colors and oversized input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'listik-theme-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'theme'));
  const file = join(root, 'theme/colors.toml');
  await writeFile(file, `mode = "light"\n${palette}`);
  assert.deepEqual((await readTheme(root)).palette, { mode: 'light', colors: { background: '#112233', foreground: '#eeeeee', accent: '#aabbcc' } });
  await writeFile(file, palette);
  assert.equal((await readTheme(root)).palette.mode, 'dark');
  await writeFile(join(root, 'theme/light.mode'), '');
  assert.equal((await readTheme(root)).palette.mode, 'light');
  await writeFile(file, 'background = "url(evil)"\nforeground = "#ffffff"');
  assert.equal((await readTheme(root)).palette, null);
  await writeFile(file, 'x'.repeat(65537));
  assert.equal((await readTheme(root)).palette, null);
});

test('watch survives directory replacements and retains last good palette through invalid data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'listik-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'theme'));
  await writeFile(join(root, 'theme/colors.toml'), palette);
  const states = [];
  const stop = watchTheme(root, (state) => states.push(state));
  t.after(stop);
  const waitFor = async (fn) => {
    for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 30)); }
    assert.fail('watch did not publish expected palette');
  };
  await waitFor(() => states.some(s => s.palette?.colors.background === '#112233'));
  for (const color of ['#334455', '#556677']) {
    await mkdir(join(root, 'next-theme'));
    await writeFile(join(root, 'next-theme/colors.toml'), palette.replace('#112233', color));
    await rm(join(root, 'theme'), { recursive: true });
    await rename(join(root, 'next-theme'), join(root, 'theme'));
    await waitFor(() => states.at(-1)?.palette?.colors.background === color);
  }
  await writeFile(join(root, 'theme/colors.toml'), 'not toml');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(states.at(-1).palette.colors.background, '#556677');
  assert.equal(states.at(-1).managed, true);
});

test('missing theme yields unmanaged state', async () => {
  assert.deepEqual(await readTheme('/does-not-exist'), { version: 1, managed: false, palette: null });
});


test('watch retains a startup snapshot when the theme disappears before its first refresh', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'listik-initial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = { version: 1, managed: true, palette: { mode: 'dark', colors: { background: '#112233', foreground: '#eeeeee' } } };
  let latest;
  const stop = watchTheme(root, state => { latest = state; }, initial);
  t.after(stop);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(latest, initial);
});
