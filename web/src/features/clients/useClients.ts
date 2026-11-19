import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError, type PageMeta } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import type { Client } from '@/types/api';

/**
 * The client form schema lives here, next to the mutation, and mirrors the
 * server's Zod schema field-for-field. Duplication is deliberate: the browser
 * gets instant feedback, the server never trusts it. Both must stay in sync —
 * the shared shape is the contract, and a mismatch surfaces as a 422 whose
 * field errors we map straight back onto the form.
 */
export const clientFormSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required').max(180),
  contactPerson: z.string().trim().max(120).optional().or(z.literal('')),
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email'),
  billingEmail: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  ccEmails: z.string().trim().max(500).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  whatsapp: z.string().trim().max(40).optional().or(z.literal('')),
  addressLine1: z.string().trim().max(180).optional().or(z.literal('')),
  addressLine2: z.string().trim().max(180).optional().or(z.literal('')),
  city: z.string().trim().max(90).optional().or(z.literal('')),
  country: z.string().trim().max(90).optional().or(z.literal('')),
  taxId: z.string().trim().max(60).optional().or(z.literal('')),
  notes: z.string().trim().max(5000).optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export type ClientFormValues = z.infer<typeof clientFormSchema>;

export interface ClientListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  sortBy?: 'companyName' | 'createdAt' | 'code';
  sortDir?: 'asc' | 'desc';
}

export function useClients(params: ClientListParams) {
  return useQuery({
    queryKey: qk.clients(params),
    queryFn: () => api.list<Client[]>('/clients', params as Record<string, string | number>),
    placeholderData: (previous) => previous, // keeps the table steady while paging
  });
}

export function useClient(id: string) {
  return useQuery({
    queryKey: qk.client(id),
    queryFn: () => api.get<Client & { subscriptions: unknown[]; invoices: unknown[]; stats: { outstanding: number; lifetimeValue: number } }>(`/clients/${id}`),
    enabled: Boolean(id),
  });
}

/** Strips empty strings so optional fields arrive as undefined, not "". */
const clean = (values: ClientFormValues): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== undefined));

export function useCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: ClientFormValues) => api.post<Client>('/clients', clean(values)),
    onSuccess: (client) => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
      toast.success(`${client.companyName} added`, { description: `Client code ${client.code}` });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('Duplicate client', { description: error.message });
      } else if (!(error instanceof ApiError && error.status === 422)) {
        toast.error('Could not add client', { description: (error as Error).message });
      }
    },
  });
}

export function useUpdateClient(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: Partial<ClientFormValues>) => api.patch<Client>(`/clients/${id}`, values),
    onSuccess: (client) => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: qk.client(id) });
      toast.success(`${client.companyName} updated`);
    },
    onError: (error) => toast.error('Could not save changes', { description: (error as Error).message }),
  });
}

export function useDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/clients/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      toast.success('Client removed');
    },
    onError: (error) => {
      // The server refuses to delete clients with unpaid invoices — surface
      // exactly why rather than a generic failure.
      toast.error('Cannot delete this client', { description: (error as Error).message, duration: 8000 });
    },
  });
}

export type { PageMeta };
