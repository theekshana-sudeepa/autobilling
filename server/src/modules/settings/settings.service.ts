import { Prisma, type Setting } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { env } from '../../config/env.js';

let cache: { value: Setting; at: number } | null = null;
const TTL_MS = 30_000;

const DEFAULTS = {
  id: 1,
  companyName: 'AutoBilling',
  billingEmail: env.MAIL_FROM_EMAIL,
  defaultCurrency: 'LKR',
  invoicePrefix: 'INV',
  timezone: env.TIMEZONE,
} as const;

/** Singleton row (id = 1), created on first read. Cached for 30s. */
export async function getSettings(force = false): Promise<Setting> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = await prisma.setting.upsert({
    where: { id: 1 },
    update: {},
    create: DEFAULTS,
  });
  cache = { value, at: Date.now() };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function updateSettings(patch: Partial<Setting>): Promise<Setting> {
  // Prisma types a Json column's update as `InputJsonValue | JsonNull` — never
  // plain `null` — so a spread of Partial<Setting> cannot be handed over
  // directly. Split the Json field out and let the rest through untouched.
  const { reminderOffsets, smtpPassword, ...rest } = patch;

  const data: Prisma.SettingUpdateInput = { ...rest };
  if (reminderOffsets !== undefined && reminderOffsets !== null) {
    data.reminderOffsets = reminderOffsets as Prisma.InputJsonValue;
  }
  // An empty password means "leave the stored one alone", not "clear it".
  if (typeof smtpPassword === 'string' && smtpPassword.length > 0) {
    data.smtpPassword = encrypt(smtpPassword);
  }

  const updated = await prisma.setting.update({ where: { id: 1 }, data });
  invalidateSettingsCache();
  return updated;
}

export function readSmtpPassword(s: Setting): string | undefined {
  if (!s.smtpPassword) return undefined;
  try {
    return decrypt(s.smtpPassword);
  } catch {
    return undefined;
  }
}

/** Never ship secrets to the browser. */
export function publicSettings(s: Setting) {
  const { smtpPassword: _omit, ...rest } = s;
  return { ...rest, smtpPasswordSet: Boolean(s.smtpPassword) };
}

export function reminderOffsets(s: Setting): number[] {
  const raw = s.reminderOffsets as unknown;
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  return [-7, -3, 0, 3, 7];
}
