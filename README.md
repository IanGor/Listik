# Listik

Outliner в стиле Workflowy: один бесконечный bullet-список с мгновенной фильтрацией по `#tag` на документах объёмом «Войны и мира».
Оформление — по образцу Workflowy, в цветах Claude; светлая и тёмная тема переключаются кнопкой в шапке.

Архитектура и план этапов: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```sh
npm install
npm run dev        # dev-сервер; документ хранится в IndexedDB браузера
                   # /?demo — демо, /?sample=200000 — синтетика на 200 тыс. bullet'ов (оба только в памяти)
npm test           # unit-тесты (Vitest)
npm run test:e2e   # e2e в Chromium (Playwright); системный /usr/bin/chromium или CHROMIUM_PATH
npm run typecheck
npm run bench      # бенчмарк на 67 тыс. и 200 тыс. bullet'ов → bench/RESULTS.md
```

Клавиши: Enter — новый bullet / разделить, Tab / Shift+Tab — вложить / вынести, Backspace в начале — склеить с предыдущим, Ctrl+Shift+Backspace — удалить с поддеревом, Alt+Shift+↑/↓ (или Ctrl+Shift+↑/↓) — подвинуть, Ctrl+↑/↓ или стрелка слева — свернуть / развернуть, клик по точке bullet'а или Alt+→ — войти в него (zoom), Alt+← или «хлебные крошки» — выйти, «+» под списком в zoom — новый пункт, клик по «Listik» — на главную со всем свёрнутым, Ctrl+Z / Ctrl+Shift+Z (или Ctrl+Y) — отменить / повторить, Ctrl+F — поиск (слова, «фраза в кавычках», `#тег`; Enter — к первому совпадению), клик по `#тегу` — искать этот тег, Esc — сбросить поиск / выйти из редактирования.
