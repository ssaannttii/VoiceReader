import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly detail: string,
    ) {
      super(detail);
    }
  }
  return { ApiError, api: vi.fn() };
});
vi.mock('@/lib/api/client', () => ({
  ApiError: mock.ApiError,
  apiJson: mock.api,
  describeError: String,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/use-backend-status', () => ({ useBackendStatus: () => ({ stage: 'ready' }) }));
vi.mock('@/hooks/use-performance-profile', async (original) => ({
  ...(await original<object>()),
  usePerformanceProfile: () => ({
    data: undefined,
    error: new mock.ApiError(403, 'loopback origin required'),
    isError: true,
    isSaving: false,
    setTier: vi.fn(),
  }),
}));
import { PerformanceModelPacks } from './model-library';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('explains that packs are managed on the host when a LAN client is refused', async () => {
  mock.api.mockImplementation(async (path: string) =>
    path === '/models' ? { models: [] } : path === '/models/install/status' ? { jobs: [] } : {},
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PerformanceModelPacks />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('models.pack_host_only')).toBeVisible();
  expect(screen.queryByText('common.error')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument();
});
