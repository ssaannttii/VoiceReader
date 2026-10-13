import { describe, expect, it } from 'vitest';
import { chapterSeconds, estimatedSecondsAt } from './chapter-progress';
import {
  canHideChrome,
  CHROME_SHOWN,
  distinctSource,
  durationParts,
  reduceChrome,
  SCROLL_HIDE_PX,
  SCROLL_SHOW_PX,
  scrubRange,
  scrubTimes,
  snapToMark,
  SNAP_BREAK_PX,
  SNAP_PX,
  tapOutcome,
  voiceAvatar,
  type ChromeInputs,
} from './player-chrome';

const playing: ChromeInputs = {
  enabled: true,
  playing: true,
  sheetOpen: false,
  attention: false,
  focused: false,
  audioOnly: false,
};
const hidden = { hidden: true, scroll: 0 };

describe('canHideChrome', () => {
  it('hides only while this document plays undisturbed', () => {
    expect(canHideChrome(playing)).toBe(true);
    for (const patch of [
      { enabled: false },
      { playing: false },
      { sheetOpen: true },
      { attention: true },
      { focused: true },
      { audioOnly: true },
    ])
      expect(canHideChrome({ ...playing, ...patch })).toBe(false);
  });
});

describe('reduceChrome', () => {
  it('hides on timeout and toggles on tap', () => {
    const afterTimeout = reduceChrome(CHROME_SHOWN, { type: 'timeout' }, true);
    expect(afterTimeout.hidden).toBe(true);
    expect(reduceChrome(afterTimeout, { type: 'toggle' }, true).hidden).toBe(false);
    expect(reduceChrome(CHROME_SHOWN, { type: 'toggle' }, true).hidden).toBe(true);
  });

  it('shows on any interaction', () => {
    expect(reduceChrome(hidden, { type: 'interact' }, true)).toEqual(CHROME_SHOWN);
    expect(reduceChrome(CHROME_SHOWN, { type: 'interact' }, true)).toBe(CHROME_SHOWN);
  });

  it('never stays hidden when it cannot hide (paused, a sheet open…)', () => {
    for (const type of ['toggle', 'interact', 'timeout'] as const)
      expect(reduceChrome(hidden, { type }, false)).toEqual(CHROME_SHOWN);
    expect(reduceChrome(hidden, { type: 'scroll', dy: 500 }, false)).toEqual(CHROME_SHOWN);
  });

  it('hides after a downward scroll and shows after a shorter upward one', () => {
    let state = reduceChrome(CHROME_SHOWN, { type: 'scroll', dy: SCROLL_HIDE_PX - 10 }, true);
    expect(state.hidden).toBe(false);
    state = reduceChrome(state, { type: 'scroll', dy: 10 }, true);
    expect(state.hidden).toBe(true);
    state = reduceChrome(state, { type: 'scroll', dy: -(SCROLL_SHOW_PX - 1) }, true);
    expect(state.hidden).toBe(true);
    state = reduceChrome(state, { type: 'scroll', dy: -1 }, true);
    expect(state.hidden).toBe(false);
  });

  it('restarts the count when the scroll direction changes', () => {
    let state = reduceChrome(CHROME_SHOWN, { type: 'scroll', dy: 40 }, true);
    state = reduceChrome(state, { type: 'scroll', dy: -10 }, true);
    state = reduceChrome(state, { type: 'scroll', dy: 40 }, true);
    expect(state.hidden).toBe(false);
    expect(state.scroll).toBe(40);
  });
});

describe('tapOutcome', () => {
  it('a tap while the chrome is hidden only reveals it', () => {
    expect(tapOutcome({ chromeHidden: true, doubleTap: false, onSentence: true })).toBe('toggle');
  });
  it('seeks on a sentence unless double tap to play is on', () => {
    expect(tapOutcome({ chromeHidden: false, doubleTap: false, onSentence: true })).toBe('seek');
    expect(tapOutcome({ chromeHidden: false, doubleTap: true, onSentence: true })).toBe('toggle');
  });
  it('a tap beside the text toggles', () => {
    expect(tapOutcome({ chromeHidden: false, doubleTap: false, onSentence: false })).toBe('toggle');
  });
});

