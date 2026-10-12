import { expect, it } from 'vitest';
import { isHostOnlyError, settingsErrorText } from './settings-error';

const t = ((key: string) => key) as never;

it('labels admin refusals as host-only and everything else as a generic error', () => {
  expect(isHostOnlyError({ status: 403 })).toBe(true);
  expect(isHostOnlyError({ status: 500 })).toBe(false);
  expect(isHostOnlyError(null)).toBe(false);
  expect(settingsErrorText(t, null, { status: 403 })).toBe('settings.host_only_section');
  expect(settingsErrorText(t, new Error('boom'))).toBe('common.error');
  expect(settingsErrorText(t)).toBe('common.error');
});
