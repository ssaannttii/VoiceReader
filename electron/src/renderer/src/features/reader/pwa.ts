/**
 * Web-build-only Reader conveniences: the app-shell service worker and the
 * phone launch redirect. Both are inert in Electron (`__WEB_DEPLOYMENT__` is
 * false there, so bundlers drop the bodies).
 */

const launchedAtHome =
  typeof window !== 'undefined' && ['', '#', '#/'].includes(window.location.hash);
let launchChecked = false;

function phoneLike(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(max-width: 767px)').matches
  );
}

/**
 * True once, for the first visit of `/` in this page load, when the web UI
 * was opened on a phone-sized or touch device. Later visits to Home (from
 * the Reader's Studio button) stay on Home.
 */
export function shouldOpenReaderAtLaunch(): boolean {
  if (!__WEB_DEPLOYMENT__ || launchChecked) return false;
  launchChecked = true;
  return launchedAtHome && phoneLike();
}

/** Register the app-shell service worker on secure web origins (HTTPS or localhost). */
export function registerReaderServiceWorker(): void {
  if (!__WEB_DEPLOYMENT__ || import.meta.env.DEV) return;
  if (typeof window === 'undefined' || !window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/reader-sw.js', { scope: '/' }).catch(() => {
      // The app works without it; only offline app-shell loading is lost.
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
