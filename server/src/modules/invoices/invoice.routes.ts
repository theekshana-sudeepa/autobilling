import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, pageMeta, paginated } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { expensiveLimiter } from '../../middleware/rateLimit.js';
import { audit } from '../../middleware/audit.js';
import { prisma } from '../../lib/prisma.js';
import { NotFound, Conflict } from '../../lib/errors.js';
import { buildInvoicePdf, getOrBuildInvoicePdf, invalidateInvoicePdf } from '../../services/pdf/invoicePdf.js';
import { queueAndSend } from '../../services/email/email.service.js';
import { generateInvoicesForDate } from '../../jobs/generateInvoices.job.js';
import * as svc from './invoice.service.js';

const INVOICE_STATUS = ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID'] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(INVOICE_STATUS).optional(),
  clientId: z.string().cuid().optional(),
  subscriptionId: z.string().cuid().optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  sortBy: z.enum(['issueDate', 'dueDate', 'total', 'invoiceNumber']).default('issueDate'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

const createSchema = z.object({
  clientId: z.string().cuid(),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(255),
        quantity: z.coerce.number().positive().default(1),
        unitPrice: z.coerce.number().nonnegative(),
        taxRate: z.coerce.number().min(0).max(100).default(0),
      }),
    )
    .min(1, 'At least one line item is required'),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date(),
  currency: z.string().length(3).optional(),
  discount: z.coerce.number().nonnegative().default(0),
  notes: z.string().trim().max(2000).optional(),
});

const idParam = z.object({ id: z.string().cuid() });

export const invoiceRouter = Router();
invoiceRouter.use(requireAuth);

invoiceRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as svc.ListInvoicesQuery;
    const { items, total, summary } = await svc.listInvoices(q);
    paginated(res, items, { ...pageMeta(q.page, q.pageSize, total), ...({ summary } as object) });
  }),
);

invoiceRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await svc.getInvoice(req.params.id!))),
);

invoiceRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const invoice = await svc.createManualInvoice(req.body);
    await audit({ action: 'invoice.created_manual', entity: 'Invoice', entityId: invoice.id, after: invoice, req });
    ok(res, invoice, 201);
  }),
);

// ---------------------------------------------------------------- PDF
invoiceRouter.get(
  '/:id/pdf',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id! }, select: { invoiceNumber: true } });
    if (!invoice) throw NotFound('Invoice');
    const pdf = await getOrBuildInvoicePdf(req.params.id!);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNumber}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(pdf.buffer);
  }),
);

invoiceRouter.post(
  '/:id/regenerate-pdf',
  expensiveLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await invalidateInvoicePdf(req.params.id!);
    const pdf = await buildInvoicePdf(req.params.id!);
    ok(res, { filePath: pdf.filePath, hash: pdf.hash });
  }),
);

// ---------------------------------------------------------------- sending
invoiceRouter.post(
  '/:id/send',
  expensiveLimiter,
  validate({ params: idParam, body: z.object({ force: z.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const result = await queueAndSend({
      type: 'INVOICE_CREATED',
      invoiceId: req.params.id!,
      attachPdf: true,
      force: req.body.force,
    });
    await audit({ action: 'invoice.sent', entity: 'Invoice', entityId: req.params.id!, after: result, req });
    ok(res, result);
  }),
);

invoiceRouter.post(
  '/:id/remind',
  expensiveLimiter,
  validate({
    params: idParam,
    body: z.object({
      type: z.enum(['REMINDER_BEFORE_7', 'REMINDER_BEFORE_3', 'REMINDER_DUE_TODAY', 'REMINDER_OVERDUE_3', 'REMINDER_OVERDUE_7', 'FINAL_NOTICE']),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await queueAndSend({ type: req.body.type, invoiceId: req.params.id!, force: true });
    await audit({ action: 'invoice.reminder_sent', entity: 'Invoice', entityId: req.params.id!, after: result, req });
    ok(res, result);
  }),
);

// ---------------------------------------------------------------- lifecycle
invoiceRouter.post(
  '/:id/void',
  requireRole('ADMIN'),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(255) }) }),
  asyncHandler(async (req, res) => {
    const invoice = await svc.voidInvoice(req.params.id!, req.body.reason);
    await audit({ action: 'invoice.voided', entity: 'Invoice', entityId: invoice.id, after: invoice, req });
    ok(res, invoice);
  }),
);

/** Manual trigger for the generation job — used for "run billing now". */
invoiceRouter.post(
  '/generate',
  requireRole('ADMIN'),
  expensiveLimiter,
  validate({ body: z.object({ date: z.coerce.date().optional(), dryRun: z.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const summary = await generateInvoicesForDate({ date: req.body.date, dryRun: req.body.dryRun, trigger: 'manual' });
    await audit({ action: 'job.generate_invoices_manual', entity: 'JobRun', after: summary, req });
    ok(res, summary);
  }),
);

/** Preview what the generator would do — no writes. */
invoiceRouter.get(
  '/upcoming/preview',
  asyncHandler(async (_req, res) => {
    const summary = await generateInvoicesForDate({ dryRun: true, trigger: 'preview' });
    ok(res, summary);
  }),
);

export { Conflict };
