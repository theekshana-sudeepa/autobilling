import { describe, it, expect } from 'vitest';
import {
  dateOnly,
  fmtIso,
  periodFrom,
  periodsDueBy,
  firstPeriodStart,
  nextPeriodStart,
  addMonthsUtc,
  startOfMonthUtc,
  endOfMonthUtc,
  offsetFromDue,
  periodLabel,
} from './dates.js';

/**
 * These tests exist because this file once used date-fns' local-time helpers
 * (startOfMonth / endOfMonth / format) while reading UTC fields. Every period
 * start slipped backwards by the server's UTC offset, so an August run emitted
 * an invoice labelled "May 2026" whose due date fell before the period began.
 *
 * A billing period must mean the same thing on a laptop in Colombo and a VPS
 * in Frankfurt. That is what is pinned here.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('UTC month arithmetic', () => {
  it('finds the start and end of a month without drifting', () => {
    expect(fmtIso(startOfMonthUtc(d('2026-08-17')))).toBe('2026-08-01');
    expect(fmtIso(endOfMonthUtc(d('2026-08-17')))).toBe('2026-08-31');
    expect(fmtIso(endOfMonthUtc(d('2026-02-10')))).toBe('2026-02-28');
    expect(fmtIso(endOfMonthUtc(d('2024-02-10')))).toBe('2024-02-29'); // leap
  });

  it('clamps the day rather than overflowing into the next month', () => {
    expect(fmtIso(addMonthsUtc(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(fmtIso(addMonthsUtc(d('2026-08-31'), 1))).toBe('2026-09-30');
    expect(fmtIso(addMonthsUtc(d('2026-12-15'), 1))).toBe('2027-01-15');
  });

  it('survives a date given as a mid-day instant', () => {
    // A subscription startDate arriving from JSON carries a time component.
    expect(fmtIso(startOfMonthUtc(dateOnly(new Date('2026-07-15T18:45:00.000Z'))))).toBe('2026-07-01');
  });
});

describe('periodFrom', () => {
  it('puts the due date INSIDE the period it bills for', () => {
    const p = periodFrom(d('2026-08-01'), 'MONTHLY', 5);
    expect(fmtIso(p.periodStart)).toBe('2026-08-01');
    expect(fmtIso(p.periodEnd)).toBe('2026-08-31');
    expect(fmtIso(p.dueDate)).toBe('2026-08-05');
    // The regression that started all this: due before start.
    expect(p.dueDate.getTime()).toBeGreaterThanOrEqual(p.periodStart.getTime());
    expect(p.dueDate.getTime()).toBeLessThanOrEqual(p.periodEnd.getTime());
  });

  it('spans three months for a quarterly cycle', () => {
    const p = periodFrom(d('2026-01-01'), 'QUARTERLY', 10);
    expect(fmtIso(p.periodStart)).toBe('2026-01-01');
    expect(fmtIso(p.periodEnd)).toBe('2026-03-31');
    expect(fmtIso(p.dueDate)).toBe('2026-01-10');
  });

  it('spans twelve months for a yearly cycle', () => {
    const p = periodFrom(d('2026-01-01'), 'YEARLY', 1);
    expect(fmtIso(p.periodEnd)).toBe('2026-12-31');
  });

  it('normalises any date inside the month to the first', () => {
    expect(fmtIso(periodFrom(d('2026-08-23'), 'MONTHLY', 5).periodStart)).toBe('2026-08-01');
  });
});

describe('periodsDueBy — what should exist by today', () => {
  const base = {
    subscriptionStart: d('2026-07-01'),
    cycle: 'MONTHLY' as const,
    dueDay: 5,
    leadDays: 0,
  };

  it('bills from the start month, not from some earlier month', () => {
    const periods = periodsDueBy({ ...base, today: d('2026-08-01') });
    // July is due (5 Jul has passed); August is not yet (5 Aug > 1 Aug).
    expect(periods.map((p) => fmtIso(p.periodStart))).toEqual(['2026-07-01']);
    expect(periods.map((p) => fmtIso(p.dueDate))).toEqual(['2026-07-05']);
  });

  it('includes the current month once its due date is reached', () => {
    const periods = periodsDueBy({ ...base, today: d('2026-08-05') });
    expect(periods.map((p) => fmtIso(p.periodStart))).toEqual(['2026-07-01', '2026-08-01']);
  });

  it('honours lead days so an invoice can be raised before it is due', () => {
    const periods = periodsDueBy({ ...base, today: d('2026-08-01'), leadDays: 7 });
    expect(periods.map((p) => fmtIso(p.dueDate))).toEqual(['2026-07-05', '2026-08-05']);
  });

  it('never bills past the subscription end', () => {
    const periods = periodsDueBy({
      ...base,
      subscriptionEnd: d('2026-08-31'),
      today: d('2026-12-01'),
    });
    expect(periods.map((p) => fmtIso(p.periodStart))).toEqual(['2026-07-01', '2026-08-01']);
  });

  it('caps the backfill so a mis-typed 2019 start cannot fire 80 invoices', () => {
    const periods = periodsDueBy({
      ...base,
      subscriptionStart: d('2019-01-01'),
      today: d('2026-08-10'),
      maxBackfill: 12,
    });
    expect(periods).toHaveLength(12);
    // And the ones kept are the most recent, ending with the current month.
    expect(fmtIso(periods[periods.length - 1]!.periodStart)).toBe('2026-08-01');
  });

  it('produces nothing before the first due date has arrived', () => {
    expect(periodsDueBy({ ...base, today: d('2026-07-04') })).toHaveLength(0);
  });
});

describe('period navigation', () => {
  it('steps a monthly subscription forward one month at a time', () => {
    let cursor = firstPeriodStart(d('2026-11-14'));
    expect(fmtIso(cursor)).toBe('2026-11-01');
    cursor = nextPeriodStart(cursor, 'MONTHLY');
    expect(fmtIso(cursor)).toBe('2026-12-01');
    cursor = nextPeriodStart(cursor, 'MONTHLY');
    expect(fmtIso(cursor)).toBe('2027-01-01'); // rolls the year
  });

  it('steps a quarterly subscription three months at a time', () => {
    expect(fmtIso(nextPeriodStart(d('2026-11-01'), 'QUARTERLY'))).toBe('2027-02-01');
  });
});

describe('reminder offsets', () => {
  it('reads negative before the due date and positive after', () => {
    const due = d('2026-08-05');
    expect(offsetFromDue(due, d('2026-07-29'))).toBe(-7);
    expect(offsetFromDue(due, d('2026-08-05'))).toBe(0);
    expect(offsetFromDue(due, d('2026-08-12'))).toBe(7);
  });
});

describe('labels a human reads on the invoice', () => {
  it('names a single month', () => {
    expect(periodLabel(d('2026-08-01'), d('2026-08-31'))).toBe('August 2026');
  });

  it('names a span for a quarter', () => {
    expect(periodLabel(d('2026-01-01'), d('2026-03-31'))).toBe('Jan 2026 – Mar 2026');
  });

  it('does not print the previous day on a server west of UTC', () => {
    // formatInTimeZone(…, 'UTC') is what guarantees this.
    expect(periodLabel(d('2026-03-01'), d('2026-03-31'))).toBe('March 2026');
  });
});
