import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { BadRequest, Conflict, NotFound } from '../../lib/errors.js';
import { D, money, toNumber } from '../../lib/money.js';
import { dateOnly } from '../../lib/dates.js';
import { logger } from '../../lib/logger.js';
import { recomputeInvoiceStatus } from '../invoices/invoice.service.js';
import { cancelPendingReminders, queueAndSend } from '../../services/email/email.service.js';

export interface RecordPaymentInput {
  invoiceId: string;
  amount: number;
  method: Prisma.PaymentCreateInput['method'];
  reference?: string;
  paidAt: Date;
  notes?: string;
  sendReceipt?: boolean;
  recordedById?: string;
}

/**
 * Recording a payment is the moment reminders must stop. The order matters:
 *
 *   1. insert payment          (money is now recorded)
 *   2. recompute invoice status (derived from payments, single source of truth)
 *   3. cancel pending reminders (only if fully settled)
 *   4. send the receipt        (best-effort; never rolls back the payment)
 *
 * Steps 1–2 are one transaction. Step 4 is outside it on purpose: an email
 * provider outage must not undo a payment the accountant just keyed in.
 */
export async function recordPayment(input: RecordPaymentInput) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    include: { payments: { where: { voidedAt: null } }, client: true },
  });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') throw Conflict('Cannot record a payment against a void invoice');
  if (invoice.status === 'DRAFT') throw Conflict('Send the invoice before recording a payment');

  const alreadyPaid = invoice.payments.reduce((sum, p) => sum.plus(p.amount), D(0));
  const balance = D(invoice.total).minus(alreadyPaid);

  if (D(input.amount).lte(0)) throw BadRequest('Payment amount must be greater than zero');
  // Small tolerance for FX rounding on inbound transfers.
  if (D(input.amount).gt(balance.plus(0.01))) {
    throw BadRequest(
      `Payment of ${input.amount} exceeds the outstanding balance of ${balance.toFixed(2)}`,
      { balance: toNumber(balance) },
    );
  }

  const payment = await prisma.payment.create({
    data: {
      invoiceId: input.invoiceId,
      amount: money(input.amount),
      currency: invoice.currency,
      method: input.method,
      reference: input.reference ?? null,
      paidAt: dateOnly(input.paidAt),
      notes: input.notes ?? null,
      recordedById: input.recordedById ?? null,
    },
  });

  const updated = await recomputeInvoiceStatus(input.invoiceId);

  if (updated.status === 'PAID') {
    const cancelled = await cancelPendingReminders(input.invoiceId);
    logger.info({ invoiceId: input.invoiceId, cancelled }, 'invoice settled — reminders stopped');

    if (input.sendReceipt !== false) {
      // Fire-and-log: a failed receipt is retried by the retry job.
      void queueAndSend({
        type: 'PAYMENT_RECEIVED',
        invoiceId: input.invoiceId,
        payment: { amount: payment.amount, method: payment.method, reference: payment.reference, paidAt: payment.paidAt },
      }).catch((err) => logger.error({ err, invoiceId: input.invoiceId }, 'receipt email failed'));
    }
  }

  return { payment, invoice: updated };
}

/** Reversal, not deletion — the audit trail keeps both rows. */
export async function voidPayment(id: string, reason: string) {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw NotFound('Payment');
  if (payment.voidedAt) throw Conflict('Payment is already void');

  const voided = await prisma.payment.update({
    where: { id },
    data: { voidedAt: new Date(), notes: [payment.notes, `VOIDED: ${reason}`].filter(Boolean).join('\n') },
  });
  const invoice = await recomputeInvoiceStatus(payment.invoiceId);
  return { payment: voided, invoice };
}

export interface ListPaymentsQuery {
  page: number;
  pageSize: number;
  clientId?: string;
  invoiceId?: string;
  method?: Prisma.PaymentCreateInput['method'];
  from?: Date;
  to?: Date;
  search?: string;
}

export async function listPayments(q: ListPaymentsQuery) {
  const where: Prisma.PaymentWhereInput = {
    voidedAt: null,
    ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
    ...(q.clientId ? { invoice: { clientId: q.clientId } } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.from || q.to
      ? { paidAt: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } }
      : {}),
    ...(q.search
      ? {
          OR: [
            { reference: { contains: q.search } },
            { invoice: { invoiceNumber: { contains: q.search } } },
            { invoice: { client: { companyName: { contains: q.search } } } },
          ],
        }
      : {}),
  };

  const [total, items, sum] = await prisma.$transaction([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        invoice: { select: { id: true, invoiceNumber: true, total: true, client: { select: { id: true, companyName: true } } } },
        recordedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.payment.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, totalCollected: toNumber(sum._sum.amount) };
}
