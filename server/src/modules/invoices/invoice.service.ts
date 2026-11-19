import { Prisma, type Invoice, type Subscription, type Client } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { nextInvoiceNumber } from '../../lib/numbering.js';
import { computeTotals, D, money, toNumber } from '../../lib/money.js';
import { businessToday, dateOnly, periodFrom, periodLabel } from '../../lib/dates.js';
import { BadRequest, Conflict, NotFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getSettings } from '../settings/settings.service.js';
import type { BillingPeriod } from '../../lib/dates.js';

export type InvoiceWithRelations = Invoice & {
  client: Client;
  items: { id: string; description: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; lineTotal: Prisma.Decimal }[];
  payments?: { id: string; amount: Prisma.Decimal; paidAt: Date; method: string; reference: string | null }[];
};

export interface GenerateResult {
  invoice: Invoice | null;
  created: boolean;
  reason?: 'already_exists' | 'subscription_inactive' | 'client_inactive' | 'period_out_of_range';
}

/**
 * ---------------------------------------------------------------------------
 * IDEMPOTENT INVOICE GENERATION
 * ---------------------------------------------------------------------------
 * There are exactly two safeguards, and the second one is the real one:
 *
 *   1. A pre-check `findUnique` on (subscriptionId, periodStart) — cheap, and
 *      handles 99.9% of repeat runs.
 *   2. A UNIQUE INDEX on the same pair. If two cron workers, a manual retry
 *      and a scheduled run all race, MySQL rejects the loser with P2002 and we
 *      convert that into a benign "already exists" instead of an error.
 *
 * Never rely on 1 alone. Application-level checks are advisory; the database
 * constraint is the contract.
 */
export async function generateInvoiceForPeriod(
  subscription: Subscription & { client: Client },
  period: BillingPeriod,
  opts: { issueDate?: Date; actor?: string } = {},
): Promise<GenerateResult> {
  if (subscription.status !== 'ACTIVE') return { invoice: null, created: false, reason: 'subscription_inactive' };
  if (subscription.client.status !== 'ACTIVE' || subscription.client.deletedAt) {
    return { invoice: null, created: false, reason: 'client_inactive' };
  }
  if (subscription.endDate && period.periodStart > dateOnly(subscription.endDate)) {
    return { invoice: null, created: false, reason: 'period_out_of_range' };
  }

  const existing = await prisma.invoice.findUnique({
    where: { uniq_subscription_period: { subscriptionId: subscription.id, periodStart: period.periodStart } },
  });
  if (existing) return { invoice: existing, created: false, reason: 'already_exists' };

  const settings = await getSettings();
  const issueDate = dateOnly(opts.issueDate ?? businessToday(settings.timezone));

  const totals = computeTotals({ subtotal: subscription.amount, taxRate: subscription.taxRate });
  const label = periodLabel(period.periodStart, period.periodEnd);

  try {
    const invoice = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await nextInvoiceNumber(settings.invoicePrefix, issueDate, tx);

      const created = await tx.invoice.create({
        data: {
          invoiceNumber,
          clientId: subscription.clientId,
          subscriptionId: subscription.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          issueDate,
          dueDate: period.dueDate,
          currency: subscription.currency,
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          discount: totals.discount,
          total: totals.total,
          status: 'DRAFT',
          items: {
            create: [
              {
                description: `${subscription.serviceName} — ${label}`,
                quantity: D(1),
                unitPrice: money(subscription.amount),
                taxRate: subscription.taxRate,
                lineTotal: money(subscription.amount),
                sortOrder: 0,
              },
            ],
          },
        },
      });

      await tx.subscription.update({
        where: { id: subscription.id },
        data: { lastInvoicedAt: period.periodStart },
      });

      return created;
    });

    logger.info(
      { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, subscriptionId: subscription.id, period: label },
      'invoice generated',
    );
    return { invoice, created: true };
  } catch (err) {
    // ONLY a collision on (subscriptionId, periodStart) is a benign race: it
    // means another writer already produced this exact invoice.
    //
    // Every other unique violation is a real fault. Treating them all as races
    // is how a broken invoice-number sequence reported itself as "skipped"
    // while the client silently went unbilled — the job returned SUCCESS with
    // zero failures and nobody found out for a month.
    if (isUniqueViolation(err)) {
      const winner = await prisma.invoice.findUnique({
        where: { uniq_subscription_period: { subscriptionId: subscription.id, periodStart: period.periodStart } },
      });
      if (winner) {
        logger.warn({ subscriptionId: subscription.id }, 'invoice generation raced — returning existing invoice');
        return { invoice: winner, created: false, reason: 'already_exists' };
      }
      logger.error(
        { err, subscriptionId: subscription.id, period: label },
        'unique violation with no existing invoice for this period — NOT a race',
      );
    }
    throw err;
  }
}

