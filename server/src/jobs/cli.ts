/**
 * Manual job runner — the escape hatch when something needs re-running.
 *
 *   npm run jobs:run -- generate            # today
 *   npm run jobs:run -- generate 2026-08-01 # a specific date
 *   npm run jobs:run -- generate --dry
 *   npm run jobs:run -- reminders
 *   npm run jobs:run -- overdue
 *   npm run jobs:run -- retry
 *   npm run jobs:run -- maintenance
 *   npm run jobs:run -- pipeline
 *
 * Also the entry point to use if you prefer OS-level cron over node-cron:
 *   0 8 * * *  cd /srv/autobilling/server && node dist/jobs/cli.js pipeline
 */
import { logger } from '../lib/logger.js';
import { disconnectPrisma } from '../lib/prisma.js';
import { generateInvoicesForDate } from './generateInvoices.job.js';
import { runRemindersForDate } from './reminders.job.js';
import { markOverdueInvoices } from './overdue.job.js';
import { runEmailRetryJob, runMaintenanceJob } from './retryEmails.job.js';
import { runDailyPipeline } from './scheduler.js';

const [, , command, ...rest] = process.argv;
const dateArg = rest.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ? new Date(`${dateArg}T00:00:00.000Z`) : undefined;
const dryRun = rest.includes('--dry');

async function main(): Promise<void> {
  switch (command) {
    case 'generate':
      console.log(JSON.stringify(await generateInvoicesForDate({ date, dryRun, trigger: 'manual' }), null, 2));
      break;
    case 'reminders':
      console.log(JSON.stringify(await runRemindersForDate({ date, trigger: 'manual' }), null, 2));
      break;
    case 'overdue':
      console.log(JSON.stringify(await markOverdueInvoices({ date, trigger: 'manual' }), null, 2));
      break;
    case 'retry':
      console.log(JSON.stringify(await runEmailRetryJob(), null, 2));
      break;
    case 'maintenance':
      console.log(JSON.stringify(await runMaintenanceJob(), null, 2));
      break;
    case 'pipeline':
      await runDailyPipeline();
      break;
    default:
      console.error('Usage: jobs:run -- <generate|reminders|overdue|retry|maintenance|pipeline> [YYYY-MM-DD] [--dry]');
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'job cli failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
