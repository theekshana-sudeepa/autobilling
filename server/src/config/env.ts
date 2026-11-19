import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail-fast environment validation. The process must not boot with a
 * half-configured billing engine — a missing RESEND_API_KEY in production
 * means silent non-delivery of invoices, which is a revenue incident.
 */
/**
 * `z.coerce.boolean()` is a trap for env vars: it applies JS truthiness, so the
 * STRING "false" coerces to `true`. Setting CRON_ENABLED=false did nothing,
 * which matters most on shared hosting — where the whole strategy is to turn
 * the in-process scheduler off and drive the jobs from cPanel cron instead.
 */
const envBool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_DOMAIN: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'console']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('AutoBilling'),
  MAIL_FROM_EMAIL: z.string().email().default('billing@example.com'),
  MAIL_REPLY_TO: z.string().email().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: envBool(true),

  STORAGE_DIR: z.string().default('./storage'),
  /**
   * Point this at the built admin UI and the API serves it too, so the whole
   * product is ONE process on ONE port. Required on cPanel/Passenger shared
   * hosting, where you cannot configure Nginx. Leave empty on a VPS where
   * Nginx serves the static files itself.
   */
  WEB_DIST: z.string().optional(),
  TIMEZONE: z.string().default('Asia/Colombo'),

  CRON_ENABLED: envBool(true),
  CRON_DAILY_AT: z.string().default('0 8 * * *'), // 08:00 local
  CRON_RETRY_AT: z.string().default('*/15 * * * *'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production' && env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
  // eslint-disable-next-line no-console
  console.error('❌ RESEND_API_KEY is required when EMAIL_PROVIDER=resend in production');
  process.exit(1);
}

export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
