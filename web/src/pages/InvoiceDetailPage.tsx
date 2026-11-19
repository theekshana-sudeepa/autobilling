import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  ArrowLeft, Download, Send, Ban, CheckCircle2, Mail, Clock, FileText, ExternalLink, RefreshCw,
} from 'lucide-react';
import { api, openInvoicePdf } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import { money, date, dateTime, titleCase, dueLabel } from '@/lib/format';
import type { Invoice } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Input, Label, Textarea } from '@/components/ui/input';
import { StatusBadge, EmailStatusBadge } from '@/components/common/StatusBadge';
import { Modal, ConfirmDialog } from '@/components/common/Modal';
import { ErrorState } from '@/components/common/states';
import { Table, TBody, TD, TH, THead, TR } from '@/components/common/DataTable';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/utils';

const paymentSchema = z.object({
  amount: z.coerce.number().positive('Enter an amount greater than zero'),
  method: z.enum(['BANK_TRANSFER', 'CASH', 'CARD', 'CHEQUE', 'ONLINE', 'OTHER']),
  reference: z.string().trim().max(120).optional(),
  paidAt: z.string().min(1, 'Payment date is required'),
  notes: z.string().trim().max(2000).optional(),
  sendReceipt: z.boolean(),
});
type PaymentValues = z.infer<typeof paymentSchema>;

interface TimelineEntry {
  offset: number;
  type: string;
  scheduledFor: string;
  state: 'sent' | 'scheduled' | 'missed' | 'cancelled';
  sentAt: string | null;
}

