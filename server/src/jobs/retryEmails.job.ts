import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { retryPendingEmails } from '../services/email/email.service.js';
import { pruneExpiredTokens } from '../modules/auth/auth.service.js';
import { pruneJobRuns } from './lock.js';
import { reconcileInvoiceTotals } from './overdue.job.js';

export const RETRY_JOB_NAME = 'retry-emails';

/**
 * Runs every 15 minutes. No job lock: the query itself is the lock — rows are
 * claimed by `attempts` being incremented, and a duplicate send is prevented
 * by the dedupe key. Worst case two workers race on one row and one of them
 * writes a slightly stale attempt count, which is harmless.
 */
export async function runEmailRetryJob(): Promise<{ retried: number; sent: number; failed: number }> {
  const result = await retryPendingEmails(50);
  if (result.retried > 0) logger.info(result, 'email retry sweep finished');
  return result;
}

/** Nightly housekeeping — keeps the database small and self-consistent. */
export async function runMaintenanceJob(): Promise<Record<string, number>> {
  const tokens = await pruneExpiredTokens();
  const jobs = await pruneJobRuns(90);
  const drift = await reconcileInvoiceTotals();

  const { count: oldEmails } = await prisma.emailLog.deleteMany({
    where: {
      status: { in: ['SENT', 'CANCELLED'] },
      createdAt: { lt: new Date(Date.now() - 365 * 86_400_000) },
    },
  });

  const summary = { tokensPruned: tokens, jobRunsPruned: jobs, emailLogsPruned: oldEmails, invoicesRepaired: drift.repaired };
  logger.info(summary, 'maintenance job finished');
  return summary;
}
