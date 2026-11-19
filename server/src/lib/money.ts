import { Prisma } from '@prisma/client';

export type Decimal = Prisma.Decimal;
export const D = (v: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(v);
export const ZERO = D(0);

/** Round half-up to 2dp — the accounting convention we bill on. */
export const money = (v: Prisma.Decimal.Value): Prisma.Decimal =>
  D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function computeLine(unitPrice: Prisma.Decimal.Value, quantity: Prisma.Decimal.Value = 1) {
  return money(D(unitPrice).mul(D(quantity)));
}

export function computeTotals(input: {
  subtotal: Prisma.Decimal.Value;
  taxRate?: Prisma.Decimal.Value;
  discount?: Prisma.Decimal.Value;
}) {
  const subtotal = money(input.subtotal);
  const discount = money(input.discount ?? 0);
  const taxable = money(subtotal.minus(discount));
  const taxAmount = money(taxable.mul(D(input.taxRate ?? 0)).div(100));
  const total = money(taxable.plus(taxAmount));
  return { subtotal, discount, taxAmount, total };
}

const SYMBOLS: Record<string, string> = {
  LKR: 'Rs.',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  INR: '₹',
};

export function formatMoney(value: Prisma.Decimal.Value, currency = 'LKR'): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const n = D(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
  const [whole = '0', frac = '00'] = n.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${grouped}.${frac}`;
}

/** JSON-safe serialisation — Decimal must never leak to the client as an object. */
export const toNumber = (v: Prisma.Decimal | null | undefined): number => (v ? Number(v.toString()) : 0);
