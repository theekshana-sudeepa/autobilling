import type { EmailType } from '@prisma/client';
import { fmtDate, periodLabel } from '../../../lib/dates.js';
import { formatMoney } from '../../../lib/money.js';
import {
  button,
  calloutBar,
  DEFAULT_THEME,
  escapeHtml,
  p,
  renderLayout,
  strong,
  summaryTable,
  type BrandTheme,
} from './layout.js';

export interface TemplateContext {
  theme: BrandTheme;
  client: { companyName: string; contactPerson?: string | null };
  invoice: {
    invoiceNumber: string;
    periodStart: Date;
    periodEnd: Date;
    dueDate: Date;
    issueDate: Date;
    total: unknown;
    amountPaid?: unknown;
    currency: string;
  };
  serviceName?: string;
  portalUrl: string;
  pdfUrl?: string;
  paymentInstructions?: string | null;
  daysUntilDue?: number;
  daysOverdue?: number;
  payment?: { amount: unknown; method: string; reference?: string | null; paidAt: Date };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const greeting = (c: TemplateContext['client']): string =>
  `Hi ${escapeHtml(c.contactPerson?.split(' ')[0] || c.companyName)},`;

const invoiceRows = (ctx: TemplateContext, extra: { label: string; value: string; tone?: 'danger' | 'warning' }[] = []) => [
  { label: 'Invoice number', value: ctx.invoice.invoiceNumber },
  { label: 'Billing period', value: periodLabel(ctx.invoice.periodStart, ctx.invoice.periodEnd) },
  ...(ctx.serviceName ? [{ label: 'Service', value: ctx.serviceName }] : []),
  { label: 'Due date', value: fmtDate(ctx.invoice.dueDate) },
  ...extra,
  {
    label: 'Amount due',
    value: formatMoney(ctx.invoice.total as never, ctx.invoice.currency),
    strong: true as const,
  },
];

const paymentBlock = (ctx: TemplateContext): string =>
  ctx.paymentInstructions
    ? `<table role="presentation" width="100%" style="background:#F8FAFC;border-radius:10px;margin:20px 0 4px;">
         <tr><td style="padding:18px 20px;">
           <p style="margin:0 0 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                     font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#64748B;">
             How to pay
           </p>
           <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                     font-size:14px;line-height:22px;color:#334155;white-space:pre-line;">${escapeHtml(
                       ctx.paymentInstructions,
                     )}</p>
         </td></tr>
       </table>`
    : '';

const toText = (lines: string[]): string => lines.filter(Boolean).join('\n');

// ---------------------------------------------------------------------------
// 1. INVOICE GENERATED
// ---------------------------------------------------------------------------
export function invoiceCreatedTemplate(ctx: TemplateContext): RenderedEmail {
  const amount = formatMoney(ctx.invoice.total as never, ctx.invoice.currency);
  const period = periodLabel(ctx.invoice.periodStart, ctx.invoice.periodEnd);

  return {
    subject: `Invoice ${ctx.invoice.invoiceNumber} — ${amount} due ${fmtDate(ctx.invoice.dueDate, 'd MMM')}`,
    html: renderLayout({
      theme: ctx.theme,
      eyebrow: 'New invoice',
      preheader: `Your ${period} invoice for ${amount} is ready. Due ${fmtDate(ctx.invoice.dueDate)}.`,
      headline: `Your invoice for ${period}`,
      bodyHtml: `
        ${p(greeting(ctx.client))}
        ${p(`Your invoice for ${strong(period)} is ready. The full breakdown is attached as a PDF.`)}
        ${summaryTable(invoiceRows(ctx))}
        ${button('View invoice', ctx.portalUrl, ctx.theme.primary)}
        ${paymentBlock(ctx)}
        ${p(`Already paid? Ignore this message — our records update within one business day.`)}
      `,
      footerNote: 'Questions about this invoice? Just reply to this email.',
    }),
    text: toText([
      greeting(ctx.client).replace(/<[^>]+>/g, ''),
      '',
      `Your invoice for ${period} is ready.`,
      '',
      `Invoice: ${ctx.invoice.invoiceNumber}`,
      `Amount:  ${amount}`,
      `Due:     ${fmtDate(ctx.invoice.dueDate)}`,
      '',
      `View: ${ctx.portalUrl}`,
      ctx.paymentInstructions ? `\nHow to pay:\n${ctx.paymentInstructions}` : '',
      '',
      `— ${ctx.theme.companyName}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// 2. UPCOMING REMINDER (7 / 3 days before)
// ---------------------------------------------------------------------------
export function upcomingReminderTemplate(ctx: TemplateContext): RenderedEmail {
  const days = ctx.daysUntilDue ?? 0;
  const amount = formatMoney(ctx.invoice.total as never, ctx.invoice.currency);
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;

  return {
    subject: `Reminder: ${amount} due ${when} — ${ctx.invoice.invoiceNumber}`,
    html: renderLayout({
      theme: ctx.theme,
      eyebrow: 'Payment reminder',
      headerTone: 'info',
      preheader: `A friendly reminder that ${amount} is due ${when}.`,
      headline: `Payment due ${when}`,
      bodyHtml: `
        ${calloutBar('info', `Invoice <strong>${escapeHtml(ctx.invoice.invoiceNumber)}</strong> is due on <strong>${fmtDate(ctx.invoice.dueDate)}</strong>.`)}
        ${p(greeting(ctx.client))}
        ${p(`This is a friendly reminder that your ${strong(periodLabel(ctx.invoice.periodStart, ctx.invoice.periodEnd))} invoice is due ${when}.`)}
        ${summaryTable(invoiceRows(ctx, [{ label: 'Days remaining', value: String(days) }]))}
        ${button('Pay this invoice', ctx.portalUrl, ctx.theme.primary)}
        ${paymentBlock(ctx)}
      `,
      footerNote: 'If payment is already on its way, thank you — no action needed.',
    }),
    text: toText([
      `Reminder: invoice ${ctx.invoice.invoiceNumber} for ${amount} is due ${when} (${fmtDate(ctx.invoice.dueDate)}).`,
      '',
      `View: ${ctx.portalUrl}`,
      `— ${ctx.theme.companyName}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// 3. DUE TODAY
// ---------------------------------------------------------------------------
export function dueTodayTemplate(ctx: TemplateContext): RenderedEmail {
  const amount = formatMoney(ctx.invoice.total as never, ctx.invoice.currency);
  return {
    subject: `Due today: ${amount} — invoice ${ctx.invoice.invoiceNumber}`,
    html: renderLayout({
      theme: ctx.theme,
      eyebrow: 'Due today',
      headerTone: 'warning',
      preheader: `Invoice ${ctx.invoice.invoiceNumber} for ${amount} is due today.`,
      headline: 'Your payment is due today',
      bodyHtml: `
        ${calloutBar('warning', `<strong>${amount}</strong> is due today, ${fmtDate(ctx.invoice.dueDate)}.`)}
        ${p(greeting(ctx.client))}
        ${p(`Invoice ${strong(ctx.invoice.invoiceNumber)} covering ${strong(periodLabel(ctx.invoice.periodStart, ctx.invoice.periodEnd))} is due today.`)}
        ${summaryTable(invoiceRows(ctx))}
        ${button('Pay now', ctx.portalUrl, '#F59E0B')}
        ${paymentBlock(ctx)}
      `,
    }),
    text: toText([`Invoice ${ctx.invoice.invoiceNumber} for ${amount} is due today.`, `View: ${ctx.portalUrl}`]),
  };
}

// ---------------------------------------------------------------------------
// 4. OVERDUE REMINDER (3 / 7 days late)
// ---------------------------------------------------------------------------
export function overdueReminderTemplate(ctx: TemplateContext): RenderedEmail {
  const days = ctx.daysOverdue ?? 0;
  const amount = formatMoney(ctx.invoice.total as never, ctx.invoice.currency);

  return {
    subject: `Overdue: ${amount} — invoice ${ctx.invoice.invoiceNumber} (${days} days past due)`,
    html: renderLayout({
      theme: ctx.theme,
      eyebrow: 'Overdue',
      headerTone: 'danger',
      preheader: `Invoice ${ctx.invoice.invoiceNumber} is ${days} days past due.`,
      headline: `Invoice is ${days} ${days === 1 ? 'day' : 'days'} past due`,
      bodyHtml: `
        ${calloutBar('danger', `<strong>${amount}</strong> was due on <strong>${fmtDate(ctx.invoice.dueDate)}</strong> and remains unpaid.`)}
        ${p(greeting(ctx.client))}
        ${p(`We haven't received payment for invoice ${strong(ctx.invoice.invoiceNumber)}. If it has already been sent, please reply with the payment reference so we can reconcile it.`)}
        ${summaryTable(
          invoiceRows(ctx, [{ label: 'Days overdue', value: String(days), tone: 'danger' }]),
        )}
        ${button('Settle this invoice', ctx.portalUrl, '#EF4444')}
        ${paymentBlock(ctx)}
      `,
      footerNote: 'Need more time? Reply to this email and we will work something out.',
    }),
    text: toText([
      `Invoice ${ctx.invoice.invoiceNumber} for ${amount} is ${days} days overdue (due ${fmtDate(ctx.invoice.dueDate)}).`,
      `View: ${ctx.portalUrl}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// 5. FINAL NOTICE
// ---------------------------------------------------------------------------
export function finalNoticeTemplate(ctx: TemplateContext): RenderedEmail {
  const days = ctx.daysOverdue ?? 0;
  const amount = formatMoney(ctx.invoice.total as never, ctx.invoice.currency);

  return {
    subject: `Final notice — ${amount} outstanding on ${ctx.invoice.invoiceNumber}`,
    html: renderLayout({
      theme: ctx.theme,
      eyebrow: 'Final notice',
      headerTone: 'danger',
      preheader: `Final notice before service suspension for invoice ${ctx.invoice.invoiceNumber}.`,
      headline: 'Final payment notice',
      bodyHtml: `
        ${calloutBar('danger', `This invoice is <strong>${days} days overdue</strong>. Service may be suspended if it remains unpaid.`)}
        ${p(greeting(ctx.client))}
        ${p(`Despite previous reminders, invoice ${strong(ctx.invoice.invoiceNumber)} for ${strong(amount)} is still outstanding.`)}
        ${p(`To keep your POS system and support plan active, please settle this invoice or contact us to arrange a payment plan.`)}
        ${summaryTable(invoiceRows(ctx, [{ label: 'Days overdue', value: String(days), tone: 'danger' }]))}
        ${button('Settle now', ctx.portalUrl, '#EF4444')}
        ${paymentBlock(ctx)}
      `,
      footerNote: 'We would much rather sort this out than suspend anything — please get in touch.',
    }),
    text: toText([
      `FINAL NOTICE — invoice ${ctx.invoice.invoiceNumber} for ${amount} is ${days} days overdue.`,
      `View: ${ctx.portalUrl}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// 6. PAYMENT RECEIVED
// ---------------------------------------------------------------------------
export function paymentReceivedTemplate(ctx: TemplateContext): RenderedEmail {
  const paid = formatMoney((ctx.payment?.amount ?? ctx.invoice.total) as never, ctx.invoice.currency);

  return {
    subject: `Payment received — thank you (${ctx.invoice.invoiceNumber})`,
    html: renderLayout({
      theme: ctx.theme,
      eyebrow: 'Receipt',
      headerTone: 'success',
      preheader: `We received your payment of ${paid}. Thank you!`,
      headline: 'Payment received — thank you',
      bodyHtml: `
        ${calloutBar('success', `We received <strong>${paid}</strong>. Invoice ${escapeHtml(ctx.invoice.invoiceNumber)} is settled.`)}
        ${p(greeting(ctx.client))}
        ${p(`Thank you — your payment has been applied and no further reminders will be sent for this invoice.`)}
        ${summaryTable([
          { label: 'Invoice number', value: ctx.invoice.invoiceNumber },
          { label: 'Billing period', value: periodLabel(ctx.invoice.periodStart, ctx.invoice.periodEnd) },
          ...(ctx.payment ? [{ label: 'Payment method', value: ctx.payment.method.replace(/_/g, ' ').toLowerCase() }] : []),
          ...(ctx.payment?.reference ? [{ label: 'Reference', value: ctx.payment.reference }] : []),
          ...(ctx.payment ? [{ label: 'Paid on', value: fmtDate(ctx.payment.paidAt) }] : []),
          { label: 'Amount paid', value: paid, strong: true },
        ])}
        ${button('View receipt', ctx.portalUrl, '#10B981')}
      `,
      footerNote: 'Keep this email as your receipt.',
    }),
    text: toText([
      `Payment of ${paid} received for invoice ${ctx.invoice.invoiceNumber}. Thank you!`,
      `View: ${ctx.portalUrl}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export function renderTemplate(type: EmailType, ctx: TemplateContext): RenderedEmail {
  switch (type) {
    case 'INVOICE_CREATED':
      return invoiceCreatedTemplate(ctx);
    case 'REMINDER_BEFORE_7':
    case 'REMINDER_BEFORE_3':
      return upcomingReminderTemplate(ctx);
    case 'REMINDER_DUE_TODAY':
      return dueTodayTemplate(ctx);
    case 'REMINDER_OVERDUE_3':
    case 'REMINDER_OVERDUE_7':
      return overdueReminderTemplate(ctx);
    case 'FINAL_NOTICE':
      return finalNoticeTemplate(ctx);
    case 'PAYMENT_RECEIVED':
      return paymentReceivedTemplate(ctx);
    default:
      return {
        subject: `Test email from ${ctx.theme.companyName}`,
        html: renderLayout({
          theme: ctx.theme,
          preheader: 'Email delivery test',
          headline: 'Email delivery is working',
          bodyHtml: p('If you can read this, your billing email configuration is correct.'),
        }),
        text: 'Email delivery is working.',
      };
  }
}

export { DEFAULT_THEME };
