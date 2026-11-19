import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { nextClientCode } from '../../lib/numbering.js';
import { Conflict, NotFound } from '../../lib/errors.js';
import { toNumber } from '../../lib/money.js';
import type { CreateClientInput, ListClientsQuery } from './client.schema.js';

const LIVE = { deletedAt: null } satisfies Prisma.ClientWhereInput;

export async function listClients(q: ListClientsQuery) {
  const where: Prisma.ClientWhereInput = {
    ...LIVE,
    ...(q.status ? { status: q.status } : {}),
    ...(q.search
      ? {
          OR: [
            { companyName: { contains: q.search } },
            { contactPerson: { contains: q.search } },
            { email: { contains: q.search } },
            { code: { contains: q.search } },
            { phone: { contains: q.search } },
          ],
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      orderBy: { [q.sortBy]: q.sortDir },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        _count: { select: { subscriptions: { where: { deletedAt: null, status: 'ACTIVE' } }, invoices: true } },
        subscriptions: {
          where: { deletedAt: null, status: 'ACTIVE' },
          select: { amount: true, currency: true, billingCycle: true },
        },
      },
    }),
  ]);

  const items = rows.map(({ subscriptions, _count, ...client }) => ({
    ...client,
    activeSubscriptions: _count.subscriptions,
    invoiceCount: _count.invoices,
    // Normalised monthly value of this client's book of business.
    mrr: subscriptions.reduce((sum, s) => {
      const divisor = s.billingCycle === 'YEARLY' ? 12 : s.billingCycle === 'QUARTERLY' ? 3 : 1;
      return sum + toNumber(s.amount) / divisor;
    }, 0),
    currency: subscriptions[0]?.currency ?? null,
  }));

  return { items, total };
}

export async function getClient(id: string) {
  const client = await prisma.client.findFirst({
    where: { id, ...LIVE },
    include: {
      subscriptions: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
      invoices: {
        orderBy: { issueDate: 'desc' },
        take: 24,
        include: { payments: { where: { voidedAt: null } } },
      },
    },
  });
  if (!client) throw NotFound('Client');

  const outstanding = client.invoices
    .filter((i) => ['SENT', 'OVERDUE', 'PARTIALLY_PAID'].includes(i.status))
    .reduce((sum, i) => sum + (toNumber(i.total) - toNumber(i.amountPaid)), 0);

  const lifetimeValue = client.invoices.reduce((sum, i) => sum + toNumber(i.amountPaid), 0);

  return { ...client, stats: { outstanding, lifetimeValue } };
}

export async function createClient(input: CreateClientInput) {
  const duplicate = await prisma.client.findFirst({
    where: { email: input.email, ...LIVE },
    select: { id: true, companyName: true },
  });
  if (duplicate) throw Conflict(`"${duplicate.companyName}" already uses ${input.email}`, { clientId: duplicate.id });

  return prisma.$transaction(async (tx) => {
    const code = await nextClientCode(tx);
    return tx.client.create({
      data: {
        code,
        ...input,
        billingEmail: input.billingEmail || null,
      },
    });
  });
}

export async function updateClient(id: string, input: Partial<CreateClientInput>) {
  const existing = await prisma.client.findFirst({ where: { id, ...LIVE } });
  if (!existing) throw NotFound('Client');
  const updated = await prisma.client.update({
    where: { id },
    data: { ...input, billingEmail: input.billingEmail === '' ? null : input.billingEmail },
  });
  return { before: existing, after: updated };
}

/**
 * Soft delete. Refused while money is still owed — deleting a client with an
 * open invoice silently destroys receivables, so we make the operator either
 * settle or void the invoices first.
 */
export async function deleteClient(id: string) {
  const client = await prisma.client.findFirst({
    where: { id, ...LIVE },
    include: { invoices: { where: { status: { in: ['SENT', 'OVERDUE', 'PARTIALLY_PAID'] } }, select: { id: true } } },
  });
  if (!client) throw NotFound('Client');
  if (client.invoices.length > 0) {
    throw Conflict(`Client has ${client.invoices.length} unpaid invoice(s). Settle or void them first.`, {
      invoiceIds: client.invoices.map((i) => i.id),
    });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.subscription.updateMany({
      where: { clientId: id, deletedAt: null },
      data: { deletedAt: now, status: 'CANCELLED' },
    }),
    prisma.client.update({ where: { id }, data: { deletedAt: now, status: 'INACTIVE' } }),
  ]);

  return client;
}

export const billingEmailFor = (c: { email: string; billingEmail: string | null }): string => c.billingEmail || c.email;
