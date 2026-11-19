import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { generateInvoicesForDate } from './generateInvoices.job.js';
import { runRemindersForDate } from './reminders.job.js';
import { markOverdueInvoices } from './overdue.job.js';
import { runEmailRetryJob, runMaintenanceJob } from './retryEmails.job.js';

const tasks: ScheduledTask[] = [];

/**
 * ---------------------------------------------------------------------------
 * DAILY BILLING PIPELINE — order is not negotiable
 * ---------------------------------------------------------------------------
 *   08:00      1. mark-overdue      → statuses reflect reality
 *              2. generate-invoices → new invoices exist and are emailed
 *              3. send-reminders    → reminders see fresh statuses & new invoices
 *   every 15m  retry-emails         → drains transient delivery failures
 *   03:30      maintenance          → prune tokens, job runs, old logs; repair drift
 *
 * Running reminders BEFORE the overdue sweep would send "due today" mails for
 * invoices that are actually a day late, so the sequence is enforced here
 * rather than by three independent cron entries that could interleave.
 */
async function runDailyPipeline(): Promise<void> {
  const startedAt = Date.now();
  logger.info('daily billing pipeline starting');

  const overdue = await markOverdueInvoices({ trigger: 'cron' });
  const generated = await generateInvoicesForDate({ trigger: 'cron' });
  const reminders = await runRemindersForDate({ trigger: 'cron' });

  logger.info(
    {
      durationMs: Date.now() - startedAt,
      overdue: { status: overdue.status, processed: overdue.processed },
      generated: { status: generated.status, processed: generated.processed, failed: generated.failed },
      reminders: { status: reminders.status, processed: reminders.processed, failed: reminders.failed },
    },
    'daily billing pipeline finished',
  );
}

export function startScheduler(): void {
  if (!env.CRON_ENABLED) {
    logger.warn('CRON_ENABLED=false — no scheduled jobs registered');
    return;
  }

  const tz = env.TIMEZONE;

  tasks.push(
    cron.schedule(env.CRON_DAILY_AT, () => {
      void runDailyPipeline().catch((err) => logger.error({ err }, 'daily pipeline crashed'));
    }, { timezone: tz }),
  );

  tasks.push(
    cron.schedule(env.CRON_RETRY_AT, () => {
      void runEmailRetryJob().catch((err) => logger.error({ err }, 'retry job crashed'));
    }, { timezone: tz }),
  );

  tasks.push(
    cron.schedule('30 3 * * *', () => {
      void runMaintenanceJob().catch((err) => logger.error({ err }, 'maintenance job crashed'));
    }, { timezone: tz }),
  );

  logger.info({ daily: env.CRON_DAILY_AT, retry: env.CRON_RETRY_AT, timezone: tz }, 'scheduler started');
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  logger.info('scheduler stopped');
}

export { runDailyPipeline };
