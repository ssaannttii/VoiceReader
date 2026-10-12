import type { TFunction } from 'i18next';

/** The backend's admin refusal: a phone or another computer asked for a
 * setting only the PC running VoiceStudio may read or change. Checked by
 * status rather than `instanceof ApiError` so module mocks in tests keep
 * working. */
export function isHostOnlyError(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 403;
}

/** "Only available on the computer running VoiceStudio" when any of `errors`
 * is that refusal, else the generic error text. */
export function settingsErrorText(t: TFunction, ...errors: unknown[]): string {
  return errors.some(isHostOnlyError) ? t('settings.host_only_section') : t('common.error');
}
