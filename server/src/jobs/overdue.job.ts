import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { businessToday, dateOnly, fmtIso } from '../lib/dates.js';
import { getSettings } from '../modules/settings/settings.service.js';
import { audit } from '../middleware/audit.js';
import { withJobLock, type JobOutcome } from './lock.js';

export const JOB_NAME = 'mark-overdue';

/**
 * ---------------------------------------------------------------------------
 * OVERDUE SWEEP
 * ---------------------------------------------------------------------------
 * Runs before the reminder job each morning so that reminders see accurate
 * statuses. It is a set-based UPDATE, not a row-by-row loop: one statement
 * flips every newly-overdue invoice, which stays fast at 100k invoices.
 *
 * DRAFT invoices are deliberately excluded — an invoice nobody has sent cannot
 * be "overdue", and marking it so would pollute the collections numbers.
 */
export async function markOverdueInvoices(opts: { date?: Date; trigger?: 'cron' | 'manual' } = {}): Promise<JobOutcome> {
  const settings = await getSettings();
  const today = dateOnly(opts.date ?? businessToday(settings.timezone));
  const runKey = `${fmtIso(today)}${opts.trigger === 'manual' ? `:manual:${Date.now()}` : ''}`;

  return withJobLock(JOB_NAME, runKey, async () => {
    const candidates = await prisma.invoice.findMany({
      where: {
        status: { in: ['SENT', 'PARTIALLY_PAID'] },
        dueDate: { lt: today },
      },
      select: { id: true, invoiceNumber: true, clientId: true, dueDate: true, total: true, amountPaid: true },
    });

    if (candidates.length === 0) {
      return { processed: 0, skipped: 0, failed: 0, meta: { today: fmtIso(today) } };
    }

    const { count } = await prisma.invoice.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: 'OVERDUE' },
    });

    logger.warn({ count, today: fmtIso(today) }, 'invoices marked overdue');

    await audit({
      action: 'invoice.marked_overdue',
      entity: 'Invoice',
      actorType: 'SYSTEM',
      after: {
        count,
        invoices: candidates.slice(0, 50).map((c) => c.invoiceNumber),
        totalOutstanding: candidates.reduce((sum, c) => sum + Number(c.total) - Number(c.amountPaid), 0),
      },
    });

    return { processed: count, skipped: 0, failed: 0, meta: { today: fmtIso(today) } };
  });
}

/**
 * Self-healing consistency check. Recomputes `amountPaid` from the payments
 * ledger and repairs any invoice whose cached total drifted — for instance
 * after a manual SQL edit or a partially-applied migration.
 */
export async function reconcileInvoiceTotals(): Promise<{ checked: number; repaired: number }> {
  const drifted = await prisma.$queryRaw<Array<{ id: string; cached: string; actual: string }>>`
    SELECT i.id                                AS id,
           i.amountPaid                        AS cached,
           COALESCE(SUM(p.amount), 0)          AS actual
    FROM invoices i
    LEFT JOIN payments p ON p.invoiceId = i.id AND p.voidedAt IS NULL
    WHERE i.status <> 'VOID'
    GROUP BY i.id, i.amountPaid
    HAVING ABS(i.amountPaid - COALESCE(SUM(p.amount), 0)) > 0.005
  `;

  for (const row of drifted) {
    logger.error({ invoiceId: row.id, cached: row.cached, actual: row.actual }, 'invoice amountPaid drift repaired');
    const { recomputeInvoiceStatus } = await import('../modules/invoices/invoice.service.js');
    await recomputeInvoiceStatus(row.id);
  }

  return { checked: drifted.length, repaired: drifted.length };
}
