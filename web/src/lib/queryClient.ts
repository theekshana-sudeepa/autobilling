import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Billing data is read far more often than it changes, but staleness is
 * costly: an operator must never look at an "unpaid" badge that was settled
 * two minutes ago. 30s stale time with refetch-on-focus is the compromise.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // Never retry auth or validation failures — they will not fix themselves.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: 0 },
  },
});

export const qk = {
  dashboard: ['dashboard'] as const,
  clients: (params?: unknown) => ['clients', params ?? {}] as const,
  client: (id: string) => ['client', id] as const,
  subscriptions: (params?: unknown) => ['subscriptions', params ?? {}] as const,
  subscription: (id: string) => ['subscription', id] as const,
  invoices: (params?: unknown) => ['invoices', params ?? {}] as const,
  invoice: (id: string) => ['invoice', id] as const,
  invoiceTimeline: (id: string) => ['invoice-timeline', id] as const,
  payments: (params?: unknown) => ['payments', params ?? {}] as const,
  emailLogs: (params?: unknown) => ['email-logs', params ?? {}] as const,
  settings: ['settings'] as const,
  users: ['users'] as const,
  upcoming: ['upcoming-billing'] as const,
};