describe('scrubRange', () => {
  const chapters = [
    { title: 'One', segment: 2 },
    { title: 'Two', segment: 10 },
  ];
  it('spans the whole text without chapters', () => {
    expect(scrubRange([], 50, 7)).toEqual({ start: 0, end: 50, chapter: -1, chaptered: false });
  });
  it('spans the current chapter', () => {
    expect(scrubRange(chapters, 20, 4)).toEqual({ start: 2, end: 10, chapter: 0, chaptered: true });
    expect(scrubRange(chapters, 20, 15)).toEqual({
      start: 10,
      end: 20,
      chapter: 1,
      chaptered: true,
    });
  });
  it('treats the text before chapter one as its own range', () => {
    expect(scrubRange(chapters, 20, 1)).toEqual({ start: 0, end: 2, chapter: -1, chaptered: true });
  });
  it('never returns an empty range', () => {
    const range = scrubRange([{ title: 'Last', segment: 20 }], 20, 20);
    expect(range.end).toBeGreaterThan(range.start);
  });
});

describe('scrubTimes', () => {
  // Every segment lasts 10 s at 1x.
  const secondsAt = (segment: number) => segment * 10;
  it('is chapter-relative when the range is a chapter', () => {
    const range = scrubRange([{ title: 'A', segment: 10 }], 30, 12);
    expect(scrubTimes(range, 125, 300, 1, secondsAt)).toEqual({
      left: 25,
      right: 200,
      rightIsRemaining: false,
      remaining: 175,
    });
  });
  it('divides by the speed', () => {
    const range = scrubRange([{ title: 'A', segment: 10 }], 30, 12);
    expect(scrubTimes(range, 120, 300, 2, secondsAt)).toMatchObject({
      left: 10,
      right: 100,
      remaining: 90,
    });
  });
  it('shows elapsed and remaining for the whole text', () => {
    const range = scrubRange([], 30, 3);
    expect(scrubTimes(range, 30, 300, 1, secondsAt)).toEqual({
      left: 30,
      right: 270,
      rightIsRemaining: true,
      remaining: 270,
    });
  });
  it('clamps the chapter time inside the chapter', () => {
    const range = scrubRange([{ title: 'A', segment: 10 }], 30, 12);
    expect(scrubTimes(range, 50, 300, 1, secondsAt).left).toBe(0);
    expect(scrubTimes(range, 900, 300, 1, secondsAt).left).toBe(200);
  });
});

describe('chapter lengths', () => {
  it('measures each chapter up to the next one (the last to the end)', () => {
    const chapters = [
      { title: 'A', segment: 0 },
      { title: 'B', segment: 3 },
    ];
    expect(chapterSeconds(chapters, 5, (segment) => segment * 10)).toEqual([30, 20]);
  });
  it('estimates from the text when the document is not in the player', () => {
    const at = estimatedSecondsAt([{ text: 'x'.repeat(30) }, { text: 'y'.repeat(45) }]);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(2);
    expect(at(2)).toBe(5);
    expect(at(99)).toBe(5);
  });
});

describe('durationParts', () => {
  it('splits hours and minutes, keeping at least a minute while time remains', () => {
    expect(durationParts(0)).toEqual({ hours: 0, minutes: 0 });
    expect(durationParts(12)).toEqual({ hours: 0, minutes: 1 });
    expect(durationParts(8040)).toEqual({ hours: 2, minutes: 14 });
    expect(durationParts(3599)).toEqual({ hours: 1, minutes: 0 });
    expect(durationParts(Number.NaN)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('snapToMark', () => {
  it('snaps near the mark and breaks free only further away', () => {
    expect(snapToMark(100 + SNAP_PX, 100, false)).toBe(true);
    expect(snapToMark(100 + SNAP_PX + 1, 100, false)).toBe(false);
    expect(snapToMark(100 + SNAP_BREAK_PX, 100, true)).toBe(true);
    expect(snapToMark(100 - SNAP_BREAK_PX - 1, 100, true)).toBe(false);
  });
});

describe('distinctSource', () => {
  it('drops a source that only repeats the title', () => {
    expect(distinctSource('El Pozo de la Ascensión', 'El Pozo de la Ascension (Ed. il).epub')).toBe(
      null,
    );
    expect(distinctSource('Article', 'example.com')).toBe('example.com');
    expect(distinctSource('Article', '  ')).toBe(null);
    expect(distinctSource('Article', null)).toBe(null);
  });
});

describe('voiceAvatar', () => {
  it('is stable per voice and differs between voices', () => {
    expect(voiceAvatar('voice-1', 'Lucía')).toEqual(voiceAvatar('voice-1', 'Lucía'));
    expect(voiceAvatar('voice-1', 'Lucía').hue).not.toBe(voiceAvatar('voice-2', 'Lucía').hue);
    expect(voiceAvatar('voice-1', 'Lucía').background).toMatch(/^linear-gradient\(/);
  });
  it('uses the first letter of the name', () => {
    expect(voiceAvatar('a', 'émile').initial).toBe('É');
    expect(voiceAvatar('a', '  (María)').initial).toBe('M');
    expect(voiceAvatar('a', '').initial).toBe('•');
  });
});
