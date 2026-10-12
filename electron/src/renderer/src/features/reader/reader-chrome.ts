import { getBridge, isMac } from '@/components/bridge';

/** Top-bar classes that keep Electron's window controls clear (no-op on the web). */
export function titlebarChrome(): string {
  if (!getBridge()) return '';
  return isMac() ? 'rd-titlebar rd-chrome-mac' : 'rd-titlebar rd-chrome-win';
}

/** Touch-first device (phone/tablet) rather than a mouse-driven desktop. */
export function isTouchDevice(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/** Fold accents and case so "canción" matches "cancion". */
export function searchKey(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}
