import { For, Show, createMemo, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { THEMES, resolveTheme, type ThemeMode } from './palettes';
import { closeThemePanel, omarchyAvailable, preference, setThemeId, setThemeMode, theme, systemTheme, externalPalette } from './theme';

const MODES: { id: ThemeMode; name: string }[] = [{ id: 'dark', name: 'Тёмная' }, { id: 'light', name: 'Светлая' }, { id: 'auto', name: 'Авто' }];
export function ThemePanel() {
  let dialog!: HTMLDialogElement;
  onMount(() => {
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('.theme-modes input:checked')?.focus();
  });
  const note = () => {
    const p = preference();
    if (p.themeId === 'omarchy') return omarchyAvailable() ? 'Цвета и режим задаёт Omarchy' : 'Omarchy недоступна. Пока используется Listik';
    const def = THEMES.find(t => t.id === p.themeId)!;
    if (def.id !== 'listik' && (!def.light || !def.dark)) return `У этой темы только ${def.dark ? 'тёмный' : 'светлый'} вариант`;
    return p.mode === 'auto' ? 'Режим следует настройке устройства' : ' ';
  };
  return <Portal>
    <dialog ref={dialog} class="theme-panel" aria-labelledby="theme-title" onCancel={e => { e.preventDefault(); closeThemePanel(); }} onClick={e => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeThemePanel();
    }}>
      <header><h2 id="theme-title">Тема</h2><button type="button" onClick={closeThemePanel}>Готово</button></header>
      <div class="theme-modes" role="radiogroup" aria-label="Режим темы" style={{ '--mode-index': MODES.findIndex(m => m.id === preference().mode) }}>
        <For each={MODES}>{mode => <label><input type="radio" name="theme-mode" value={mode.id} checked={preference().mode === mode.id} onChange={() => setThemeMode(mode.id)} /><span>{mode.name}</span></label>}</For>
      </div>
      <p class="theme-note" aria-live="polite">{note()}</p>
      <div class="theme-list" role="radiogroup" aria-label="Цветовая тема">
        <For each={THEMES}>{def => {
          const swatch = createMemo(() => resolveTheme({ ...preference(), themeId: def.id }, systemTheme(), { version: 1, managed: omarchyAvailable(), palette: externalPalette() }).palette);
          return <label class="theme-choice" classList={{ selected: preference().themeId === def.id, unavailable: def.id === 'omarchy' && !omarchyAvailable() }}>
            <input type="radio" name="color-theme" value={def.id} checked={preference().themeId === def.id} disabled={def.id === 'omarchy' && !omarchyAvailable()} onChange={() => setThemeId(def.id)} />
            <span class="theme-choice-name">{def.name}<Show when={def.id === 'omarchy' && !omarchyAvailable()}><small>Доступна в настольном Listik с Omarchy</small></Show></span>
            <span class="theme-swatches" aria-hidden="true"><i style={{ background: swatch()?.colors.background ?? (theme() === 'dark' ? '#1c1c1e' : '#ffffff') }} /><i style={{ background: swatch()?.colors.foreground ?? (theme() === 'dark' ? '#f2f2f2' : '#202124') }} /><i style={{ background: swatch()?.colors.accent ?? (theme() === 'dark' ? '#75b4ff' : '#1769c2') }} /></span>
            <span class="theme-check" aria-hidden="true">{preference().themeId === def.id ? '✓' : ''}</span>
          </label>;
        }}</For>
      </div>
    </dialog>
  </Portal>;
}
