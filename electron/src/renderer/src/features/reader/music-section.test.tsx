import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/query';

const api = vi.hoisted(() => ({
  music: vi.fn(),
  prepareMusic: vi.fn(),
  deleteMusic: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./reader-api', () => ({
  readerApi: api,
  readerKeys: { music: (id: string) => ['reader', 'music', id] },
}));
vi.mock('./reader-music', () => ({
  fetchMusic: async (id: string) =>
    (await import('./music-plan')).sanitizeMusic(await api.music(id)),
  musicQueryKey: (id: string) => ['reader', 'music', id],
  musicController: { refresh: vi.fn(), unlock: vi.fn() },
  useMusicInfo: () => ({ docId: 'doc1', cue: null, mood: 'tension', unreachable: false }),
}));
vi.mock('./reader-player', () => ({ silentWav: () => 'data:audio/wav;base64,' }));
vi.mock('./reader-debug', () => ({ dlog: () => {} }));
vi.mock('./music-clips', () => ({ forgetMusic: vi.fn(() => Promise.resolve()) }));

afterEach(() => {
  cleanup();
  queryClient.clear();
});

const renderSection = async () => {
  const { MusicSection } = await import('./music-section');
  return render(
    <QueryClientProvider client={queryClient}>
      <MusicSection docId="doc1" />
    </QueryClientProvider>,
  );
};

it('turns music on for the document and asks the PC to prepare it', async () => {
  api.music.mockResolvedValue({ status: 'off', engine_available: true, palettes: [] });
  api.prepareMusic.mockResolvedValue({ status: 'queued', engine_available: true });
  await renderSection();
  const toggle = await screen.findByRole('switch', { name: /reader.music_doc/ });
  await waitFor(() => expect(api.music).toHaveBeenCalled());
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  await waitFor(() => expect(api.prepareMusic).toHaveBeenCalledWith('doc1', undefined));
  expect(await screen.findByText('reader.music_status_queued')).toBeTruthy();
  // Mode, volume and style controls appear.
  expect(screen.getByRole('radio', { name: 'reader.music_mode_moments' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '0 dB');
});

it('explains a PC without a music engine and picks a style', async () => {
  const { setMusicOnFor } = await import('./music-prefs');
  setMusicOnFor('doc1', true);
  api.music.mockResolvedValue({
    status: 'unavailable',
    engine_available: false,
    palettes: [{ id: 'dark_fantasy' }, { id: 'weird_future' }],
  });
  await renderSection();
  expect(await screen.findByText('reader.music_engine_missing')).toBeTruthy();
  expect(screen.getByText('reader.music_prepare').closest('button')).toBeDisabled();
  // Unknown palette ids are shown readably.
  expect(screen.getByRole('option', { name: 'Weird future' })).toBeTruthy();
});

it('shows progress, the mood that sounds, and deletes after a second tap', async () => {
  const { setMusicOnFor } = await import('./music-prefs');
  setMusicOnFor('doc1', true);
  api.music.mockResolvedValue({
    status: 'ready',
    progress: 1,
    engine_available: true,
    palette: { id: 'dark_fantasy', source: 'auto' },
    cues: [{ id: 'c1', mood: 'tension', files: [{ name: 'a.ogg', duration: 47 }], ready: true }],
  });
  api.deleteMusic.mockResolvedValue({});
  await renderSection();
  expect(await screen.findByText(/reader.music_now/)).toBeTruthy();
  const remove = screen.getByText('reader.music_delete').closest('button')!;
  fireEvent.click(remove);
  expect(api.deleteMusic).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('reader.music_delete_confirm').closest('button')!);
  await waitFor(() => expect(api.deleteMusic).toHaveBeenCalledWith('doc1'));
  expect(await screen.findByText('reader.music_status_off')).toBeTruthy();
});
