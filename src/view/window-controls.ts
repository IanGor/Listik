/**
 * iPadOS 26 draws the window controls (the three dots) over the top-left
 * corner of a Home Screen app that runs in a window, on top of the header.
 * WebKit tells the page nothing about them, so the header's left inset is a
 * guess from the geometry: an iPad app that does not fill the screen is in a
 * window. Full screen and every other platform leave the inset at 0, and the
 * logo where it was.
 */

/** Room the controls take from the window's left edge, px (the pill ends ~61 px in). */
export const CONTROLS_INSET = 76;

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

/** Keeps `--controls-left` on <html> in step with the window; returns the stop function. */
export function watchWindowControls(): () => void {
  if (typeof window === 'undefined' || !ipad() || !standalone()) return () => {};
  const root = document.documentElement;
  const update = () => {
    // Either orientation of `screen`: it does not turn with the device on every iPadOS.
    const long = Math.max(screen.width, screen.height);
    const short = Math.min(screen.width, screen.height);
    const landscape = innerWidth >= innerHeight;
    const inset = controlsInset(
      { w: innerWidth, h: innerHeight },
      landscape ? { w: long, h: short } : { w: short, h: long },
    );
    root.style.setProperty('--controls-left', `${inset}px`);
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
  };
}
