import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * Invoice numbering, against a real MySQL.
 *
 * These exist because the original implementation used MySQL's
 * LAST_INSERT_ID(expr) trick on a table that has an AUTO_INCREMENT `id`. On
 * the insert path MySQL overwrites the session's LAST_INSERT_ID with the new
 * row's auto-increment value, so the first invoice of a year was numbered
 * after the sequences table's row id rather than the counter — and the second
 * one collided with it and could not be created at all.
 *
 * Skips itself unless TEST_DATABASE_URL is set, so `npm test` always runs.
 */

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

describeDb('nextSequence / nextInvoiceNumber', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let nextSequence: typeof import('./numbering.js').nextSequence;
  let nextInvoiceNumber: typeof import('./numbering.js').nextInvoiceNumber;
  let nextClientCode: typeof import('./numbering.js').nextClientCode;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    ({ prisma } = await import('./prisma.js'));
    ({ nextSequence, nextInvoiceNumber, nextClientCode } = await import('./numbering.js'));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`DELETE FROM number_sequences`;
  });

  it('starts at 1, not at the sequences table row id', async () => {
    // The original bug: the very first allocation returned the auto-increment
    // id of the row it had just inserted.
    await nextSequence('client', 0); // burn a row so ids and counters diverge
    const first = await nextSequence('invoice', 2026);
    expect(first).toBe(1);
  });

  it('numbers the first two invoices of a year 00001 and 00002', async () => {
    const a = await nextInvoiceNumber('INV', new Date('2026-08-01T00:00:00Z'));
    const b = await nextInvoiceNumber('INV', new Date('2026-09-01T00:00:00Z'));
    expect(a).toBe('INV-2026-00001');
    expect(b).toBe('INV-2026-00002');
  });

  it('keeps a separate counter per year', async () => {
    await nextInvoiceNumber('INV', new Date('2026-12-01T00:00:00Z'));
    const next2027 = await nextInvoiceNumber('INV', new Date('2027-01-01T00:00:00Z'));
    expect(next2027).toBe('INV-2027-00001');
  });

  it('keeps a separate counter per scope', async () => {
    await nextInvoiceNumber('INV', new Date('2026-08-01T00:00:00Z'));
    await nextInvoiceNumber('INV', new Date('2026-08-01T00:00:00Z'));
    expect(await nextClientCode()).toBe('CLI-0001'); // untouched by invoices
  });

  it('is gap-free and collision-free under concurrency', async () => {
    // Twenty simultaneous allocations, as the cron would do on a busy 1st.
    const N = 20;
    const numbers = await Promise.all(
      Array.from({ length: N }, () =>
        prisma.$transaction((tx) => nextSequence('invoice', 2026, tx)),
      ),
    );

    const sorted = [...numbers].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // 1..20, no gaps
    expect(new Set(numbers).size).toBe(N); // and no duplicates
  });

  it('pads to five digits so invoices sort lexically', async () => {
    await prisma.$executeRaw`
      INSERT INTO number_sequences (scope, year, current, updatedAt) VALUES ('invoice', 2026, 41, NOW(3))
    `;
    expect(await nextInvoiceNumber('INV', new Date('2026-08-01T00:00:00Z'))).toBe('INV-2026-00042');
  });
});
