import type { EmailLog, EmailType, Invoice, Client, Setting } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { getSettings } from '../../modules/settings/settings.service.js';
import { renderTemplate, type TemplateContext } from './templates/index.js';
import { sendEmail, type OutboundEmail } from './provider.js';
import { getOrBuildInvoicePdf } from '../pdf/invoicePdf.js';
import { businessToday, dateOnly, offsetFromDue } from '../../lib/dates.js';

/**
 * The dedupe key IS the idempotency guarantee.
 *
 * One row per (invoice, email type). A UNIQUE index on this column means that
 * however many times the cron runs — every minute, twice at once, after a
 * crash-restart mid-batch — a client receives each reminder exactly once.
 */
export const dedupeKeyFor = (type: EmailType, invoiceId: string): string => `invoice:${invoiceId}:${type}`;

export interface QueueEmailInput {
  type: EmailType;
  invoiceId: string;
  attachPdf?: boolean;
  /** Force a resend even though the dedupe key exists (manual operator action). */
  force?: boolean;
  /**
   * The date this send is *for*, which is not always the date it happens on.
   * A catch-up run of Monday's reminders on Wednesday must still tell the
   * client "due in 3 days" — the number Monday's email would have carried —
   * not a figure derived from Wednesday's clock.
   */
  asOf?: Date;
}

export interface QueueResult {
  status: 'sent' | 'failed' | 'skipped';
  emailLogId?: string;
  reason?: string;
}

function themeFrom(settings: Setting) {
  return {
    companyName: settings.companyName,
    logoUrl: settings.logoPath ? `${env.API_URL}${settings.logoPath}` : null,
    primary: '#4F46E5',
    accent: '#0EA5E9',
    supportEmail: settings.billingEmail,
    website: settings.website,
    address: [settings.addressLine1, settings.addressLine2, settings.city, settings.country].filter(Boolean).join(', ') || null,
  };
}

function buildContext(
  settings: Setting,
  invoice: Invoice & { client: Client; subscription?: { serviceName: string } | null },
  type: EmailType,
  payment?: TemplateContext['payment'],
  asOf?: Date,
): TemplateContext {
  const today = asOf ? dateOnly(asOf) : businessToday(settings.timezone);
  // offsetFromDue is UTC-safe and signed: negative before the due date.
  const delta = -offsetFromDue(invoice.dueDate, today);

  return {
    theme: themeFrom(settings),
    client: { companyName: invoice.client.companyName, contactPerson: invoice.client.contactPerson },
    invoice: {
      invoiceNumber: invoice.invoiceNumber,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      dueDate: invoice.dueDate,
      issueDate: invoice.issueDate,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      currency: invoice.currency,
    },
    serviceName: invoice.subscription?.serviceName,
    portalUrl: `${env.APP_URL}/invoices/${invoice.id}`,
    paymentInstructions: settings.paymentInstructions,
    daysUntilDue: Math.max(delta, 0),
    daysOverdue: Math.max(-delta, 0),
    payment,
    ...(type === 'PAYMENT_RECEIVED' ? {} : {}),
  };
}

