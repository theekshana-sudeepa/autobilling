import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, Repeat, Pause, Play, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import { money, date } from '@/lib/format';
import type { Client, Subscription } from '@/types/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Input, Label, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/common/PageHeader';
import { Modal } from '@/components/common/Modal';
import { Table, TBody, TD, TH, THead, TR, Pagination } from '@/components/common/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states';

const schema = z.object({
  clientId: z.string().min(1, 'Choose a client'),
  serviceName: z.string().trim().min(2, 'Service name is required').max(180),
  description: z.string().trim().max(2000).optional(),
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  currency: z.string().length(3).default('LKR'),
  billingCycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).default('MONTHLY'),
  dueDay: z.coerce.number().int().min(1, 'Pick a day between 1 and 28').max(28, 'Pick a day between 1 and 28'),
  startDate: z.string().min(1, 'Start date is required'),
  autoSend: z.boolean().default(true),
});
type FormValues = z.infer<typeof schema>;

const CYCLE_LABEL = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', YEARLY: 'Yearly' } as const;

export default function SubscriptionsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'PAUSED' | 'CANCELLED' | ''>('ACTIVE');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.subscriptions({ page, statusFilter }),
    queryFn: () => api.list<Subscription[]>('/subscriptions', { page, pageSize: 20, status: statusFilter || undefined }),
    placeholderData: (prev) => prev,
  });

  // Only loaded when the form opens — the picker needs every active client.
  const { data: clientsData } = useQuery({
    queryKey: qk.clients({ all: true }),
    queryFn: () => api.list<Client[]>('/clients', { pageSize: 100, status: 'ACTIVE', sortBy: 'companyName', sortDir: 'asc' }),
    enabled: open,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      clientId: '',
      serviceName: '',
      description: '',
      amount: 0,
      taxRate: 0,
      currency: 'LKR',
      billingCycle: 'MONTHLY',
      dueDay: 5,
      startDate: new Date().toISOString().slice(0, 10),
      autoSend: true,
    },
  });

  const create = useMutation({
    mutationFn: (values: FormValues) => api.post<Subscription>('/subscriptions', values),
    onSuccess: (sub) => {
      toast.success('Subscription created', {
        description: `${sub.serviceName} · billed on day ${sub.dueDay} of each month. First invoice generates automatically.`,
      });
      setOpen(false);
      form.reset();
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (e) => toast.error('Could not create subscription', { description: (e as Error).message }),
  });

  const togglePause = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api.post(`/subscriptions/${id}/pause`, { paused }),
    onSuccess: (_r, vars) => {
      toast.success(vars.paused ? 'Subscription paused' : 'Subscription resumed', {
        description: vars.paused ? 'No further invoices will be generated.' : 'Billing resumes from the next period.',
      });
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
    },
  });

  const subs = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Subscriptions"
        description="The recurring services you bill for. Set the price and due day once — the system invoices forever."
        actions={<Button onClick={() => setOpen(true)}><Plus aria-hidden /> New subscription</Button>}
      />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border p-4" role="group" aria-label="Filter by status">
          {([['ACTIVE', 'Active'], ['PAUSED', 'Paused'], ['CANCELLED', 'Cancelled'], ['', 'All']] as const).map(([value, label]) => (
            <button
              key={label}
              onClick={() => { setStatusFilter(value); setPage(1); }}
              aria-pressed={statusFilter === value}
              className={`h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                statusFilter === value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : subs.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="No subscriptions here"
            description="A subscription links a client to a recurring price and a due day. That is the entire setup — invoicing, PDFs and reminders follow automatically."
            action={<Button onClick={() => setOpen(true)}><Plus aria-hidden /> Create a subscription</Button>}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Service</TH>
                  <TH>Client</TH>
                  <TH align="right">Amount</TH>
                  <TH align="center">Cycle</TH>
                  <TH align="center">Due day</TH>
                  <TH align="center">Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {subs.map((sub) => (
                  <TR key={sub.id}>
                    <TD>
                      <p className="font-medium">{sub.serviceName}</p>
                      {sub.lastInvoicedAt ? (
                        <p className="text-xs text-muted-foreground">Last billed {date(sub.lastInvoicedAt, 'MMM yyyy')}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Not billed yet</p>
                      )}
                    </TD>
                    <TD>
                      <Link to={`/clients/${sub.clientId}`} className="text-sm hover:text-primary">{sub.client?.companyName}</Link>
                      <p className="tabular text-xs text-muted-foreground">{sub.client?.code}</p>
                    </TD>
                    <TD align="right" className="tabular font-medium">{money(sub.amount, sub.currency)}</TD>
                    <TD align="center"><Badge variant="secondary">{CYCLE_LABEL[sub.billingCycle]}</Badge></TD>
                    <TD align="center" className="tabular">{sub.dueDay}</TD>
                    <TD align="center">
                      <Badge variant={sub.status === 'ACTIVE' ? 'success' : sub.status === 'PAUSED' ? 'warning' : 'muted'}>
                        {sub.status === 'ACTIVE' ? 'Active' : sub.status === 'PAUSED' ? 'Paused' : 'Cancelled'}
                      </Badge>
                    </TD>
                    <TD align="right">
                      {sub.status !== 'CANCELLED' ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => togglePause.mutate({ id: sub.id, paused: sub.status === 'ACTIVE' })}
                          aria-label={sub.status === 'ACTIVE' ? `Pause ${sub.serviceName}` : `Resume ${sub.serviceName}`}
                        >
                          {sub.status === 'ACTIVE' ? <Pause aria-hidden /> : <Play aria-hidden />}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {meta ? <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} pageSize={meta.pageSize} onPageChange={setPage} /> : null}
          </>
        )}
      </Card>

      <Modal open={open} onOpenChange={setOpen} title="New subscription" description="This is the only setup required for recurring billing." size="lg">
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="flex flex-col gap-4" noValidate>
          <Field>
            <Label htmlFor="clientId" required>Client</Label>
            <select id="clientId" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" {...form.register('clientId')}>
              <option value="">Select a client…</option>
              {(clientsData?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.companyName} ({c.code})</option>
              ))}
            </select>
            <FieldError message={form.formState.errors.clientId?.message} />
          </Field>

          <Field>
            <Label htmlFor="serviceName" required>Service name</Label>
            <Input id="serviceName" placeholder="POS Pro + Priority Support" {...form.register('serviceName')} />
            <FieldError message={form.formState.errors.serviceName?.message} />
          </Field>

          <Field>
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={2} placeholder="Appears on the invoice line item." {...form.register('description')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <Label htmlFor="amount" required>Amount</Label>
              <Input id="amount" type="number" step="0.01" {...form.register('amount')} />
              <FieldError message={form.formState.errors.amount?.message} />
            </Field>
            <Field>
              <Label htmlFor="currency">Currency</Label>
              <select id="currency" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" {...form.register('currency')}>
                {['LKR', 'USD', 'EUR', 'GBP', 'AUD', 'INR'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field>
              <Label htmlFor="taxRate">Tax %</Label>
              <Input id="taxRate" type="number" step="0.01" {...form.register('taxRate')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <Label htmlFor="billingCycle">Billing cycle</Label>
              <select id="billingCycle" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" {...form.register('billingCycle')}>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="YEARLY">Yearly</option>
              </select>
            </Field>
            <Field>
              <Label htmlFor="dueDay" required>Due day</Label>
              <Input id="dueDay" type="number" min={1} max={28} {...form.register('dueDay')} />
              <p className="text-xs text-muted-foreground">1–28 so the date exists in every month.</p>
              <FieldError message={form.formState.errors.dueDay?.message} />
            </Field>
            <Field>
              <Label htmlFor="startDate" required>Start date</Label>
              <Input id="startDate" type="date" {...form.register('startDate')} />
              <FieldError message={form.formState.errors.startDate?.message} />
            </Field>
          </div>

          <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-[hsl(var(--primary))]" {...form.register('autoSend')} />
            <span>
              Email each invoice automatically
              <span className="block text-xs text-muted-foreground">
                Turn this off to review invoices before they go out. Reminders still follow the schedule once sent.
              </span>
            </span>
          </label>

          <div className="flex items-start gap-2.5 rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">
            <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              The first invoice is generated a few days before the due day (configurable in Settings) and reminders go out at
              −7, −3, 0, +3 and +7 days. Marking the invoice paid stops them immediately.
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create subscription</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