/** Ad-hoc invoice not tied to a subscription (setup fees, hardware, one-offs). */
export async function createManualInvoice(input: {
  clientId: string;
  items: { description: string; quantity: number; unitPrice: number; taxRate?: number }[];
  issueDate?: Date;
  dueDate: Date;
  currency?: string;
  discount?: number;
  notes?: string;
  periodStart?: Date;
  periodEnd?: Date;
}) {
  const client = await prisma.client.findFirst({ where: { id: input.clientId, deletedAt: null } });
  if (!client) throw NotFound('Client');
  if (input.items.length === 0) throw BadRequest('An invoice needs at least one line item');

  const settings = await getSettings();
  const issueDate = dateOnly(input.issueDate ?? businessToday(settings.timezone));
  const dueDate = dateOnly(input.dueDate);
  if (dueDate < issueDate) throw BadRequest('Due date cannot be before the issue date');

  const lines = input.items.map((it, idx) => {
    const lineTotal = money(D(it.unitPrice).mul(D(it.quantity)));
    return {
      description: it.description,
      quantity: D(it.quantity),
      unitPrice: money(it.unitPrice),
      taxRate: D(it.taxRate ?? 0),
      lineTotal,
      sortOrder: idx,
    };
  });

  const subtotal = lines.reduce((sum, l) => sum.plus(l.lineTotal), D(0));
  const taxAmount = lines.reduce((sum, l) => sum.plus(money(l.lineTotal.mul(l.taxRate).div(100))), D(0));
  const discount = money(input.discount ?? 0);
  const total = money(subtotal.minus(discount).plus(taxAmount));

  return prisma.$transaction(async (tx) => {
    const invoiceNumber = await nextInvoiceNumber(settings.invoicePrefix, issueDate, tx);
    return tx.invoice.create({
      data: {
        invoiceNumber,
        clientId: input.clientId,
        subscriptionId: null,
        periodStart: dateOnly(input.periodStart ?? issueDate),
        periodEnd: dateOnly(input.periodEnd ?? dueDate),
        issueDate,
        dueDate,
        currency: input.currency ?? settings.defaultCurrency,
        subtotal: money(subtotal),
        taxAmount: money(taxAmount),
        discount,
        total,
        notes: input.notes ?? null,
        status: 'DRAFT',
        items: { create: lines },
      },
      include: { client: true, items: true },
    });
  });
}

export interface ListInvoicesQuery {
  page: number;
  pageSize: number;
  status?: Invoice['status'];
  clientId?: string;
  subscriptionId?: string;
  search?: string;
  from?: Date;
  to?: Date;
  overdueOnly?: boolean;
  sortBy: 'issueDate' | 'dueDate' | 'total' | 'invoiceNumber';
  sortDir: 'asc' | 'desc';
}

