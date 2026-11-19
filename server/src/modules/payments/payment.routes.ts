import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, pageMeta, paginated } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../middleware/audit.js';
import * as svc from './payment.service.js';

const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CARD', 'CHEQUE', 'ONLINE', 'OTHER'] as const;

export const recordPaymentSchema = z.object({
  invoiceId: z.string().cuid(),
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
  reference: z.string().trim().max(120).optional(),
  paidAt: z.coerce.date().max(new Date(Date.now() + 86_400_000), 'Payment date cannot be in the future'),
  notes: z.string().trim().max(2000).optional(),
  sendReceipt: z.boolean().default(true),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  clientId: z.string().cuid().optional(),
  invoiceId: z.string().cuid().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().trim().max(120).optional(),
});

const idParam = z.object({ id: z.string().cuid() });

export const paymentRouter = Router();
paymentRouter.use(requireAuth);

paymentRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as svc.ListPaymentsQuery;
    const { items, total, totalCollected } = await svc.listPayments(q);
    paginated(res, items, { ...pageMeta(q.page, q.pageSize, total), ...({ totalCollected } as object) });
  }),
);

paymentRouter.post(
  '/',
  validate({ body: recordPaymentSchema }),
  asyncHandler(async (req, res) => {
    const result = await svc.recordPayment({ ...req.body, recordedById: req.user!.sub });
    await audit({
      action: 'payment.recorded',
      entity: 'Payment',
      entityId: result.payment.id,
      after: { ...result.payment, invoiceStatus: result.invoice.status },
      req,
    });
    ok(res, result, 201);
  }),
);

paymentRouter.post(
  '/:id/void',
  requireRole('ADMIN'),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(255) }) }),
  asyncHandler(async (req, res) => {
    const result = await svc.voidPayment(req.params.id!, req.body.reason);
    await audit({ action: 'payment.voided', entity: 'Payment', entityId: req.params.id!, after: result.payment, req });
    ok(res, result);
  }),
);
