import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';

const SYMBOLS: Record<string, string> = { LKR: 'Rs.', USD: '$', EUR: '€', GBP: '£', INR: '₹', AUD: 'A$' };

export function money(value: number | string | null | undefined, currency = 'LKR', compact = false): string {
  const n = Number(value ?? 0);
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  if (compact && Math.abs(n) >= 1_000_000) return `${symbol}${(n / 1_000_000).toFixed(1)}M`;
  if (compact && Math.abs(n) >= 10_000) return `${symbol}${(n / 1000).toFixed(1)}K`;
  return `${symbol}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const toDate = (d: Date | string | null | undefined): Date | null => {
  if (!d) return null;
  const parsed = typeof d === 'string' ? parseISO(d) : d;
  return isValid(parsed) ? parsed : null;
};

export const date = (d: Date | string | null | undefined, pattern = 'dd MMM yyyy'): string => {
  const parsed = toDate(d);
  return parsed ? format(parsed, pattern) : '—';
};

export const dateTime = (d: Date | string | null | undefined): string => date(d, "dd MMM yyyy 'at' HH:mm");

export const relative = (d: Date | string | null | undefined): string => {
  const parsed = toDate(d);
  return parsed ? `${formatDistanceToNowStrict(parsed)} ago` : '—';
};

/** "in 5 days" / "3 days overdue" — the phrase every billing screen needs. */
export function dueLabel(dueDate: Date | string, status?: string): { text: string; tone: 'muted' | 'warning' | 'danger' | 'success' } {
  if (status === 'PAID') return { text: 'Paid', tone: 'success' };
  if (status === 'VOID') return { text: 'Void', tone: 'muted' };
  const parsed = toDate(dueDate);
  if (!parsed) return { text: '—', tone: 'muted' };

  const days = Math.round((parsed.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return { text: 'Due today', tone: 'warning' };
  if (days > 0) return { text: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: days <= 3 ? 'warning' : 'muted' };
  return { text: `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue`, tone: 'danger' };
}

export const percent = (n: number | null | undefined, digits = 1): string =>
  `${Number(n ?? 0).toFixed(digits)}%`;

export const initials = (name: string): string =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');

export const titleCase = (s: string): string =>
  s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