export async function listInvoices(q: ListInvoicesQuery) {
  const where: Prisma.InvoiceWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}),
    ...(q.overdueOnly ? { status: { in: ['SENT', 'OVERDUE', 'PARTIALLY_PAID'] }, dueDate: { lt: new Date() } } : {}),
    ...(q.from || q.to
      ? { issueDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } }
      : {}),
    ...(q.search
      ? {
          OR: [
            { invoiceNumber: { contains: q.search } },
            { client: { companyName: { contains: q.search } } },
            { client: { code: { contains: q.search } } },
          ],
        }
      : {}),
  };

  const [total, items, aggregate] = await prisma.$transaction([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: { [q.sortBy]: q.sortDir },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        client: { select: { id: true, companyName: true, code: true, email: true } },
        subscription: { select: { id: true, serviceName: true } },
      },
    }),
    prisma.invoice.aggregate({ where, _sum: { total: true, amountPaid: true } }),
  ]);

  return {
    items,
    total,
    summary: {
      totalAmount: toNumber(aggregate._sum.total),
      paidAmount: toNumber(aggregate._sum.amountPaid),
      outstanding: toNumber(aggregate._sum.total) - toNumber(aggregate._sum.amountPaid),
    },
  };
}

export async function getInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      subscription: { select: { id: true, serviceName: true, billingCycle: true, dueDay: true } },
      items: { orderBy: { sortOrder: 'asc' } },
      payments: { where: { voidedAt: null }, orderBy: { paidAt: 'desc' }, include: { recordedBy: { select: { name: true } } } },
      emailLogs: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!invoice) throw NotFound('Invoice');
  return {
    ...invoice,
    balanceDue: toNumber(invoice.total) - toNumber(invoice.amountPaid),
  };
}

/**
 * Single source of truth for invoice status. Called after every payment,
 * void, and by the nightly overdue sweep. Deriving status from money rather
 * than letting handlers set it ad hoc is what keeps the ledger honest.
 */
export async function recomputeInvoiceStatus(invoiceId: string, today = new Date()): Promise<Invoice> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: { where: { voidedAt: null } } },
  });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') return invoice;

  const paid = invoice.payments.reduce((sum, p) => sum.plus(p.amount), D(0));
  const total = D(invoice.total);

  let status: Invoice['status'];
  let paidAt: Date | null = invoice.paidAt;

  if (paid.gte(total) && total.gt(0)) {
    status = 'PAID';
    paidAt =
      invoice.paidAt ??
      invoice.payments.reduce<Date | null>((latest, p) => (!latest || p.paidAt > latest ? p.paidAt : latest), null) ??
      new Date();
  } else if (paid.gt(0)) {
    status = dateOnly(invoice.dueDate) < dateOnly(today) ? 'OVERDUE' : 'PARTIALLY_PAID';
    paidAt = null;
  } else if (dateOnly(invoice.dueDate) < dateOnly(today) && invoice.status !== 'DRAFT') {
    status = 'OVERDUE';
    paidAt = null;
  } else {
    status = invoice.status === 'DRAFT' ? 'DRAFT' : 'SENT';
    paidAt = null;
  }

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status, amountPaid: money(paid), paidAt },
  });
}

export async function voidInvoice(id: string, reason: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { payments: { where: { voidedAt: null } } } });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') throw Conflict('Invoice is already void');
  if (invoice.payments.length > 0) {
    throw Conflict('Void the recorded payments first — an invoice with payments cannot be voided');
  }

  const [updated] = await prisma.$transaction([
    prisma.invoice.update({
      where: { id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
    }),
    // Stop every pending reminder for this invoice.
    prisma.emailLog.updateMany({
      where: { invoiceId: id, status: { in: ['QUEUED', 'FAILED'] } },
      data: { status: 'CANCELLED', nextRetryAt: null },
    }),
  ]);
  return updated;
}

/** Invoices that are past due and still owe money. Used by the overdue sweep. */
export async function findOverdueInvoices(today: Date) {
  return prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'PARTIALLY_PAID'] },
      dueDate: { lt: dateOnly(today) },
    },
    select: { id: true },
  });
}

export const balanceOf = (i: { total: Prisma.Decimal; amountPaid: Prisma.Decimal }): number =>
  toNumber(i.total) - toNumber(i.amountPaid);

export { periodFrom };
