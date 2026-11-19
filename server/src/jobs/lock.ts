import { differenceInMinutes } from 'date-fns';
import type { JobRun } from '@prisma/client';
import { prisma, isUniqueViolation } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export interface JobSummary {
  processed: number;
  skipped: number;
  failed: number;
  meta?: Record<string, unknown>;
}

export interface JobOutcome extends JobSummary {
  jobName: string;
  runKey: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  error?: string;
}

const STALE_AFTER_MINUTES = 30;

/**
 * ---------------------------------------------------------------------------
 * DISTRIBUTED JOB LOCK
 * ---------------------------------------------------------------------------
 * `job_runs` has UNIQUE(jobName, runKey). The winner of the INSERT owns the
 * run; everybody else is told to go away. That gives us, for free:
 *
 *   • Two PM2 instances / two containers → only one runs the billing job.
 *   • Server restarted at 08:00:30 mid-run → the 08:01 attempt sees a RUNNING
 *     row younger than 30 min and backs off; after 30 min it is treated as
 *     crashed and taken over.
 *   • A run that FAILED can be retried by the next tick — failures are not
 *     sticky, but successes are.
 *
 * Every job body must ALSO be individually idempotent (unique invoice period,
 * unique email dedupe key). The lock reduces contention; the constraints
 * guarantee correctness.
 */
export async function withJobLock(
  jobName: string,
  runKey: string,
  fn: (run: JobRun) => Promise<JobSummary>,
): Promise<JobOutcome> {
  const startedAt = Date.now();
  let run: JobRun;

  try {
    run = await prisma.jobRun.create({ data: { jobName, runKey, status: 'RUNNING' } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const existing = await prisma.jobRun.findUnique({ where: { jobName_runKey: { jobName, runKey } } });
    if (!existing) throw err;

    if (existing.status === 'SUCCESS') {
      logger.debug({ jobName, runKey }, 'job already completed for this key — skipping');
      return { jobName, runKey, status: 'SKIPPED', processed: 0, skipped: 0, failed: 0, durationMs: 0 };
    }

    const ageMinutes = differenceInMinutes(new Date(), existing.startedAt);
    if (existing.status === 'RUNNING' && ageMinutes < STALE_AFTER_MINUTES) {
      logger.warn({ jobName, runKey, ageMinutes }, 'job already running elsewhere — skipping');
      return { jobName, runKey, status: 'SKIPPED', processed: 0, skipped: 0, failed: 0, durationMs: 0 };
    }

    logger.warn({ jobName, runKey, previous: existing.status, ageMinutes }, 'taking over stale/failed job run');
    run = await prisma.jobRun.update({
      where: { id: existing.id },
      data: { status: 'RUNNING', startedAt: new Date(), finishedAt: null, error: null },
    });
  }

  try {
    const summary = await fn(run);
    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        processed: summary.processed,
        skipped: summary.skipped,
        failed: summary.failed,
        meta: (summary.meta ?? {}) as never,
      },
    });
    const durationMs = Date.now() - startedAt;
    logger.info({ jobName, runKey, ...summary, durationMs }, 'job finished');
    return { jobName, runKey, status: 'SUCCESS', durationMs, ...summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2000) },
    });
    logger.error({ err, jobName, runKey }, 'job failed');
    return {
      jobName,
      runKey,
      status: 'FAILED',
      processed: 0,
      skipped: 0,
      failed: 1,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}

/** Trim job history so job_runs does not grow without bound. */
export async function pruneJobRuns(keepDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000);
  const { count } = await prisma.jobRun.deleteMany({ where: { startedAt: { lt: cutoff }, status: 'SUCCESS' } });
  return count;
}
