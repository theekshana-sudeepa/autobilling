import { Resend } from 'resend';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getSettings, readSmtpPassword } from '../../modules/settings/settings.service.js';

export interface OutboundEmail {
  to: string;
  cc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

export interface SendOutcome {
  ok: boolean;
  providerId?: string;
  provider: string;
  error?: string;
  /** false for 4xx-style permanent failures — the retry job must not loop on those. */
  retryable: boolean;
}

const PERMANENT_PATTERNS = [
  /invalid.*email/i,
  /recipient.*rejected/i,
  /no such user/i,
  /domain.*not found/i,
  /unsubscribed/i,
  /suppress/i,
  /blocked/i,
];

const isPermanent = (msg: string): boolean => PERMANENT_PATTERNS.some((re) => re.test(msg));

let resendClient: Resend | null = null;
const resend = (): Resend => {
  if (!resendClient) {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
    resendClient = new Resend(env.RESEND_API_KEY);
  }
  return resendClient;
};

let smtpTransport: Transporter | null = null;
async function smtp(): Promise<Transporter> {
  if (smtpTransport) return smtpTransport;
  const settings = await getSettings();
  const host = settings.smtpHost ?? env.SMTP_HOST;
  const port = settings.smtpPort ?? env.SMTP_PORT ?? 587;
  const user = settings.smtpUser ?? env.SMTP_USER;
  const pass = readSmtpPassword(settings) ?? env.SMTP_PASSWORD;
  if (!host || !user || !pass) throw new Error('SMTP fallback is not configured');

  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465 ? true : settings.smtpSecure,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    rateDelta: 1000,
    rateLimit: 5,
  });
  return smtpTransport;
}

export function resetTransports(): void {
  smtpTransport = null;
  resendClient = null;
}

async function sendViaResend(mail: OutboundEmail, from: string): Promise<SendOutcome> {
  const { data, error } = await resend().emails.send({
    from,
    to: [mail.to],
    cc: mail.cc?.length ? mail.cc : undefined,
    replyTo: mail.replyTo,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: mail.headers,
    tags: mail.tags,
    attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
  });

  if (error) {
    const msg = `${error.name}: ${error.message}`;
    return { ok: false, provider: 'resend', error: msg, retryable: !isPermanent(msg) };
  }
  return { ok: true, provider: 'resend', providerId: data?.id, retryable: false };
}

async function sendViaSmtp(mail: OutboundEmail, from: string): Promise<SendOutcome> {
  const transport = await smtp();
  const info = await transport.sendMail({
    from,
    to: mail.to,
    cc: mail.cc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: mail.headers,
    attachments: mail.attachments,
  });
  return { ok: true, provider: 'smtp', providerId: info.messageId, retryable: false };
}

/**
 * Send with automatic provider failover.
 *
 * Resend is primary. If Resend is *unreachable* (network/5xx) and SMTP is
 * configured we fail over, because a billing email that arrives via a backup
 * path is worth far more than a perfectly-branded one that never arrives.
 * Permanent rejections (bad address) are never retried on either transport.
 */
export async function sendEmail(mail: OutboundEmail): Promise<SendOutcome> {
  const settings = await getSettings();
  const fromName = settings.companyName || env.MAIL_FROM_NAME;
  const fromEmail = settings.billingEmail || env.MAIL_FROM_EMAIL;
  const from = `${fromName} <${fromEmail}>`;
  const replyTo = mail.replyTo ?? settings.replyToEmail ?? fromEmail;
  const withReply = { ...mail, replyTo };

  const provider = settings.emailProvider === 'smtp' ? 'smtp' : env.EMAIL_PROVIDER;

  if (provider === 'console') {
    logger.info({ to: mail.to, subject: mail.subject }, '[console mailer] email not actually sent');
    return { ok: true, provider: 'console', providerId: `console-${Date.now()}`, retryable: false };
  }

  try {
    if (provider === 'smtp') return await sendViaSmtp(withReply, from);
    return await sendViaResend(withReply, from);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: mail.to, provider }, 'primary email transport threw');

    const canFailover = provider === 'resend' && Boolean(settings.smtpHost ?? env.SMTP_HOST) && !isPermanent(message);
    if (canFailover) {
      try {
        logger.warn({ to: mail.to }, 'failing over to SMTP');
        return await sendViaSmtp(withReply, from);
      } catch (fallbackErr) {
        const m2 = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return { ok: false, provider: 'smtp', error: `resend: ${message} | smtp: ${m2}`, retryable: true };
      }
    }
    return { ok: false, provider, error: message, retryable: !isPermanent(message) };
  }
}
