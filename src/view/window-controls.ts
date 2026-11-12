/**
 * iPadOS 26 draws the window controls (the three dots) over the top-left
 * corner of a Home Screen app that runs in a window, on top of the header.
 * WebKit tells the page nothing about them, so the control exclusion zone is a
 * guess from the geometry: an iPad app that does not fill the screen is in a
 * window. The leading title avoids this zone; right-hand controls stay put.
 * Full screen and every other platform leave the insets at 0.
 */

/** Room the controls take from the window's left edge, px (the pill ends ~61 px in). */
export const CONTROLS_INSET = 76;
/** Vertical exclusion zone measured from the web viewport top. */
export const CONTROLS_TOP = 52;

/**
 * A window narrower or shorter than the screen by more than this is a window, px.
 * Full screen is already ~24-60 px shorter than `screen` (the status bar), so
 * the line is well above that; the user's window was ~217 pt shorter.
 */
const WINDOWED_MIN = 100;

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** iPadOS reports itself as a Mac with a touch screen. */
const ipad = () => /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** How far the controls reach from the left edge: 0 when there are none. */
export function controlsInset(win: { w: number; h: number }, screen: { w: number; h: number }): number {
  const windowed = screen.w - win.w > WINDOWED_MIN || screen.h - win.h > WINDOWED_MIN;
  return windowed ? CONTROLS_INSET : 0;
}

/** Keeps the control exclusion zone on <html> in step with the window. */
export function watchWindowControls(): () => void {
  if (typeof window === 'undefined' || !ipad() || !standalone()) return () => {};
  const root = document.documentElement;
  let previousWidth = innerWidth;
  let previousHeight = innerHeight;
  const update = () => {
    // A software keyboard can shrink innerHeight as well as visualViewport.
    // Keep the window classification while editing at the same window width.
    const active = document.activeElement;
    const editing = active instanceof HTMLElement &&
      (active.isContentEditable || active.matches('input, textarea'));
    if (editing && innerWidth === previousWidth && innerHeight < previousHeight) return;
    previousWidth = innerWidth;
    previousHeight = innerHeight;
    // Either orientation of `screen`: it does not turn with the device on every iPadOS.
    const long = Math.max(screen.width, screen.height);
    const short = Math.min(screen.width, screen.height);
    const landscape = innerWidth >= innerHeight;
    const inset = controlsInset(
      { w: innerWidth, h: innerHeight },
      landscape ? { w: long, h: short } : { w: short, h: long },
    );
    root.style.setProperty('--controls-left', `${inset}px`);
    root.style.setProperty('--controls-top', `${inset ? CONTROLS_TOP : 0}px`);
  };
  update();
  addEventListener('resize', update);
  addEventListener('orientationchange', update);
  visualViewport?.addEventListener('resize', update);
  return () => {
    removeEventListener('resize', update);
    removeEventListener('orientationchange', update);
    visualViewport?.removeEventListener('resize', update);
    root.style.removeProperty('--controls-left');
    root.style.removeProperty('--controls-top');
  };
}
