import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok, pageMeta, paginated } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { expensiveLimiter } from '../../middleware/rateLimit.js';
import { audit } from '../../middleware/audit.js';
import { resendEmailLog, nextBackoff } from '../../services/email/email.service.js';
import { reminderTimeline } from '../../jobs/reminders.job.js';

const EMAIL_TYPES = [
  'INVOICE_CREATED',
  'REMINDER_BEFORE_7',
  'REMINDER_BEFORE_3',
  'REMINDER_DUE_TODAY',
  'REMINDER_OVERDUE_3',
  'REMINDER_OVERDUE_7',
  'FINAL_NOTICE',
  'PAYMENT_RECEIVED',
  'WELCOME',
  'TEST',
] as const;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'BOUNCED', 'CANCELLED']).optional(),
  type: z.enum(EMAIL_TYPES).optional(),
  clientId: z.string().cuid().optional(),
  invoiceId: z.string().cuid().optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const idParam = z.object({ id: z.string().cuid() });

export const emailLogRouter = Router();
emailLogRouter.use(requireAuth);

emailLogRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.search
        ? { OR: [{ toEmail: { contains: q.search } }, { subject: { contains: q.search } }, { invoice: { invoiceNumber: { contains: q.search } } }] }
        : {}),
    };

    const [total, items, statusCounts] = await prisma.$transaction([
      prisma.emailLog.count({ where }),
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          invoice: { select: { id: true, invoiceNumber: true } },
          client: { select: { id: true, companyName: true } },
        },
      }),
      prisma.emailLog.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: true }),
    ]);

    paginated(res, items, { ...pageMeta(q.page, q.pageSize, total), ...({ statusCounts } as object) });
  }),
);

emailLogRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const log = await prisma.emailLog.findUnique({
      where: { id: req.params.id! },
      include: { invoice: { select: { id: true, invoiceNumber: true } }, client: true },
    });
    ok(res, log);
  }),
);

/** Operator resend — bypasses the dedupe key by minting a manual one. */
emailLogRouter.post(
  '/:id/resend',
  expensiveLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await resendEmailLog(req.params.id!);
    await audit({ action: 'email.resent', entity: 'EmailLog', entityId: req.params.id!, after: result, req });
    ok(res, result);
  }),
);

/** Put a permanently-failed email back into the retry queue. */
emailLogRouter.post(
  '/:id/requeue',
  requireRole('ADMIN'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const log = await prisma.emailLog.update({
      where: { id: req.params.id! },
      data: { status: 'QUEUED', nextRetryAt: nextBackoff(1), attempts: 1, lastError: null },
    });
    await audit({ action: 'email.requeued', entity: 'EmailLog', entityId: log.id, req });
    ok(res, log);
  }),
);

/** Reminder schedule for one invoice — drives the timeline widget. */
emailLogRouter.get(
  '/timeline/:invoiceId',
  validate({ params: z.object({ invoiceId: z.string().cuid() }) }),
  asyncHandler(async (req, res) => ok(res, await reminderTimeline(req.params.invoiceId!))),
);
