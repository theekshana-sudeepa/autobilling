import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Gap-free, race-safe sequence allocation.
 *
 * `INSERT … ON DUPLICATE KEY UPDATE` takes an exclusive row lock on
 * (scope, year). A second transaction asking for the same sequence blocks
 * until this one commits, so two invoices can never be handed the same
 * number — which is what keeps numbering correct when the cron generates 400
 * invoices while a human creates a manual one at the same instant.
 *
 * We then read the value back with a plain SELECT inside the same
 * transaction, which sees our own uncommitted write.
 *
 * DO NOT be tempted back to the LAST_INSERT_ID(expr) trick here. It looks
 * neater and it is wrong for this table: `number_sequences` has an
 * AUTO_INCREMENT `id`, and on the *insert* path MySQL overwrites the session's
 * LAST_INSERT_ID with the new row's auto-increment value. The first invoice of
 * a year came back numbered after the sequences table's row id instead of the
 * counter, and the second one then collided with it — the engine stopped
 * issuing invoices entirely on a client's second month.
 */
export async function nextSequence(
  scope: string,
  year: number,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO number_sequences (scope, year, current, updatedAt)
    VALUES (${scope}, ${year}, 1, NOW(3))
    ON DUPLICATE KEY UPDATE current = current + 1, updatedAt = NOW(3)
  `;
  const rows = await tx.$queryRaw<Array<{ current: number | bigint }>>`
    SELECT current FROM number_sequences WHERE scope = ${scope} AND year = ${year}
  `;
  const seq = rows[0]?.current;
  if (seq === undefined) throw new Error(`Failed to allocate sequence for ${scope}/${year}`);
  return Number(seq);
}

/** INV-2026-00081 */
export async function nextInvoiceNumber(
  prefix: string,
  date: Date,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const year = date.getUTCFullYear();
  const seq = await nextSequence('invoice', year, tx);
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

/** CLI-0001 — sequence is global (year 0) so client codes never restart. */
export async function nextClientCode(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const seq = await nextSequence('client', 0, tx);
  return `CLI-${String(seq).padStart(4, '0')}`;
}
