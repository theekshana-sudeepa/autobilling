import type { EmailType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { businessToday, dateOnly, fmtIso, offsetFromDue } from '../lib/dates.js';
import { getSettings, reminderOffsets } from '../modules/settings/settings.service.js';
import { queueAndSend } from '../services/email/email.service.js';
import { withJobLock, type JobOutcome } from './lock.js';

export const JOB_NAME = 'send-reminders';

/**
 * Offset → template. Negative is before the due date, 0 is the due date,
 * positive is overdue. Offsets that are configured in Settings but have no
 * mapping here fall back to the nearest sensible template.
 */
const OFFSET_TEMPLATE: Record<number, EmailType> = {
  [-7]: 'REMINDER_BEFORE_7',
  [-3]: 'REMINDER_BEFORE_3',
  [0]: 'REMINDER_DUE_TODAY',
  [3]: 'REMINDER_OVERDUE_3',
  [7]: 'REMINDER_OVERDUE_7',
};

function templateFor(offset: number, finalNoticeDay: number): EmailType {
  if (offset >= finalNoticeDay) return 'FINAL_NOTICE';
  const exact = OFFSET_TEMPLATE[offset];
  if (exact) return exact;
  if (offset < 0) return offset <= -5 ? 'REMINDER_BEFORE_7' : 'REMINDER_BEFORE_3';
  if (offset === 0) return 'REMINDER_DUE_TODAY';
  return offset >= 5 ? 'REMINDER_OVERDUE_7' : 'REMINDER_OVERDUE_3';
}

/**
 * ---------------------------------------------------------------------------
 * REMINDER JOB
 * ---------------------------------------------------------------------------
 * Rather than scanning every invoice and asking "does today match a rule?",
 * we invert it: for each configured offset we compute the exact target due
 * date and fetch only the invoices due on that day. That is one indexed range
 * query per offset (five queries total) instead of a full table scan.
 *
 * Invoices in PAID / VOID / DRAFT are excluded at the SQL level — the moment
 * an invoice is marked paid it disappears from every future reminder query.
 * The dedupe key on email_logs then guarantees at-most-once delivery even if
 * this job is invoked repeatedly within the same day.
 */
export async function runRemindersForDate(opts: { date?: Date; trigger?: 'cron' | 'manual' } = {}): Promise<JobOutcome> {
  const settings = await getSettings();
  const today = dateOnly(opts.date ?? businessToday(settings.timezone));
  const runKey = `${fmtIso(today)}${opts.trigger === 'manual' ? `:manual:${Date.now()}` : ''}`;

  if (!settings.automationEnabled && opts.trigger !== 'manual') {
    logger.warn('automation disabled — reminder job skipped');
    return { jobName: JOB_NAME, runKey, status: 'SKIPPED', processed: 0, skipped: 0, failed: 0, durationMs: 0 };
  }

  return withJobLock(JOB_NAME, runKey, async () => {
    const offsets = [...reminderOffsets(settings)];
    if (!offsets.includes(settings.finalNoticeDay)) offsets.push(settings.finalNoticeDay);

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const byType: Record<string, number> = {};

    for (const offset of offsets) {
      // dueDate = today - offset  →  a -7 offset targets invoices due in 7 days.
      const targetDue = new Date(today.getTime() - offset * 86_400_000);

      const invoices = await prisma.invoice.findMany({
        where: {
          dueDate: targetDue,
          status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
          client: { deletedAt: null, status: 'ACTIVE' },
        },
        select: { id: true, invoiceNumber: true, dueDate: true },
      });

      if (invoices.length === 0) continue;

      const type = templateFor(offset, settings.finalNoticeDay);
      logger.info({ offset, type, count: invoices.length, targetDue: fmtIso(targetDue) }, 'reminder batch');

      for (const invoice of invoices) {
        try {
          const result = await queueAndSend({
            type,
            invoiceId: invoice.id,
            attachPdf: offset >= settings.finalNoticeDay, // re-attach the PDF on the final notice
            // The date the run is FOR — so a catch-up run still says the
            // number the client would have seen on the day.
            asOf: today,
          });

          if (result.status === 'sent') {
            processed += 1;
            byType[type] = (byType[type] ?? 0) + 1;
          } else if (result.status === 'skipped') {
            skipped += 1;
          } else {
            failed += 1;
          }
        } catch (err) {
          failed += 1;
          logger.error({ err, invoiceId: invoice.id, type }, 'reminder send threw');
        }
      }
    }

    return { processed, skipped, failed, meta: { byType, offsets, today: fmtIso(today) } };
  });
}

/** Which reminders an individual invoice will receive — powers the UI timeline. */
export async function reminderTimeline(invoiceId: string) {
  const settings = await getSettings();
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, dueDate: true, status: true, emailLogs: { select: { type: true, status: true, sentAt: true } } },
  });
  if (!invoice) return [];

  const today = businessToday(settings.timezone);
  const offsets = [...reminderOffsets(settings), settings.finalNoticeDay];
  const sent = new Map(invoice.emailLogs.map((l) => [l.type, l]));
  const stopped = ['PAID', 'VOID'].includes(invoice.status);

  return offsets
    .sort((a, b) => a - b)
    .map((offset) => {
      const type = templateFor(offset, settings.finalNoticeDay);
      const scheduledFor = new Date(invoice.dueDate.getTime() + offset * 86_400_000);
      const log = sent.get(type);
      return {
        offset,
        type,
        scheduledFor: fmtIso(scheduledFor),
        state: log?.status === 'SENT' ? 'sent' : stopped ? 'cancelled' : offsetFromDue(invoice.dueDate, today) > offset ? 'missed' : 'scheduled',
        sentAt: log?.sentAt ?? null,
      };
    });
}
