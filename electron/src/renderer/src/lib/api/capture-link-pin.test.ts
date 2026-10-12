import { describe, expect, it, vi } from 'vitest';
import { captureLinkPin } from './client';

function fakeWindow(href: string) {
  const store = new Map<string, string>();
  const replaceState = vi.fn();
  return {
    win: {
      location: { href } as Location,
      history: { state: null, replaceState } as unknown as History,
      sessionStorage: { setItem: (k: string, v: string) => store.set(k, v) } as unknown as Storage,
    },
    store,
    replaceState,
  };
}

describe('captureLinkPin', () => {
  it('stores the PIN from a QR link and scrubs it, keeping the hash route', () => {
    const { win, store, replaceState } = fakeWindow(
      'http://192.168.1.5:3910/?pin=48151623#/reader',
    );
    captureLinkPin(win);
    expect(store.get('ov_pin')).toBe('48151623');
    expect(replaceState).toHaveBeenCalledWith(null, '', 'http://192.168.1.5:3910/#/reader');
  });

  it('leaves links without a PIN untouched', () => {
    const { win, store, replaceState } = fakeWindow('http://192.168.1.5:3910/#/reader');
    captureLinkPin(win);
    expect(store.size).toBe(0);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
