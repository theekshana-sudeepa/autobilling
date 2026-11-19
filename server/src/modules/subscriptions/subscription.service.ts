import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { NotFound, Conflict, BadRequest } from '../../lib/errors.js';
import { dateOnly, firstPeriodStart, nextPeriodStart, periodFrom, businessToday } from '../../lib/dates.js';
import { getSettings } from '../settings/settings.service.js';
import type { CreateSubscriptionInput, ListSubscriptionsQuery } from './subscription.schema.js';

const LIVE = { deletedAt: null } satisfies Prisma.SubscriptionWhereInput;

export async function listSubscriptions(q: ListSubscriptionsQuery) {
  const where: Prisma.SubscriptionWhereInput = {
    ...LIVE,
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.search
      ? { OR: [{ serviceName: { contains: q.search } }, { client: { companyName: { contains: q.search } } }] }
      : {}),
  };

  const [total, items] = await prisma.$transaction([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        client: { select: { id: true, companyName: true, code: true, email: true, status: true } },
        _count: { select: { invoices: true } },
      },
    }),
  ]);

  return { items, total };
}

export async function getSubscription(id: string) {
  const sub = await prisma.subscription.findFirst({
    where: { id, ...LIVE },
    include: {
      client: true,
      invoices: { orderBy: { periodStart: 'desc' }, take: 12 },
    },
  });
  if (!sub) throw NotFound('Subscription');
  return { ...sub, nextBilling: await previewNextBilling(sub) };
}

/** What the operator sees in the UI: "Next invoice 05 Aug 2026 for July 2026". */
export async function previewNextBilling(sub: {
  id: string;
  startDate: Date;
  endDate: Date | null;
  billingCycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  dueDay: number;
  status: string;
}) {
  if (sub.status !== 'ACTIVE') return null;
  const settings = await getSettings();
  const today = businessToday(settings.timezone);

  const latest = await prisma.invoice.findFirst({
    where: { subscriptionId: sub.id },
    orderBy: { periodStart: 'desc' },
    select: { periodStart: true },
  });

  const start = latest
    ? nextPeriodStart(latest.periodStart, sub.billingCycle)
    : firstPeriodStart(sub.startDate);

  if (sub.endDate && start > dateOnly(sub.endDate)) return null;

  const period = periodFrom(start, sub.billingCycle, sub.dueDay);
  const generateOn = new Date(period.dueDate.getTime() - settings.invoiceLeadDays * 86_400_000);
  return { ...period, generateOn, isOverdueToGenerate: generateOn <= today };
}

export async function createSubscription(input: CreateSubscriptionInput) {
  const client = await prisma.client.findFirst({ where: { id: input.clientId, deletedAt: null } });
  if (!client) throw NotFound('Client');
  if (client.status === 'INACTIVE') throw BadRequest('Cannot add a subscription to an inactive client');

  return prisma.subscription.create({
    data: {
      ...input,
      startDate: dateOnly(input.startDate),
      endDate: input.endDate ? dateOnly(input.endDate) : null,
      amount: new Prisma.Decimal(input.amount),
      taxRate: new Prisma.Decimal(input.taxRate),
    },
    include: { client: { select: { id: true, companyName: true, code: true } } },
  });
}

export async function updateSubscription(id: string, input: Record<string, unknown>) {
  const before = await prisma.subscription.findFirst({ where: { id, ...LIVE } });
  if (!before) throw NotFound('Subscription');

  const data: Prisma.SubscriptionUpdateInput = { ...(input as Prisma.SubscriptionUpdateInput) };
  if (input.amount !== undefined) data.amount = new Prisma.Decimal(input.amount as number);
  if (input.taxRate !== undefined) data.taxRate = new Prisma.Decimal(input.taxRate as number);
  if (input.startDate) data.startDate = dateOnly(input.startDate as Date);
  if (input.endDate !== undefined) data.endDate = input.endDate ? dateOnly(input.endDate as Date) : null;

  const after = await prisma.subscription.update({ where: { id }, data });
  return { before, after };
}

/**
 * Price changes must not rewrite history. Already-issued invoices keep the
 * price they were issued at; the new amount applies from the next period.
 */
export async function changePrice(id: string, amount: number, effectiveFrom?: Date) {
  const sub = await prisma.subscription.findFirst({ where: { id, ...LIVE } });
  if (!sub) throw NotFound('Subscription');

  const after = await prisma.subscription.update({
    where: { id },
    data: { amount: new Prisma.Decimal(amount) },
  });

  return {
    before: sub,
    after,
    note: `Applies from ${effectiveFrom ? dateOnly(effectiveFrom).toISOString().slice(0, 10) : 'the next billing period'}. Existing invoices are unchanged.`,
  };
}

export async function pauseSubscription(id: string, paused: boolean) {
  const sub = await prisma.subscription.findFirst({ where: { id, ...LIVE } });
  if (!sub) throw NotFound('Subscription');
  if (sub.status === 'CANCELLED') throw Conflict('Cancelled subscriptions cannot be resumed — create a new one');
  return prisma.subscription.update({ where: { id }, data: { status: paused ? 'PAUSED' : 'ACTIVE' } });
}

export async function cancelSubscription(id: string) {
  const sub = await prisma.subscription.findFirst({ where: { id, ...LIVE } });
  if (!sub) throw NotFound('Subscription');
  return prisma.subscription.update({
    where: { id },
    data: { status: 'CANCELLED', endDate: dateOnly(new Date()) },
  });
}

export async function deleteSubscription(id: string) {
  const sub = await prisma.subscription.findFirst({
    where: { id, ...LIVE },
    include: { _count: { select: { invoices: true } } },
  });
  if (!sub) throw NotFound('Subscription');

  // Invoices reference the subscription; keep the row (soft delete) so the
  // financial trail stays intact.
  await prisma.subscription.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'CANCELLED' },
  });
  return sub;
}
