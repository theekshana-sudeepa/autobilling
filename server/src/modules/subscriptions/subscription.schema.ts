import { z } from 'zod';

export const createSubscriptionSchema = z.object({
  clientId: z.string().cuid(),
  serviceName: z.string().trim().min(2, 'Service name is required').max(180),
  description: z.string().trim().max(2000).optional(),
  amount: z.coerce.number().positive('Amount must be greater than zero').max(99_999_999),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  currency: z.string().trim().toUpperCase().length(3).default('LKR'),
  billingCycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).default('MONTHLY'),
  // 1..28 only: guarantees the due date exists in February and in every
  // 30-day month, so we never have to invent a "31st → 28th" fallback.
  dueDay: z.coerce.number().int().min(1, 'Due day must be 1–28').max(28, 'Due day must be 1–28'),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).default('ACTIVE'),
  autoSend: z.boolean().default(true),
}).refine((v) => !v.endDate || v.endDate > v.startDate, {
  message: 'End date must be after the start date',
  path: ['endDate'],
});

export const updateSubscriptionSchema = z.object({
  serviceName: z.string().trim().min(2).max(180).optional(),
  description: z.string().trim().max(2000).optional(),
  amount: z.coerce.number().positive().max(99_999_999).optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  billingCycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).optional(),
  dueDay: z.coerce.number().int().min(1).max(28).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
  autoSend: z.boolean().optional(),
});

export const listSubscriptionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  clientId: z.string().cuid().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
  search: z.string().trim().max(120).optional(),
});

export const idParamSchema = z.object({ id: z.string().cuid() });

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;
