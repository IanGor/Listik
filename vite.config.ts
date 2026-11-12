/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

/**
 * A Content Security Policy for the built app (not the dev server, whose
 * HMR needs more): scripts only from the app itself and the inline theme
 * script, by its hash; WebAssembly for Argon2id (hash-wasm); network to the
 * app and to a sync server over https (127.0.0.1 for tests). Defence in
 * depth: a script slipped into the page could not load more, nor send the
 * document to a plain-http host.
 */
function csp(): Plugin {
  return {
    name: 'listik-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
          .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')} 'wasm-unsafe-eval'`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "connect-src 'self' https: http://127.0.0.1:*",
          "worker-src 'self'",
          "manifest-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ');
        const anchor = '<meta charset="UTF-8" />';
        if (!html.includes(anchor)) throw new Error('listik-csp: no charset meta in index.html to put the policy after');
        return html.replace(anchor, `${anchor}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  }
}

/** Generate the blocking first-paint script from the same pure resolver as runtime.
 * No hand-maintained second catalogue or cached, stale CSS tokens. */
function themeBootstrap(): Plugin {
  return {
    name: 'listik-theme-bootstrap',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const source = ['src/view/omarchy.ts', 'src/view/palettes.ts']
          .map(file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\bexport\s+/g, ''))
          .join('\n');
        const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
        const bootstrap = `{
${js}
const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
let preference = DEFAULT_PREFERENCE;
try { preference = readPreference(localStorage.getItem(PREFERENCE_KEY), system, localStorage.getItem('listik-theme'), localStorage.getItem('listik-theme-system')); } catch {}
let desktop = null;
try { if (window.listikDesktop?.version === 1) desktop = readDesktopTheme(window.listikDesktop.getTheme()); } catch {}
const resolved = resolveTheme(preference, system, desktop);
const root = document.documentElement;
root.dataset.theme = resolved.mode;
root.dataset.palette = resolved.definition.id;
for (const [key, value] of Object.entries(resolved.tokens)) root.style.setProperty(key, value);
const background = resolved.palette?.colors.background ?? (resolved.mode === 'dark' ? '#1c1c1e' : '#ffffff');
root.style.backgroundColor = background;
for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = background;
}`;
        return html.replace('<!-- listik-theme-bootstrap -->', `<script>${bootstrap}</script>`);
      },
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app under /Listik/ (BASE in .github/workflows/pages.yml); locally it is /.
  base: process.env.BASE ?? '/',
  plugins: [solid(), themeBootstrap(), csp()],
  test: {
    include: ['tests/**/*.test.ts'],
    // The model is DOM-free; vite-plugin-solid would default this to jsdom.
    environment: 'node',
  },
})
