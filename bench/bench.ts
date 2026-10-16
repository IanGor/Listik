/**
 * Performance benchmark against the budgets in docs/ARCHITECTURE.md §1.
 *
 *   npm run bench                  # ~67k bullets (≈ War and Peace) and 200k
 *   npm run bench -- 500000        # other sizes, in bullets
 *
 * Starts Vite, drives Chromium (system /usr/bin/chromium or CHROMIUM_PATH)
 * and writes bench/RESULTS.md. Two passes per size: the model in the page
 * (indexes, edits, filter, search, storage, compaction) and the UI from a
 * stored document (first row on screen, keystroke to painted frame, ...).
 * Runs on the Vite dev build: absolute numbers are a little pessimistic.
 */
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (!sizes.length) sizes.push(67_000, 200_000);

const PORT = 5191;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));

type Row = [metric: string, value: string, budget?: string];

interface Stats {
  p50: number;
  p95: number;
  max: number;
}

// --- Pass 1: the model, in the page ----------------------------------------

async function modelPass(page: Page, n: number) {
  return page.evaluate(async ({ n, db }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { sampleDoc } = (await load('/src/dev/sample.ts')) as typeof import('../src/dev/sample.ts');
    const { serialize } = (await load('/src/persist/serialize.ts')) as typeof import('../src/persist/serialize.ts');
    const { openDb, writeSnapshot, done } = (await load('/src/persist/db.ts')) as typeof import('../src/persist/db.ts');
    const { compactLog } = (await load('/src/persist/compact.ts')) as typeof import('../src/persist/compact.ts');
    const { Persistence } = (await load('/src/persist/idb.ts')) as typeof import('../src/persist/idb.ts');
    const { VisibleRows, keepSet } = (await load('/src/model/rows.ts')) as typeof import('../src/model/rows.ts');
    const { TagIndex } = (await load('/src/model/tags.ts')) as typeof import('../src/model/tags.ts');
    const { TextIndex, findMatches, parseQuery } = (await load('/src/model/search.ts')) as typeof import('../src/model/search.ts');
    const cmd = (await load('/src/model/commands.ts')) as typeof import('../src/model/commands.ts');

    const now = () => performance.now();
    const time = (fn: () => void) => {
      const s = now();
      fn();
      return now() - s;
    };
    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
    };
    const gc = (globalThis as { gc?: () => void }).gc;
    const heap = () => {
      gc?.();
      return (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    };
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

    // Seed the database with a snapshot of a synthetic document.
    const heapBefore = heap();
    const generated = sampleDoc(n);
    let chars = 0;
    for (const node of generated.nodes.values()) chars += node.text.length;
    let json = '';
    const serializeMs = time(() => { json = serialize(generated); });
    const snapshotChars = json.length;
    const seedDb = await openDb(db);
    await writeSnapshot(seedDb, json);
    const clear = seedDb.transaction('oplog', 'readwrite');
    clear.objectStore('oplog').clear();
    await done(clear);
    seedDb.close();
    json = '';

    // Load, then build what the app builds on top of the doc.
    let s = now();
    const { doc, persistence } = await Persistence.open(db);
    const openMs = now() - s;
    let rows!: InstanceType<typeof VisibleRows>;
    let tags!: InstanceType<typeof TagIndex>;
    let text!: InstanceType<typeof TextIndex>;
    const rowsMs = time(() => { rows = new VisibleRows(doc); });
    const tagsMs = time(() => { tags = new TagIndex(doc); });
    text = new TextIndex(doc);
    const textMs = time(() => text.warmUp());
    const heapMb = (heap() - heapBefore) / 1e6;
    const ctx = { doc, rows };
    const pick = () => rows.ids[Math.floor(rand() * rows.length)];

    // Edits, with every index and the persistence listening.
    const typing = Array.from({ length: 1000 }, () => {
      const id = pick();
      return time(() => doc.transact(() => cmd.setText(ctx, id, doc.get(id).text + 'ж')));
    });
    const enter = Array.from({ length: 200 }, () => {
      const id = pick();
      return time(() => doc.transact(() => { cmd.split(ctx, id, doc.get(id).text.length); }));
    });
    const indent = Array.from({ length: 200 }, () => {
      const id = pick();
      return time(() => doc.transact(() => cmd.indent(ctx, id)));
    });
    s = now();
    await persistence.flush();
    const flushMs = now() - s;

    // Filter by the most frequent tag, then search.
    const [topTag, topCount] = [...tags.counts()].sort((a, b) => b[1] - a[1])[0];
    const filterMs = time(() => rows.setFilter({ keep: keepSet(doc, tags.nodesWith(topTag)), open: new Set() }));
    const filterRows = rows.length;
    const clearMs = time(() => rows.setFilter(null));
    const searches = ['наташа смотрел', 'бородино', '"тихо быстро"', `#${topTag} кутузов`, 'а'].map((q) => {
      let count = 0;
      const findMs = time(() => { count = findMatches(parseQuery(q), tags, text).size; });
      const ms = time(() => {
        const m = findMatches(parseQuery(q), tags, text);
        rows.setFilter({ keep: keepSet(doc, m), open: new Set() });
      });
      rows.setFilter(null);
      return { q, count, findMs, ms };
    });

    // Compaction: in the worker, while measuring the longest main-thread stall.
    const watchStalls = () => {
      let last = now();
      let worst = 0;
      let running = true;
      const tick = () => {
        const t = now();
        worst = Math.max(worst, t - last);
        last = t;
        if (running) setTimeout(tick, 0);
      };
      setTimeout(tick, 0);
      return () => {
        running = false;
        return worst;
      };
    };
    let stop = watchStalls();
    s = now();
    await persistence.compact();
    const workerCompactMs = now() - s;
    const workerStallMs = stop();

    // The same work on the main thread, for comparison (what M2 did).
    for (let i = 0; i < 100; i++) {
      const id = pick();
      doc.transact(() => cmd.setText(ctx, id, doc.get(id).text + 'й'));
    }
    await persistence.flush();
    const mainDb = await openDb(db);
    stop = watchStalls();
    s = now();
    await compactLog(mainDb);
    const mainCompactMs = now() - s;
    const mainStallMs = stop();
    mainDb.close();

    // Load again, with a 10k-op log on top of the snapshot.
    for (let i = 0; i < 10_000; i++) {
      const id = pick();
      doc.transact(() => cmd.setText(ctx, id, doc.get(id).text + 'ы'));
      if (i % 200 === 0) await persistence.flush();
    }
    await persistence.flush();
    persistence.close();
    s = now();
    const reopened = await Persistence.open(db);
    const openWithLogMs = now() - s;
    reopened.persistence.close();

    return {
      nodes: generated.nodes.size - 1, chars, snapshotChars, serializeMs, openMs, openWithLogMs,
      rowsMs, tagsMs, textMs, heapMb, typing: stats(typing), enter: stats(enter), indent: stats(indent),
      flushMs, topTag, topCount, filterMs, filterRows, clearMs, searches,
      workerCompactMs, workerStallMs, mainCompactMs, mainStallMs,
    };
  }, { n, db: `bench-${n}` });
}

