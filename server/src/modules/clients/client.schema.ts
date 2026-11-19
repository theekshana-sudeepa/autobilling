import { z } from 'zod';

const emailList = z
  .string()
  .trim()
  .max(500)
  .optional()
  .refine(
    (v) => !v || v.split(',').every((e) => z.string().email().safeParse(e.trim()).success),
    'ccEmails must be a comma-separated list of valid email addresses',
  );

export const createClientSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required').max(180),
  contactPerson: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email(),
  billingEmail: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  ccEmails: emailList,
  phone: z.string().trim().max(40).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  addressLine1: z.string().trim().max(180).optional(),
  addressLine2: z.string().trim().max(180).optional(),
  city: z.string().trim().max(90).optional(),
  country: z.string().trim().max(90).optional(),
  taxId: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(5000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const updateClientSchema = createClientSchema.partial();

export const listClientsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  sortBy: z.enum(['companyName', 'createdAt', 'code']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const idParamSchema = z.object({ id: z.string().cuid() });

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