export default function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [payOpen, setPayOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);

  const { data: invoice, isLoading, error, refetch } = useQuery({
    queryKey: qk.invoice(id),
    queryFn: () => api.get<Invoice>(`/invoices/${id}`),
    enabled: Boolean(id),
  });

  const { data: timeline } = useQuery({
    queryKey: qk.invoiceTimeline(id),
    queryFn: () => api.get<TimelineEntry[]>(`/email-logs/timeline/${id}`),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.invoice(id) });
    void qc.invalidateQueries({ queryKey: qk.invoiceTimeline(id) });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: qk.dashboard });
  };

  const sendInvoice = useMutation({
    mutationFn: (force: boolean) => api.post(`/invoices/${id}/send`, { force }),
    onSuccess: (result: unknown) => {
      const status = (result as { status: string }).status;
      if (status === 'sent') toast.success('Invoice emailed', { description: `Sent to ${invoice?.client?.billingEmail || invoice?.client?.email}` });
      else if (status === 'skipped') toast.info('Already sent', { description: 'Use “Resend” to send it again.' });
      else toast.error('Delivery failed', { description: 'It is queued for automatic retry.' });
      invalidate();
    },
    onError: (e) => toast.error('Could not send', { description: (e as Error).message }),
  });

  const recordPayment = useMutation({
    mutationFn: (values: PaymentValues) => api.post('/payments', { ...values, invoiceId: id }),
    onSuccess: () => {
      toast.success('Payment recorded', { description: 'Reminders for this invoice have stopped.' });
      setPayOpen(false);
      invalidate();
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: (e) => toast.error('Could not record payment', { description: (e as Error).message }),
  });

  const voidInvoice = useMutation({
    mutationFn: (reason: string) => api.post(`/invoices/${id}/void`, { reason }),
    onSuccess: () => {
      toast.success('Invoice voided');
      setVoidOpen(false);
      invalidate();
    },
    onError: (e) => toast.error('Could not void', { description: (e as Error).message }),
  });

  const balance = invoice ? Number(invoice.total) - Number(invoice.amountPaid) : 0;

  const paymentForm = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    values: {
      amount: balance,
      method: 'BANK_TRANSFER',
      reference: '',
      paidAt: new Date().toISOString().slice(0, 10),
      notes: '',
      sendReceipt: true,
    },
  });

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading || !invoice) {
    return (
      <div className="flex flex-col gap-5">
        <div className="skeleton h-8 w-56" />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="skeleton h-96 rounded-xl lg:col-span-2" />
          <div className="skeleton h-96 rounded-xl" />
        </div>
      </div>
    );
  }

  const due = dueLabel(invoice.dueDate, invoice.status);
  const settled = invoice.status === 'PAID' || invoice.status === 'VOID';

  return (
    <div className="flex flex-col gap-5 animate-[fade-in_.2s_ease-out]">
      {/* --- header --- */}
      <div className="flex flex-col gap-4">
        <Link to="/invoices" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> All invoices
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="tabular text-xl font-semibold tracking-tight sm:text-2xl">{invoice.invoiceNumber}</h1>
              <StatusBadge status={invoice.status} />
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              <Link to={`/clients/${invoice.clientId}`} className="font-medium text-foreground hover:text-primary">
                {invoice.client?.companyName}
              </Link>
              {' · '}{date(invoice.periodStart, 'MMMM yyyy')}
              {' · '}
              <span className={cn(
                due.tone === 'danger' && 'font-medium text-destructive',
                due.tone === 'warning' && 'font-medium text-warning',
                due.tone === 'success' && 'text-success',
              )}>
                {due.text}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="outline" size="sm" onClick={() => void openInvoicePdf(invoice.id, invoice.invoiceNumber)}>
              <ExternalLink aria-hidden /> View PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => void openInvoicePdf(invoice.id, invoice.invoiceNumber, true)}>
              <Download aria-hidden /> Download
            </Button>
            {!settled ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  loading={sendInvoice.isPending}
                  onClick={() => sendInvoice.mutate(invoice.status !== 'DRAFT')}
                >
                  {invoice.sentAt ? <RefreshCw aria-hidden /> : <Send aria-hidden />}
                  {invoice.sentAt ? 'Resend' : 'Send invoice'}
                </Button>
                <Button size="sm" onClick={() => setPayOpen(true)}>
                  <CheckCircle2 aria-hidden /> Record payment
                </Button>
              </>
            ) : null}
            {isAdmin && invoice.status !== 'VOID' && invoice.status !== 'PAID' ? (
              <Button variant="ghost" size="sm" onClick={() => setVoidOpen(true)}>
                <Ban aria-hidden /> Void
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- money strip --- */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Invoice total</p>
          <p className="tabular mt-1.5 text-2xl font-semibold">{money(invoice.total, invoice.currency)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Paid</p>
          <p className="tabular mt-1.5 text-2xl font-semibold text-success">{money(invoice.amountPaid, invoice.currency)}</p>
        </CardContent></Card>
        <Card className={balance > 0 ? 'border-warning/40' : undefined}><CardContent className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Balance due</p>
          <p className={cn('tabular mt-1.5 text-2xl font-semibold', balance > 0 ? 'text-warning' : 'text-muted-foreground')}>
            {money(balance, invoice.currency)}
          </p>
        </CardContent></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- line items + payments --- */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Line items</CardTitle></CardHeader>
            <Table>
              <THead>
                <TR><TH>Description</TH><TH align="right">Qty</TH><TH align="right">Unit price</TH><TH align="right">Amount</TH></TR>
              </THead>
              <TBody>
                {invoice.items?.map((item) => (
                  <TR key={item.id}>
                    <TD className="font-medium">{item.description}</TD>
                    <TD align="right" className="tabular text-muted-foreground">{Number(item.quantity)}</TD>
                    <TD align="right" className="tabular text-muted-foreground">{money(item.unitPrice, invoice.currency)}</TD>
                    <TD align="right" className="tabular font-medium">{money(item.lineTotal, invoice.currency)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex justify-end border-t border-border p-4">
              <dl className="w-full max-w-xs space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd className="tabular">{money(invoice.subtotal, invoice.currency)}</dd></div>
                {Number(invoice.discount) > 0 ? (
                  <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd className="tabular">−{money(invoice.discount, invoice.currency)}</dd></div>
                ) : null}
                {Number(invoice.taxAmount) > 0 ? (
                  <div className="flex justify-between"><dt className="text-muted-foreground">Tax</dt><dd className="tabular">{money(invoice.taxAmount, invoice.currency)}</dd></div>
                ) : null}
                <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                  <dt>Total</dt><dd className="tabular">{money(invoice.total, invoice.currency)}</dd>
                </div>
              </dl>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
            {invoice.payments && invoice.payments.length > 0 ? (
              <Table>
                <THead>
                  <TR><TH>Date</TH><TH>Method</TH><TH>Reference</TH><TH>Recorded by</TH><TH align="right">Amount</TH></TR>
                </THead>
                <TBody>
                  {invoice.payments.map((p) => (
                    <TR key={p.id}>
                      <TD className="tabular">{date(p.paidAt)}</TD>
                      <TD>{titleCase(p.method)}</TD>
                      <TD className="tabular text-muted-foreground">{p.reference ?? '—'}</TD>
                      <TD className="text-muted-foreground">{p.recordedBy?.name ?? 'System'}</TD>
                      <TD align="right" className="tabular font-medium text-success">{money(p.amount, p.currency)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <CardContent><p className="py-6 text-center text-sm text-muted-foreground">No payments recorded yet.</p></CardContent>
            )}
          </Card>
        </div>

        {/* --- reminder timeline + email log --- */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Reminder schedule</CardTitle>
              <p className="text-sm text-muted-foreground">
                {settled ? 'Stopped — this invoice is settled.' : 'Sent automatically, no action needed.'}
              </p>
            </CardHeader>
            <CardContent>
              <ol className="relative flex flex-col gap-4 pl-6">
                <div className="absolute left-[7px] top-2 h-[calc(100%-1rem)] w-px bg-border" aria-hidden />
                {(timeline ?? []).map((entry) => {
                  const dot = {
                    sent: 'bg-success ring-success/20',
                    scheduled: 'bg-muted-foreground/40 ring-transparent',
                    missed: 'bg-warning ring-warning/20',
                    cancelled: 'bg-border ring-transparent',
                  }[entry.state];

                  return (
                    <li key={entry.type} className="relative">
                      <span className={cn('absolute -left-6 top-1 size-[9px] rounded-full ring-4', dot)} aria-hidden />
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className={cn('text-sm font-medium', entry.state === 'cancelled' && 'text-muted-foreground line-through')}>
                            {entry.offset < 0 ? `${Math.abs(entry.offset)} days before due` : entry.offset === 0 ? 'On the due date' : `${entry.offset} days overdue`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {entry.state === 'sent' ? `Sent ${dateTime(entry.sentAt)}` : date(entry.scheduledFor)}
                          </p>
                        </div>
                        {entry.state === 'sent' ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden /> : null}
                        {entry.state === 'scheduled' ? <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <Mail className="size-4 text-muted-foreground" aria-hidden />
              <CardTitle>Email history</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {invoice.emailLogs && invoice.emailLogs.length > 0 ? (
                invoice.emailLogs.map((log) => (
                  <div key={log.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{titleCase(log.type)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {log.sentAt ? dateTime(log.sentAt) : `Attempt ${log.attempts}/${log.maxAttempts}`}
                      </p>
                      {log.lastError ? <p className="mt-0.5 truncate text-xs text-destructive">{log.lastError}</p> : null}
                    </div>
                    <EmailStatusBadge status={log.status} />
                  </div>
                ))
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">No emails sent yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <FileText className="size-4 text-muted-foreground" aria-hidden />
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Issued</dt><dd className="tabular text-right">{date(invoice.issueDate)}</dd>
                <dt className="text-muted-foreground">Due</dt><dd className="tabular text-right">{date(invoice.dueDate)}</dd>
                <dt className="text-muted-foreground">Period</dt><dd className="text-right">{date(invoice.periodStart, 'd MMM')} – {date(invoice.periodEnd, 'd MMM')}</dd>
                <dt className="text-muted-foreground">Service</dt><dd className="truncate text-right">{invoice.subscription?.serviceName ?? 'One-off'}</dd>
                <dt className="text-muted-foreground">Reminders</dt><dd className="tabular text-right">{invoice.remindersSent}</dd>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* --- record payment --- */}
      <Modal
        open={payOpen}
        onOpenChange={setPayOpen}
        title="Record a payment"
        description={`${invoice.invoiceNumber} · balance ${money(balance, invoice.currency)}`}
      >
        <form
          onSubmit={paymentForm.handleSubmit((values) => recordPayment.mutate(values))}
          className="flex flex-col gap-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <Label htmlFor="amount" required>Amount received</Label>
              <Input id="amount" type="number" step="0.01" {...paymentForm.register('amount')} />
              <FieldError message={paymentForm.formState.errors.amount?.message} />
              <button
                type="button"
                onClick={() => paymentForm.setValue('amount', balance)}
                className="w-fit text-xs text-primary hover:underline"
              >
                Pay full balance ({money(balance, invoice.currency)})
              </button>
            </Field>

            <Field>
              <Label htmlFor="paidAt" required>Payment date</Label>
              <Input id="paidAt" type="date" max={new Date().toISOString().slice(0, 10)} {...paymentForm.register('paidAt')} />
              <FieldError message={paymentForm.formState.errors.paidAt?.message} />
            </Field>

            <Field>
              <Label htmlFor="method">Method</Label>
              <select id="method" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" {...paymentForm.register('method')}>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="CHEQUE">Cheque</option>
                <option value="ONLINE">Online</option>
                <option value="OTHER">Other</option>
              </select>
            </Field>

            <Field>
              <Label htmlFor="reference">Reference</Label>
              <Input id="reference" placeholder="Slip / transaction no." {...paymentForm.register('reference')} />
            </Field>
          </div>

          <Field>
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={2} placeholder="Internal only." {...paymentForm.register('notes')} />
          </Field>

          <label className="flex items-center gap-2.5 rounded-lg border border-border p-3 text-sm">
            <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" {...paymentForm.register('sendReceipt')} />
            <span>
              Email a receipt to the client
              <span className="block text-xs text-muted-foreground">Only sent when the invoice is fully settled.</span>
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button type="submit" loading={recordPayment.isPending}>Record payment</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={`Void ${invoice.invoiceNumber}?`}
        message="Voiding cancels every pending reminder and removes this invoice from receivables. The record is kept for audit. This cannot be undone."
        confirmLabel="Void invoice"
        destructive
        loading={voidInvoice.isPending}
        onConfirm={() => voidInvoice.mutate('Voided by operator')}
      />
    </div>
  );
}