const recipientsFor = (client: Client): { to: string; cc: string[] } => ({
  to: client.billingEmail || client.email,
  cc: (client.ccEmails ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

/**
 * Claim → render → send → record.
 *
 * The row is INSERTed first, in QUEUED state, so that the dedupe key is taken
 * before we spend money on rendering and delivery. If the insert collides we
 * know another worker already owns this email and we bail out immediately.
 */
export async function queueAndSend(input: QueueEmailInput & { payment?: TemplateContext['payment'] }): Promise<QueueResult> {
  const settings = await getSettings();

  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    include: { client: true, subscription: { select: { serviceName: true } } },
  });
  if (!invoice) return { status: 'skipped', reason: 'invoice_not_found' };
  if (invoice.status === 'VOID') return { status: 'skipped', reason: 'invoice_void' };
  if (invoice.client.deletedAt) return { status: 'skipped', reason: 'client_deleted' };

  const baseKey = dedupeKeyFor(input.type, invoice.id);
  const dedupeKey = input.force ? `${baseKey}:manual:${Date.now()}` : baseKey;

  const { to, cc } = recipientsFor(invoice.client);
  const ctx = buildContext(settings, invoice, input.type, input.payment, input.asOf);
  const rendered = renderTemplate(input.type, ctx);

  // --- claim the slot -----------------------------------------------------
  let log: EmailLog;
  try {
    log = await prisma.emailLog.create({
      data: {
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        type: input.type,
        status: 'QUEUED',
        toEmail: to,
        ccEmails: cc.join(',') || null,
        subject: rendered.subject,
        dedupeKey,
        provider: settings.emailProvider,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.debug({ dedupeKey }, 'email already queued/sent — skipping');
      return { status: 'skipped', reason: 'already_sent' };
    }
    throw err;
  }

  return deliver(log, rendered, invoice, input.attachPdf ?? false);
}

async function deliver(
  log: EmailLog,
  rendered: { subject: string; html: string; text: string },
  invoice: Invoice & { client: Client },
  attachPdf: boolean,
): Promise<QueueResult> {
  const cc = (log.ccEmails ?? '').split(',').filter(Boolean);

  const mail: OutboundEmail = {
    to: log.toEmail,
    cc,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      'X-Entity-Ref-ID': log.dedupeKey, // provider-side dedupe, belt & braces
      'X-Invoice-Number': invoice.invoiceNumber,
    },
    tags: [
      { name: 'type', value: log.type.toLowerCase() },
      { name: 'invoice', value: invoice.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '_') },
    ],
  };

  if (attachPdf) {
    try {
      const pdf = await getOrBuildInvoicePdf(invoice.id);
      mail.attachments = [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf.buffer, contentType: 'application/pdf' }];
    } catch (err) {
      // A missing PDF must not block the reminder — the email links to the portal.
      logger.error({ err, invoiceId: invoice.id }, 'pdf attach failed, sending without attachment');
    }
  }

  const outcome = await sendEmail(mail);
  const attempts = log.attempts + 1;

  if (outcome.ok) {
    await prisma.$transaction([
      prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'SENT', sentAt: new Date(), providerId: outcome.providerId, provider: outcome.provider, attempts, lastError: null, nextRetryAt: null },
      }),
      prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          remindersSent: { increment: log.type.startsWith('REMINDER') || log.type === 'FINAL_NOTICE' ? 1 : 0 },
          lastReminderAt: new Date(),
          ...(log.type === 'INVOICE_CREATED' && invoice.status === 'DRAFT'
            ? { status: 'SENT', sentAt: new Date() }
            : {}),
        },
      }),
    ]);
    logger.info({ emailLogId: log.id, type: log.type, to: log.toEmail }, 'email sent');
    return { status: 'sent', emailLogId: log.id };
  }

  const exhausted = attempts >= log.maxAttempts || !outcome.retryable;
  await prisma.emailLog.update({
    where: { id: log.id },
    data: {
      status: exhausted ? 'FAILED' : 'QUEUED',
      attempts,
      lastError: outcome.error?.slice(0, 2000),
      nextRetryAt: exhausted ? null : nextBackoff(attempts),
    },
  });

  logger.error({ emailLogId: log.id, attempts, error: outcome.error, exhausted }, 'email delivery failed');
  return { status: 'failed', emailLogId: log.id, reason: outcome.error };
}

/** Exponential backoff with jitter: ~2m, 8m, 32m, 2h, 8h. */
export function nextBackoff(attempt: number): Date {
  const base = 2 * 60 * 1000 * 4 ** (attempt - 1);
  const capped = Math.min(base, 8 * 60 * 60 * 1000);
  const jitter = capped * (0.85 + Math.random() * 0.3);
  return new Date(Date.now() + jitter);
}

/**
 * Retry sweep. Only picks up rows that are QUEUED with a due nextRetryAt, so
 * a permanently-rejected address (status FAILED, nextRetryAt null) is never
 * retried and never burns provider quota.
 */
export async function retryPendingEmails(limit = 50): Promise<{ retried: number; sent: number; failed: number }> {
  const settings = await getSettings();
  const due = await prisma.emailLog.findMany({
    where: { status: 'QUEUED', nextRetryAt: { lte: new Date() }, attempts: { gt: 0 } },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
  });

  let sent = 0;
  let failed = 0;

  for (const log of due) {
    if (!log.invoiceId) continue;
    const invoice = await prisma.invoice.findUnique({
      where: { id: log.invoiceId },
      include: { client: true, subscription: { select: { serviceName: true } } },
    });
    if (!invoice || invoice.status === 'VOID' || invoice.status === 'PAID') {
      await prisma.emailLog.update({ where: { id: log.id }, data: { status: 'CANCELLED', nextRetryAt: null } });
      continue;
    }

    const ctx = buildContext(settings, invoice, log.type);
    const rendered = renderTemplate(log.type, ctx);
    const result = await deliver(log, rendered, invoice, log.type === 'INVOICE_CREATED');
    if (result.status === 'sent') sent += 1;
    else failed += 1;
  }

  return { retried: due.length, sent, failed };
}

/** Operator-triggered "resend this email" from the Email Logs page. */
export async function resendEmailLog(id: string): Promise<QueueResult> {
  const log = await prisma.emailLog.findUnique({ where: { id } });
  if (!log?.invoiceId) return { status: 'skipped', reason: 'not_resendable' };
  return queueAndSend({
    type: log.type,
    invoiceId: log.invoiceId,
    attachPdf: log.type === 'INVOICE_CREATED',
    force: true,
  });
}

/** Cancel every pending reminder for an invoice — called the moment it is paid. */
export async function cancelPendingReminders(invoiceId: string): Promise<number> {
  const { count } = await prisma.emailLog.updateMany({
    where: { invoiceId, status: { in: ['QUEUED', 'FAILED'] }, type: { not: 'PAYMENT_RECEIVED' } },
    data: { status: 'CANCELLED', nextRetryAt: null },
  });
  return count;
}
