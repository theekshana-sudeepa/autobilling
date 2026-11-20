import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Search, PlayCircle, Download, Eye } from 'lucide-react';
import { api, openInvoicePdf } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import { money, date, dueLabel } from '@/lib/format';
import type { Invoice, InvoiceStatus } from '@/types/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/PageHeader';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Table, TBody, TD, TH, THead, TR, Pagination } from '@/components/common/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states';
import { ConfirmDialog } from '@/components/common/Modal';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/utils';

const FILTERS: Array<{ label: string; value: InvoiceStatus | 'ALL' | 'OVERDUE_ONLY' }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Unpaid', value: 'SENT' },
  { label: 'Overdue', value: 'OVERDUE' },
  { label: 'Paid', value: 'PAID' },
  { label: 'Draft', value: 'DRAFT' },
];

export default function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const [debounced, setDebounced] = useState(search);
  const [filter, setFilter] = useState<string>(params.get('overdueOnly') === 'true' ? 'OVERDUE' : 'ALL');
  const [page, setPage] = useState(1);
  const [runOpen, setRunOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: qk.invoices({ page, search: debounced, filter }),
    queryFn: () =>
      api.list<Invoice[]>('/invoices', {
        page,
        pageSize: 20,
        search: debounced || undefined,
        status: filter === 'ALL' ? undefined : filter,
        sortBy: 'issueDate',
        sortDir: 'desc',
      }),
    placeholderData: (prev) => prev,
  });

  const runBilling = useMutation({
    mutationFn: () => api.post<{ processed: number; skipped: number; failed: number }>('/invoices/generate', { dryRun: false }),
    onSuccess: (result) => {
      toast.success(`Billing run complete`, {
        description: `${result.processed} invoice(s) generated, ${result.skipped} already existed, ${result.failed} failed.`,
      });
      setRunOpen(false);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (e) => toast.error('Billing run failed', { description: (e as Error).message }),
  });

  const invoices = data?.data ?? [];
  const meta = data?.meta;
  const summary = meta?.summary as { totalAmount: number; paidAmount: number; outstanding: number } | undefined;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invoices"
        description="Generated automatically from subscriptions. Everything here is emailed and chased without you lifting a finger."
        actions={
          isAdmin ? (
            <Button variant="outline" onClick={() => setRunOpen(true)}>
              <PlayCircle aria-hidden /> Run billing now
            </Button>
          ) : null
        }
      />

      {summary ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: 'Total billed', value: summary.totalAmount, tone: '' },
            { label: 'Collected', value: summary.paidAmount, tone: 'text-success' },
            { label: 'Outstanding', value: summary.outstanding, tone: 'text-warning' },
          ].map((s) => (
            <Card key={s.label} className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</p>
              <p className={cn('tabular mt-1.5 text-xl font-semibold', s.tone)}>{money(s.value, invoices[0]?.currency ?? 'LKR')}</p>
            </Card>
          ))}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); params.set('search', e.target.value); setParams(params, { replace: true }); }}
              placeholder="Search invoice number or client…"
              className="pl-9"
              aria-label="Search invoices"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => { setFilter(f.value); setPage(1); }}
                aria-pressed={filter === f.value}
                className={cn(
                  'h-9 rounded-lg border px-3 text-xs font-medium transition-colors',
                  filter === f.value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={debounced || filter !== 'ALL' ? 'No invoices match' : 'No invoices yet'}
            description={
              debounced || filter !== 'ALL'
                ? 'Adjust your search or filter to see more.'
                : 'Invoices appear here once a subscription reaches its generation date. You can also trigger a billing run manually.'
            }
            action={isAdmin && !debounced ? <Button onClick={() => setRunOpen(true)}><PlayCircle aria-hidden /> Run billing now</Button> : undefined}
          />
        ) : (
          <>
            <div aria-busy={isFetching} className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
              <Table>
                <THead>
                  <TR>
                    <TH>Invoice</TH>
                    <TH>Client</TH>
                    <TH>Period</TH>
                    <TH>Due</TH>
                    <TH align="right">Amount</TH>
                    <TH align="center">Status</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {invoices.map((inv) => {
                    const due = dueLabel(inv.dueDate, inv.status);
                    return (
                      <TR key={inv.id}>
                        <TD>
                          <Link to={`/invoices/${inv.id}`} className="tabular font-medium hover:text-primary">{inv.invoiceNumber}</Link>
                          <p className="text-xs text-muted-foreground">{date(inv.issueDate, 'd MMM yyyy')}</p>
                        </TD>
                        <TD>
                          <Link to={`/clients/${inv.clientId}`} className="text-sm hover:text-primary">{inv.client?.companyName}</Link>
                          <p className="text-xs text-muted-foreground">{inv.subscription?.serviceName ?? 'One-off'}</p>
                        </TD>
                        <TD className="text-sm text-muted-foreground">{date(inv.periodStart, 'MMM yyyy')}</TD>
                        <TD>
                          <p className="tabular text-sm">{date(inv.dueDate, 'd MMM')}</p>
                          <p className={cn(
                            'text-xs',
                            due.tone === 'danger' ? 'font-medium text-destructive' : due.tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
                          )}>
                            {due.text}
                          </p>
                        </TD>
                        <TD align="right">
                          <p className="tabular font-medium">{money(inv.total, inv.currency)}</p>
                          {Number(inv.amountPaid) > 0 && inv.status !== 'PAID' ? (
                            <p className="tabular text-xs text-success">{money(inv.amountPaid, inv.currency)} paid</p>
                          ) : null}
                        </TD>
                        <TD align="center"><StatusBadge status={inv.status} /></TD>
                        <TD align="right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" asChild aria-label={`Open ${inv.invoiceNumber}`}>
                              <Link to={`/invoices/${inv.id}`}><Eye aria-hidden /></Link>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void openInvoicePdf(inv.id, inv.invoiceNumber, true)}
                              aria-label={`Download ${inv.invoiceNumber}`}
                            >
                              <Download aria-hidden />
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>

            {meta ? (
              <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} pageSize={meta.pageSize} onPageChange={setPage} />
            ) : null}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        title="Run the billing job now?"
        message="This generates any invoices that are due today and emails them to clients with auto-send enabled. It is safe to run more than once — invoices that already exist are skipped, never duplicated."
        confirmLabel="Run billing"
        loading={runBilling.isPending}
        onConfirm={() => runBilling.mutate()}
      />
    </div>
  );
}
