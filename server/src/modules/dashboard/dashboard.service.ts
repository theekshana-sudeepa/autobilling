import { subMonths, startOfMonth } from 'date-fns';
import { prisma } from '../../lib/prisma.js';
import { toNumber } from '../../lib/money.js';
import { businessToday, dateOnly, fmtIso } from '../../lib/dates.js';
import { getSettings } from '../settings/settings.service.js';

export interface DashboardOverview {
  clients: { total: number; active: number; inactive: number; newThisMonth: number };
  mrr: { current: number; previous: number; changePct: number; currency: string };
  invoices: { paid: number; unpaid: number; overdue: number; draft: number; thisMonth: number };
  money: { collectedThisMonth: number; outstanding: number; overdueAmount: number; collectionRatePct: number };
  churn: { cancelledThisMonth: number; churnRatePct: number; note: string };
}

/** Normalise any billing cycle to a monthly figure. */
const MONTHLY_DIVISOR: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

export async function getOverview(): Promise<DashboardOverview> {
  const settings = await getSettings();
  const today = businessToday(settings.timezone);
  const monthStart = dateOnly(startOfMonth(today));
  const prevMonthStart = dateOnly(startOfMonth(subMonths(today, 1)));

  const [
    clientTotals,
    newClients,
    activeSubs,
    subsAtPrevMonth,
    invoiceCounts,
    invoicesThisMonth,
    collectedThisMonth,
    outstandingAgg,
    overdueAgg,
    cancelledThisMonth,
    activeClientCount,
  ] = await prisma.$transaction([
    prisma.client.groupBy({ by: ['status'], where: { deletedAt: null }, orderBy: { status: 'asc' }, _count: true }),
    prisma.client.count({ where: { deletedAt: null, createdAt: { gte: monthStart } } }),
    prisma.subscription.findMany({
      where: { deletedAt: null, status: 'ACTIVE', client: { deletedAt: null, status: 'ACTIVE' } },
      select: { amount: true, billingCycle: true, currency: true },
    }),
    prisma.subscription.findMany({
      where: {
        deletedAt: null,
        createdAt: { lt: monthStart },
        OR: [{ status: 'ACTIVE' }, { updatedAt: { gte: monthStart } }],
      },
      select: { amount: true, billingCycle: true, status: true },
    }),
    prisma.invoice.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: true }),
    prisma.invoice.count({ where: { issueDate: { gte: monthStart } } }),
    prisma.payment.aggregate({ where: { voidedAt: null, paidAt: { gte: monthStart } }, _sum: { amount: true } }),
    prisma.invoice.aggregate({
      where: { status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
      _sum: { total: true, amountPaid: true },
    }),
    prisma.invoice.aggregate({ where: { status: 'OVERDUE' }, _sum: { total: true, amountPaid: true } }),
    prisma.subscription.count({ where: { status: 'CANCELLED', updatedAt: { gte: monthStart } } }),
    prisma.client.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
  ]);

  const mrrOf = (subs: { amount: unknown; billingCycle: string }[]): number =>
    subs.reduce((sum, s) => sum + toNumber(s.amount as never) / (MONTHLY_DIVISOR[s.billingCycle] ?? 1), 0);

  const currentMrr = mrrOf(activeSubs);
  const previousMrr = mrrOf(subsAtPrevMonth.filter((s) => s.status === 'ACTIVE'));

  const countBy = (rows: { status: string; _count: number }[], status: string): number =>
    rows.find((r) => r.status === status)?._count ?? 0;

  const invoiceStatusRows = invoiceCounts as unknown as { status: string; _count: number }[];
  const clientStatusRows = clientTotals as unknown as { status: string; _count: number }[];

  const outstanding = toNumber(outstandingAgg._sum.total) - toNumber(outstandingAgg._sum.amountPaid);
  const overdueAmount = toNumber(overdueAgg._sum.total) - toNumber(overdueAgg._sum.amountPaid);
  const collected = toNumber(collectedThisMonth._sum.amount);

  const billedThisMonth = await prisma.invoice.aggregate({
    where: { issueDate: { gte: monthStart }, status: { not: 'VOID' } },
    _sum: { total: true },
  });
  const billed = toNumber(billedThisMonth._sum.total);

  return {
    clients: {
      total: clientStatusRows.reduce((s, r) => s + r._count, 0),
      active: countBy(clientStatusRows, 'ACTIVE'),
      inactive: countBy(clientStatusRows, 'INACTIVE'),
      newThisMonth: newClients,
    },
    mrr: {
      current: round2(currentMrr),
      previous: round2(previousMrr),
      changePct: previousMrr > 0 ? round2(((currentMrr - previousMrr) / previousMrr) * 100) : 0,
      currency: activeSubs[0]?.currency ?? settings.defaultCurrency,
    },
    invoices: {
      paid: countBy(invoiceStatusRows, 'PAID'),
      unpaid: countBy(invoiceStatusRows, 'SENT') + countBy(invoiceStatusRows, 'PARTIALLY_PAID'),
      overdue: countBy(invoiceStatusRows, 'OVERDUE'),
      draft: countBy(invoiceStatusRows, 'DRAFT'),
      thisMonth: invoicesThisMonth,
    },
    money: {
      collectedThisMonth: round2(collected),
      outstanding: round2(outstanding),
      overdueAmount: round2(overdueAmount),
      collectionRatePct: billed > 0 ? round2((collected / billed) * 100) : 0,
    },
    churn: {
      cancelledThisMonth,
      churnRatePct: activeClientCount > 0 ? round2((cancelledThisMonth / activeClientCount) * 100) : 0,
      note: 'Logo churn on subscriptions. Revenue churn requires MRR movement tracking (see roadmap).',
    },
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface RevenuePoint {
  month: string;
  billed: number;
  collected: number;
  outstanding: number;
}

/**
 * Revenue by month. Two grouped queries merged in memory rather than a
 * correlated subquery — MySQL's optimiser handles the flat GROUP BYs far
 * better, and 12–24 rows are trivial to merge.
 */
export async function getRevenueSeries(months = 12): Promise<RevenuePoint[]> {
  const since = dateOnly(startOfMonth(subMonths(new Date(), months - 1)));

  const billedRows = await prisma.$queryRaw<Array<{ month: string; billed: string }>>`
    SELECT DATE_FORMAT(issueDate, '%Y-%m') AS month, COALESCE(SUM(total), 0) AS billed
    FROM invoices
    WHERE issueDate >= ${since} AND status <> 'VOID'
    GROUP BY month
    ORDER BY month
  `;

  const collectedRows = await prisma.$queryRaw<Array<{ month: string; collected: string }>>`
    SELECT DATE_FORMAT(p.paidAt, '%Y-%m') AS month, COALESCE(SUM(p.amount), 0) AS collected
    FROM payments p
    WHERE p.paidAt >= ${since} AND p.voidedAt IS NULL
    GROUP BY month
    ORDER BY month
  `;

  const billedMap = new Map(billedRows.map((r) => [r.month, Number(r.billed)]));
  const collectedMap = new Map(collectedRows.map((r) => [r.month, Number(r.collected)]));

  const out: RevenuePoint[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = startOfMonth(subMonths(new Date(), i));
    const key = fmtIso(d).slice(0, 7);
    const billed = billedMap.get(key) ?? 0;
    const collected = collectedMap.get(key) ?? 0;
    out.push({ month: key, billed: round2(billed), collected: round2(collected), outstanding: round2(billed - collected) });
  }
  return out;
}

export async function getTopClients(limit = 8) {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; companyName: string; code: string; billed: string; collected: string; outstanding: string; invoiceCount: bigint }>
  >`
    SELECT c.id, c.companyName, c.code,
           COALESCE(SUM(i.total), 0)                       AS billed,
           COALESCE(SUM(i.amountPaid), 0)                  AS collected,
           COALESCE(SUM(i.total - i.amountPaid), 0)        AS outstanding,
           COUNT(i.id)                                     AS invoiceCount
    FROM clients c
    LEFT JOIN invoices i ON i.clientId = c.id AND i.status <> 'VOID'
    WHERE c.deletedAt IS NULL
    GROUP BY c.id, c.companyName, c.code
    HAVING billed > 0
    ORDER BY billed DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    companyName: r.companyName,
    code: r.code,
    billed: Number(r.billed),
    collected: Number(r.collected),
    outstanding: Number(r.outstanding),
    invoiceCount: Number(r.invoiceCount),
  }));
}

/** Ageing buckets — the collections view every finance team asks for. */
export async function getAgeingBuckets() {
  const rows = await prisma.$queryRaw<Array<{ bucket: string; amount: string; count: bigint }>>`
    SELECT CASE
             WHEN DATEDIFF(CURDATE(), dueDate) <= 0  THEN 'current'
             WHEN DATEDIFF(CURDATE(), dueDate) <= 30 THEN '1-30'
             WHEN DATEDIFF(CURDATE(), dueDate) <= 60 THEN '31-60'
             WHEN DATEDIFF(CURDATE(), dueDate) <= 90 THEN '61-90'
             ELSE '90+'
           END                                AS bucket,
           SUM(total - amountPaid)            AS amount,
           COUNT(*)                           AS count
    FROM invoices
    WHERE status IN ('SENT','PARTIALLY_PAID','OVERDUE')
    GROUP BY bucket
  `;

  const order = ['current', '1-30', '31-60', '61-90', '90+'];
  return order.map((bucket) => {
    const row = rows.find((r) => r.bucket === bucket);
    return { bucket, amount: row ? Number(row.amount) : 0, count: row ? Number(row.count) : 0 };
  });
}

export async function getRecentActivity(limit = 12) {
  const logs = await prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          'invoice.generated',
          'invoice.sent',
          'invoice.voided',
          'payment.recorded',
          'client.created',
          'subscription.created',
          'subscription.cancelled',
          'invoice.marked_overdue',
        ],
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { name: true } } },
  });

  return logs.map((l) => ({
    id: l.id,
    action: l.action,
    entity: l.entity,
    entityId: l.entityId,
    actor: l.actor?.name ?? 'Automation',
    actorType: l.actorType,
    at: l.createdAt,
    detail: l.after,
  }));
}

export async function getUpcomingBilling(limit = 10) {
  const settings = await getSettings();
  const today = businessToday(settings.timezone);
  const in30 = new Date(today.getTime() + 30 * 86_400_000);

  return prisma.invoice.findMany({
    where: { status: { in: ['SENT', 'PARTIALLY_PAID'] }, dueDate: { gte: today, lte: in30 } },
    orderBy: { dueDate: 'asc' },
    take: limit,
    select: {
      id: true,
      invoiceNumber: true,
      dueDate: true,
      total: true,
      amountPaid: true,
      currency: true,
      client: { select: { id: true, companyName: true } },
    },
  });
}