// --- Pass 2: the UI, from the stored document --------------------------------

const frame = `() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)))`;

async function uiPass(page: Page, n: number) {
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('.row')) return;
      (window as { firstRow?: number }).firstRow = performance.now();
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${ORIGIN}/?db=bench-${n}`);
  await page.locator('.row').first().waitFor();
  const startupMs = await page.evaluate(() => (window as { firstRow?: number }).firstRow ?? NaN);
  await page.waitForTimeout(1500); // let post-load work settle: we measure the steady state

  // Each edit: "work" is the handler plus the layout it causes (what must fit
  // in a frame); "frame" also waits for the next vsync, so it is at least one
  // frame interval even when nothing is late.
  const edit = (action: 'type' | 'enter' | 'tab', times: number) => page.evaluate(async ({ action, times, frameSrc }) => {
    const nextFrame = eval(frameSrc) as () => Promise<void>;
    const work: number[] = [];
    const frame: number[] = [];
    for (let i = 0; i < times; i++) {
      const el = document.activeElement!;
      const s = performance.now();
      if (action === 'type') document.execCommand('insertText', false, 'ж');
      else {
        const key = action === 'enter' ? 'Enter' : 'Tab';
        el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: action === 'tab' && i % 2 === 1, bubbles: true, cancelable: true }));
      }
      void document.body.offsetHeight; // force style and layout now
      work.push(performance.now() - s);
      await nextFrame();
      frame.push(performance.now() - s);
    }
    return { work, frame };
  }, { action, times, frameSrc: frame });

  await page.locator('.row .text').first().click();
  const keystroke = await edit('type', 60);
  const enter = await edit('enter', 30);
  await page.keyboard.type('вложенный');
  const tab = await edit('tab', 30);
  await page.keyboard.press('Escape');

  const scrollMs = await page.evaluate(async (frameSrc) => {
    const nextFrame = eval(frameSrc) as () => Promise<void>;
    const scroller = document.querySelector('.scroller')!;
    const s = performance.now();
    scroller.scrollTop = scroller.scrollHeight / 2;
    scroller.dispatchEvent(new Event('scroll'));
    await nextFrame();
    return performance.now() - s;
  }, frame);

  const tagMs = await page.locator('.tag').first().evaluate(async (el, frameSrc) => {
    const nextFrame = eval(frameSrc) as () => Promise<void>;
    const s = performance.now();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await nextFrame();
    return performance.now() - s;
  }, frame);
  await page.keyboard.press('Escape');

  const searchMs = await page.locator('.search').evaluate(async (el, frameSrc) => {
    const nextFrame = eval(frameSrc) as () => Promise<void>;
    const input = el as HTMLInputElement;
    const s = performance.now();
    input.value = 'наташа смотрел';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await nextFrame(); // the search runs on the next frame...
    await nextFrame(); // ...and paints on the one after
    return performance.now() - s;
  }, frame);

  const both = (r: { work: number[]; frame: number[] }) => ({ work: summarize(r.work), frame: summarize(r.frame) });
  return { startupMs, keystroke: both(keystroke), enter: both(enter), tab: both(tab), scrollMs, tagMs, searchMs };
}

function summarize(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}

// --- Report ----------------------------------------------------------------

const ms = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString()) + ' мс';
const pct = (s: Stats) => `${ms(s.p50)} / ${ms(s.p95)}`;
const thousands = (x: number) => Math.round(x).toLocaleString('ru-RU');

function table(rows: Row[]): string {
  return ['| Метрика | Значение | Бюджет |', '|---|---|---|', ...rows.map(([m, v, b]) => `| ${m} | ${v} | ${b ?? ''} |`)].join('\n');
}

const server = await createServer({ server: { host: '127.0.0.1', port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath,
  args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
});
const sections: string[] = [];
try {
  for (const n of sizes) {
    console.log(`\n${thousands(n)} bullets…`);
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`${ORIGIN}/?demo`);
    const m = await modelPass(page, n);
    const ui = await uiPass(page, n);
    await context.close();

    const rows: Row[] = [
      ['Документ', `${thousands(m.nodes)} bullet'ов, ${(m.chars / 1e6).toFixed(1)} млн знаков`],
      ['**Загрузка и память**', ''],
      ['Первая строка на экране (с открытия страницы)', ms(ui.startupMs), '< 1000 мс'],
      ['Загрузка из IndexedDB (снимок)', ms(m.openMs)],
      ['Загрузка из IndexedDB (снимок + журнал 10 тыс. ops)', ms(m.openWithLogMs)],
      ['Видимые строки / индекс тегов / индекс текста (в простое)', `${ms(m.rowsMs)} / ${ms(m.tagsMs)} / ${ms(m.textMs)}`],
      ['Память: документ + индексы (куча JS)', `${Math.round(m.heapMb)} МБ`, '< 200 МБ'],
      ['**Правка** (p50 / p95)', ''],
      ['Символ: работа (обработчик + вёрстка) / до кадра (UI)', `${pct(ui.keystroke.work)}; ${pct(ui.keystroke.frame)}`, 'работа < 16 мс'],
      ['Enter: работа / до кадра (UI)', `${pct(ui.enter.work)}; ${pct(ui.enter.frame)}`, 'работа < 16 мс'],
      ['Tab / Shift+Tab: работа / до кадра (UI)', `${pct(ui.tab.work)}; ${pct(ui.tab.frame)}`, 'работа < 16 мс'],
      ['Правка текста в модели (все индексы)', pct(m.typing)],
      ['Enter в модели', pct(m.enter)],
      ['Tab в модели', pct(m.indent)],
      ['**Фильтр и поиск**', ''],
      [`Клик по тегу → кадр (UI)`, ms(ui.tagMs), '< 50 мс'],
      [`Фильтр #${m.topTag} (${thousands(m.topCount)} совпадений, ${thousands(m.filterRows)} строк) в модели`, ms(m.filterMs)],
      ['Сброс фильтра', ms(m.clearMs)],
      ['Ввод в поиск → результат на экране (UI)', ms(ui.searchMs), '< 50 мс + кадр'],
      ...m.searches.map(({ q, count, findMs, ms: total }): Row =>
        [`Поиск \`${q}\` (${thousands(count)} совпадений): поиск / с фильтром`, `${ms(findMs)} / ${ms(total)}`]),
      ['**Прокрутка и хранение**', ''],
      ['Прыжок в середину документа → кадр (UI)', ms(ui.scrollMs), '< 16 мс + кадр'],
      ['Сохранение ~1400 правок одной пачкой', ms(m.flushMs)],
      ['Пересборка снимка в Worker: длительность / макс. пауза главного потока', `${ms(m.workerCompactMs)} / ${ms(m.workerStallMs)}`],
      ['То же в главном потоке (для сравнения)', `${ms(m.mainCompactMs)} / ${ms(m.mainStallMs)}`],
      ['Размер снимка', `${(m.snapshotChars / 1e6).toFixed(1)} млн символов JSON (сериализация ${ms(m.serializeMs)})`],
    ];
    const section = `## ${thousands(m.nodes)} bullet'ов\n\n${table(rows)}`;
    console.log(section);
    sections.push(section);
  }
} finally {
  await browser.close();
  await server.close();
}

const header = [
  '# Результаты бенчмарка',
  '',
  `Сгенерировано \`npm run bench\` ${new Date().toISOString().slice(0, 10)}.`,
  `Chromium ${browser.version()}, ${os.cpus()[0]?.model ?? 'CPU'} (${os.cpus().length} потоков), ${Math.round(os.totalmem() / 2 ** 30)} ГБ ОЗУ, ${os.type()} ${os.release()}.`,
  'Документ синтетический (`src/dev/sample.ts`): главы по ~200 bullet\'ов, у пятой части 1–3 вложенных, ~5% длинных, ~10% с тегом.',
  'UI — от события до следующего отрисованного кадра, после того как страница успокоилась после загрузки. Сборка — dev-сервер Vite.',
  '',
].join('\n');
writeFileSync(new URL('./RESULTS.md', import.meta.url), `${header}\n${sections.join('\n\n')}\n`);
console.log('\nwritten bench/RESULTS.md');
