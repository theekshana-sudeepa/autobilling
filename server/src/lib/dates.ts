import { addDays, differenceInCalendarDays, isAfter, isBefore } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import type { BillingCycle } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * BILLING DATES — UTC, always, with no exceptions
 * ---------------------------------------------------------------------------
 * A billing period is a DATE, not an instant. It must mean the same thing on a
 * laptop in Colombo and a VPS in Frankfurt, so every value here is a UTC
 * midnight and every calculation is done on UTC fields.
 *
 * This file deliberately does NOT use date-fns' startOfMonth / endOfMonth /
 * addMonths / format. Those operate in the *host machine's local timezone*.
 * Mixing them with UTC field reads shifts every period start backwards by the
 * server's offset — which produced invoices labelled "May 2026" for an August
 * run, with a due date that fell before the period had even started.
 *
 * The only place local time is allowed to matter is `businessToday()`, where
 * the company's own timezone decides what day it is.
 */

/** Strip a Date to its UTC calendar day. */
export function dateOnly(d: Date | string): Date {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** First day of that UTC month, at UTC midnight. */
export function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Last day of that UTC month, at UTC midnight. Day 0 of next month. */
export function endOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/**
 * Add whole months in UTC, clamping the day so 31 Jan + 1 month is 28/29 Feb
 * rather than 3 March. Period starts are always day 1, but this is also used
 * for horizons where the day can be anything.
 */
export function addMonthsUtc(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
}

/** "Today" from the company's point of view, as a UTC-midnight date. */
export function businessToday(timezone: string): Date {
  const iso = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Format a billing date. Pinned to UTC: `format()` would render the *local*
 * calendar day, which on any server west of UTC prints the day before.
 */
export const fmtDate = (d: Date, pattern = 'dd MMM yyyy'): string =>
  formatInTimeZone(dateOnly(d), 'UTC', pattern);

export const fmtIso = (d: Date): string => formatInTimeZone(dateOnly(d), 'UTC', 'yyyy-MM-dd');

export const nowInTz = (timezone: string): Date =>
  new Date(formatInTimeZone(new Date(), timezone, "yyyy-MM-dd'T'HH:mm:ss"));

export function cycleMonths(cycle: BillingCycle): number {
  switch (cycle) {
    case 'MONTHLY':
      return 1;
    case 'QUARTERLY':
      return 3;
    case 'YEARLY':
      return 12;
    default:
      return 1;
  }
}

export interface BillingPeriod {
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
}

/**
 * Given any date inside a billing period, produce the full period window and
 * the due date. `dueDay` is constrained to 1..28 at the schema level so we
 * never have to guess what "the 31st of February" means.
 */
export function periodFrom(periodStart: Date, cycle: BillingCycle, dueDay: number): BillingPeriod {
  const start = startOfMonthUtc(dateOnly(periodStart));
  const months = cycleMonths(cycle);
  const end = endOfMonthUtc(addMonthsUtc(start, months - 1));
  const day = Math.min(Math.max(dueDay, 1), 28);
  const dueDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day));
  return { periodStart: start, periodEnd: end, dueDate };
}

/** The very first period a subscription should ever be billed for. */
export function firstPeriodStart(startDate: Date): Date {
  return startOfMonthUtc(dateOnly(startDate));
}

/** Advance to the next period start for the cycle. */
export function nextPeriodStart(periodStart: Date, cycle: BillingCycle): Date {
  return startOfMonthUtc(addMonthsUtc(startOfMonthUtc(dateOnly(periodStart)), cycleMonths(cycle)));
}

/**
 * Every period that should exist by `today`, given a lead time.
 * Pure function — the generator job diffs this against the DB.
 *
 * Guardrails:
 *   • never before the subscription start
 *   • never after the subscription end
 *   • hard cap so a mis-set 2019 start date cannot emit 80 invoices at once
 */
export function periodsDueBy(params: {
  subscriptionStart: Date;
  subscriptionEnd?: Date | null;
  cycle: BillingCycle;
  dueDay: number;
  today: Date;
  leadDays: number;
  maxBackfill?: number;
}): BillingPeriod[] {
  const { subscriptionStart, subscriptionEnd, cycle, dueDay, today, leadDays } = params;
  const maxBackfill = params.maxBackfill ?? 12;
  const horizon = dateOnly(addDays(dateOnly(today), leadDays));

  // Start the walk at the LATER of the subscription's first period and
  // `maxBackfill` cycles before the horizon.
  //
  // Walking from the subscription start and truncating afterwards looks
  // equivalent and is not: a client onboarded with a 2019 start date would
  // exhaust the iteration budget somewhere in 2020 and be invoiced for
  // periods six years stale, while the month they actually owe was never
  // reached. Anchoring near the horizon bills the recent periods and bounds
  // the loop at the same time.
  const earliest = firstPeriodStart(subscriptionStart);
  const window = startOfMonthUtc(addMonthsUtc(horizon, -maxBackfill * cycleMonths(cycle)));
  let cursor = isAfter(window, earliest) ? window : earliest;

  const out: BillingPeriod[] = [];
  for (let i = 0; i < maxBackfill + 2; i += 1) {
    const period = periodFrom(cursor, cycle, dueDay);
    if (isAfter(period.dueDate, horizon)) break;
    if (subscriptionEnd && isAfter(period.periodStart, dateOnly(subscriptionEnd))) break;
    out.push(period);
    cursor = nextPeriodStart(cursor, cycle);
  }

  // Keep only the most recent `maxBackfill` so onboarding an old client does
  // not fire a year of invoices in one night.
  return out.slice(-maxBackfill);
}

/** Signed day offset relative to due date. -7 = seven days before due. */
export function offsetFromDue(dueDate: Date, today: Date): number {
  return differenceInCalendarDays(dateOnly(today), dateOnly(dueDate));
}

export const isPast = (d: Date, today: Date): boolean => isBefore(dateOnly(d), dateOnly(today));

export function periodLabel(start: Date, end: Date): string {
  const s = dateOnly(start);
  const e = dateOnly(end);
  if (s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()) {
    return formatInTimeZone(s, 'UTC', 'MMMM yyyy');
  }
  return `${formatInTimeZone(s, 'UTC', 'MMM yyyy')} – ${formatInTimeZone(e, 'UTC', 'MMM yyyy')}`;
}
