/**
 * Window events that let Reader pieces talk without importing each other.
 *
 * `reader:reveal` — scroll the reading view to a segment without playing it
 * (search results, bookmarks, chapter previews). The text view re-centres its
 * render window when the segment is outside it.
 */
export const REVEAL_EVENT = 'reader:reveal';

export interface RevealDetail {
  segment: number;
}

export function revealSegment(segment: number) {
  window.dispatchEvent(new CustomEvent<RevealDetail>(REVEAL_EVENT, { detail: { segment } }));
}
