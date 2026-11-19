import { addDays } from 'date-fns';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { businessToday, dateOnly, fmtIso, firstPeriodStart, nextPeriodStart, periodFrom, periodLabel } from '../lib/dates.js';
import { getSettings } from '../modules/settings/settings.service.js';
import { generateInvoiceForPeriod } from '../modules/invoices/invoice.service.js';
import { buildInvoicePdf } from '../services/pdf/invoicePdf.js';
import { queueAndSend } from '../services/email/email.service.js';
import { audit } from '../middleware/audit.js';
import { withJobLock, type JobOutcome } from './lock.js';

export const JOB_NAME = 'generate-invoices';

export interface GenerateOptions {
  date?: Date;
  dryRun?: boolean;
  trigger?: 'cron' | 'manual' | 'preview';
  subscriptionId?: string;
}

interface PlannedInvoice {
  subscriptionId: string;
  clientName: string;
  serviceName: string;
  period: string;
  periodStart: string;
  dueDate: string;
  amount: number;
  currency: string;
}

/**
 * ---------------------------------------------------------------------------
 * INVOICE GENERATION JOB
 * ---------------------------------------------------------------------------
 * Runs daily. For every ACTIVE subscription belonging to an ACTIVE client:
 *
 *   1. Work out the next un-invoiced period from `lastInvoicedAt` (or the
 *      subscription start for brand-new ones).
 *   2. Emit the invoice only once `dueDate - invoiceLeadDays <= today`, so a
 *      client due on the 5th gets their invoice on the 29th of the prior month
 *      with a 7-day lead.
 *   3. Catch up on missed periods (server down for a week) but never more than
 *      `maxBackfill` so a typo'd 2019 start date cannot emit 80 invoices.
 *   4. Build the PDF and, if the subscription has autoSend, email it.
 *
 * Idempotency: unique(subscriptionId, periodStart) in MySQL. Running this job
 * ten times in one day produces exactly one invoice per period.
 */
export async function generateInvoicesForDate(opts: GenerateOptions = {}): Promise<JobOutcome & { planned?: PlannedInvoice[] }> {
  const settings = await getSettings();
  const today = dateOnly(opts.date ?? businessToday(settings.timezone));
  const runKey = `${fmtIso(today)}${opts.trigger === 'manual' ? `:manual:${Date.now()}` : ''}`;
  const dryRun = opts.dryRun ?? false;

  if (!settings.automationEnabled && opts.trigger === 'cron') {
    logger.warn('automation is disabled in settings — generation job skipped');
    return { jobName: JOB_NAME, runKey, status: 'SKIPPED', processed: 0, skipped: 0, failed: 0, durationMs: 0 };
  }

  // Dry runs never take the lock and never write.
  if (dryRun) {
    const planned = await planInvoices(today, settings.invoiceLeadDays, opts.subscriptionId);
    return {
      jobName: JOB_NAME,
      runKey: `${runKey}:dry`,
      status: 'SUCCESS',
      processed: 0,
      skipped: planned.length,
      failed: 0,
      durationMs: 0,
      meta: { dryRun: true, wouldCreate: planned.length },
      planned,
    };
  }

  return withJobLock(JOB_NAME, runKey, async () => {
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const created: string[] = [];

    const subscriptions = await prisma.subscription.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        client: { deletedAt: null, status: 'ACTIVE' },
        startDate: { lte: addDays(today, settings.invoiceLeadDays) },
        OR: [{ endDate: null }, { endDate: { gte: today } }],
        ...(opts.subscriptionId ? { id: opts.subscriptionId } : {}),
      },
      include: { client: true },
      orderBy: { createdAt: 'asc' },
    });

    logger.info({ count: subscriptions.length, today: fmtIso(today) }, 'invoice generation started');

    for (const sub of subscriptions) {
      try {
        const periods = pendingPeriods(sub, today, settings.invoiceLeadDays);
        if (periods.length === 0) {
          skipped += 1;
          continue;
        }

        for (const period of periods) {
          const result = await generateInvoiceForPeriod(sub, period);

          if (!result.created || !result.invoice) {
            skipped += 1;
            continue;
          }

          processed += 1;
          created.push(result.invoice.invoiceNumber);

          // PDF + email are best-effort. A failure here leaves a valid invoice
          // in the DB that the retry job or an operator can re-send; it must
          // never abort the whole batch.
          try {
            // If this is going out by email in a moment, stamp it UNPAID now.
            // The status flips to SENT only after the mailer succeeds, which
            // is after the attachment has already been built.
            await buildInvoicePdf(result.invoice.id, sub.autoSend ? { statusOverride: 'SENT' } : {});
          } catch (err) {
            logger.error({ err, invoiceId: result.invoice.id }, 'pdf build failed during generation');
          }

          if (sub.autoSend) {
            const sendResult = await queueAndSend({
              type: 'INVOICE_CREATED',
              invoiceId: result.invoice.id,
              attachPdf: true,
            });
            if (sendResult.status === 'failed') failed += 1;
          }

          await audit({
            action: 'invoice.generated',
            entity: 'Invoice',
            entityId: result.invoice.id,
            actorType: 'SYSTEM',
            after: {
              invoiceNumber: result.invoice.invoiceNumber,
              clientId: sub.clientId,
              period: periodLabel(period.periodStart, period.periodEnd),
              total: result.invoice.total.toString(),
            },
          });
        }
      } catch (err) {
        failed += 1;
        logger.error({ err, subscriptionId: sub.id }, 'invoice generation failed for subscription');
      }
    }

    return { processed, skipped, failed, meta: { created, today: fmtIso(today) } };
  });
}

