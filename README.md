# Listik

Outliner в стиле Workflowy: один бесконечный bullet-список с мгновенной фильтрацией по `#tag` на документах объёмом «Войны и мира».

Архитектура и план этапов: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```sh
npm install
npm run dev        # dev-сервер; /?sample=200000 — синтетический документ на 200 тыс. bullet'ов
npm test           # unit-тесты (Vitest)
npm run test:e2e   # e2e в Chromium (Playwright); системный /usr/bin/chromium или CHROMIUM_PATH
npm run typecheck
```

Клавиши: Enter — новый bullet / разделить, Tab / Shift+Tab — вложить / вынести, Backspace в начале — склеить с предыдущим, Ctrl+Shift+Backspace — удалить с поддеревом, Alt+Shift+↑/↓ (или Ctrl+Shift+↑/↓) — подвинуть, Ctrl+↑/↓ — свернуть / развернуть, клик по bullet'у — свернуть / развернуть, Esc — выйти из редактирования.
