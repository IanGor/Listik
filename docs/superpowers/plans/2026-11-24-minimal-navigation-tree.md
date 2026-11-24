# Minimal Navigation Tree & Level Toggle Implementation Plan

**Goal:** Add a Windows Explorer–style branches-only navigation tree sidebar to Listik's `minimal` UI and restore the independent first-level fold toggle (`o.toggleLevel()`) in the editor header.

**Architecture:** Extend the existing read-only `navigationRows` projection in `src/view/navigation-tree.ts` with a `branchesOnly` filter, build a focused `MinimalNavTree` Solid component rendered inside `.workspace` only in `minimal` mode, and wire the sidebar toggle and `.level-toggle` button into `Crumbs` (`src/view/ZoomHeader.tsx`) with styles strictly scoped under `.minimal-outline` in `src/index.css`.

**Tech Stack:** TypeScript, SolidJS, Vitest, Playwright (`minimal` and `minimal-pwa`), CSS tokens from `DESIGN.md`.

**Spec:** `docs/superpowers/specs/2026-11-24-minimal-navigation-tree-design.md`

## Global Constraints
- Changes apply only to `minimal` mode; `legacy` behavior and tests remain unchanged.
- All colors use tokens defined in `.minimal-outline` (`DESIGN.md`, light and dark themes via `light-dark()`).
- Desktop breakpoint for persistent sidebar vs overlay drawer: `1024px`.
- Tree persistence key: `localStorage['listik-minimal-nav-open']` (default `true` on `>= 1024px`).

## Review Focus
- Leaf-only folder (e.g. `📥 Inbox` with only leaf children) must appear in the tree without a chevron (`children: false`).
- Zooming into a leaf without children must highlight its nearest visible parent branch in the tree; "Показать текущую ветку" must reveal that parent without crashing.
- Mirrors with children must show in the tree without infinite loops on self/mutual mirror cycles.
- Folding in the tree must never mutate document folds or editor rows, and `.level-toggle` in the editor header must never mutate tree folds.
- Narrow screen (`< 1024px`) must default to closed, open as overlay, and close on branch click, backdrop tap, or `Escape`.

---

### Task 1: Branches-only mode in `src/view/navigation-tree.ts`

**Files:**
- Modify: `src/view/navigation-tree.ts`
- Test: `tests/navigation-tree.test.ts`

**Interfaces:**
- Produces: `navigationRows(doc: Doc, expanded: ReadonlySet<RowKey>, options?: { branchesOnly?: boolean }): NavigationRow[]`

- [ ] **Step 1:** Add unit tests in `tests/navigation-tree.test.ts` covering `branchesOnly: true` (omits leaves, `children: false` on leaf-only folders, `navigationSelection` falls back to parent branch when active node is a leaf, mirror cycles stay bounded, and `revealNavigation(doc, id, new Set())` reveals only the active path).
- [ ] **Step 2:** Run `npx vitest run tests/navigation-tree.test.ts` and confirm new tests fail.
- [ ] **Step 3:** Implement `options?: { branchesOnly?: boolean }` in `navigationRows` in `src/view/navigation-tree.ts`.
- [ ] **Step 4:** Run `npx vitest run tests/navigation-tree.test.ts` and confirm all tests pass.

---

### Task 2: `MinimalNavTree` component & Swiss Editorial styles

**Files:**
- Create: `src/view/MinimalNavTree.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `navigationRows`, `revealNavigation`, `navigationSelection` from `src/view/navigation-tree.ts`, `calendarName` from `src/model/calendar.ts`, `plainText` from `src/model/format.ts`, `Outliner` from `src/view/outliner.ts`.
- Produces: `MinimalNavTree(props: { o: Outliner; open: Accessor<boolean>; overlay: Accessor<boolean>; onClose: () => void; navId: string })`

- [ ] **Step 1:** Create `src/view/MinimalNavTree.tsx` with header ("Дерево", "Показать текущую ветку" locator button, "Свернуть всё" button, "Скрыть дерево" button), "Главная" root item, reactive `navigationRows(..., { branchesOnly: true })` list with indent guides, chevron toggle, zoom navigation, auto-reveal on external `o.zoom()` changes, smooth scroll + pulse on locate, and overlay backdrop / `Escape` dismissal.
- [ ] **Step 2:** Add `.minimal-outline` navigation tree styles and `.level-toggle` / `.minimal-nav-toggle` header button styles to `src/index.css` using only tokens from `DESIGN.md`.

---

### Task 3: Integrate into `Outline.tsx` and `ZoomHeader.tsx`

**Files:**
- Modify: `src/view/Outline.tsx`
- Modify: `src/view/ZoomHeader.tsx`

**Interfaces:**
- Consumes: `MinimalNavTree` from `src/view/MinimalNavTree.tsx`, `NavigationIcon` from `src/view/TopBar.tsx`.
- Updates `Crumbs` props with optional `navOpen?: boolean; onToggleNav?: () => void; navId?: string`.

- [ ] **Step 1:** In `src/view/ZoomHeader.tsx`, render the `minimal` nav toggle button (`data-action="minimal.nav.toggle"`) before the Home button when `props.minimal && props.onToggleNav`, and show `.level-toggle` (`ZoomHeader.3`) in `minimal` mode as well.
- [ ] **Step 2:** In `src/view/Outline.tsx`, track `minimalOverlay` (`< 1024px`) and `minimalNavOpen` (`localStorage['listik-minimal-nav-open']`, default `true` on desktop, `false` on overlay), render `<MinimalNavTree />` inside `.workspace` when `props.minimal`, and pass toggle props to `<Crumbs />`.

---

### Task 4: E2E tests, `AGENTS.md`, full verification & push

**Files:**
- Create: `e2e/minimal-navigation.spec.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1:** Update the user scenarios table in `AGENTS.md` with the navigation tree and editor level-fold toggle.
- [ ] **Step 2:** Write Playwright tests in `e2e/minimal-navigation.spec.ts` covering branches-only display, independent tree vs editor folding, locate & collapse-all buttons, editor `.level-toggle`, and mobile overlay behavior.
- [ ] **Step 3:** Run unit tests (`npm test`), production build (`npm run build`), and Playwright suites `minimal` and `minimal-pwa`.
- [ ] **Step 4:** Commit all changes and push to `origin/master`.