/**
 * Periods that are due to be invoiced but have not been yet.
 * Uses `lastInvoicedAt` as the cursor — a single indexed column read rather
 * than a per-subscription invoice query.
 */
function pendingPeriods(
  sub: { startDate: Date; endDate: Date | null; billingCycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'; dueDay: number; lastInvoicedAt: Date | null },
  today: Date,
  leadDays: number,
  maxBackfill = 3,
) {
  const horizon = dateOnly(addDays(today, leadDays));
  const out: ReturnType<typeof periodFrom>[] = [];

  let cursor = sub.lastInvoicedAt
    ? nextPeriodStart(sub.lastInvoicedAt, sub.billingCycle)
    : firstPeriodStart(sub.startDate);

  for (let i = 0; i < maxBackfill; i += 1) {
    const period = periodFrom(cursor, sub.billingCycle, sub.dueDay);
    if (period.dueDate > horizon) break;
    if (sub.endDate && period.periodStart > dateOnly(sub.endDate)) break;
    out.push(period);
    cursor = nextPeriodStart(cursor, sub.billingCycle);
  }
  return out;
}

/** Read-only projection used by the dashboard "upcoming billing" panel. */
async function planInvoices(today: Date, leadDays: number, subscriptionId?: string): Promise<PlannedInvoice[]> {
  const subscriptions = await prisma.subscription.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      client: { deletedAt: null, status: 'ACTIVE' },
      ...(subscriptionId ? { id: subscriptionId } : {}),
    },
    include: { client: { select: { companyName: true } } },
  });

  const planned: PlannedInvoice[] = [];
  for (const sub of subscriptions) {
    for (const period of pendingPeriods(sub, today, leadDays)) {
      const exists = await prisma.invoice.findUnique({
        where: { uniq_subscription_period: { subscriptionId: sub.id, periodStart: period.periodStart } },
        select: { id: true },
      });
      if (exists) continue;
      planned.push({
        subscriptionId: sub.id,
        clientName: sub.client.companyName,
        serviceName: sub.serviceName,
        period: periodLabel(period.periodStart, period.periodEnd),
        periodStart: fmtIso(period.periodStart),
        dueDate: fmtIso(period.dueDate),
        amount: Number(sub.amount.toString()),
        currency: sub.currency,
      });
    }
  }
  return planned;
}
