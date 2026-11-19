import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import { money, date, titleCase } from '@/lib/format';
import type { Payment } from '@/types/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/PageHeader';
import { Table, TBody, TD, TH, THead, TR, Pagination } from '@/components/common/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states';

const METHODS = ['', 'BANK_TRANSFER', 'CASH', 'CARD', 'CHEQUE', 'ONLINE', 'OTHER'] as const;

export default function PaymentsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.payments({ page, search, method, from, to }),
    queryFn: () =>
      api.list<Payment[]>('/payments', {
        page,
        pageSize: 25,
        search: search || undefined,
        method: method || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    placeholderData: (prev) => prev,
  });

  const payments = data?.data ?? [];
  const meta = data?.meta;
  const collected = (meta?.totalCollected as number | undefined) ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Payments"
        description="Every payment recorded against an invoice. Recording one here stops that invoice's reminders immediately."
      />

      <Card className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total collected (matching filters)</p>
        <p className="tabular mt-1.5 text-2xl font-semibold text-success">{money(collected, payments[0]?.currency ?? 'LKR')}</p>
      </Card>

      <Card className="overflow-hidden">
        <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Reference, invoice or client…" className="pl-9" aria-label="Search payments" />
          </div>
          <select
            value={method}
            onChange={(e) => { setMethod(e.target.value); setPage(1); }}
            aria-label="Filter by method"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
          >
            {METHODS.map((m) => <option key={m || 'all'} value={m}>{m ? titleCase(m) : 'All methods'}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="From date" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="To date" />
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : payments.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="No payments found"
            description="Payments appear here as soon as you mark an invoice paid from its detail page."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR><TH>Date</TH><TH>Client</TH><TH>Invoice</TH><TH>Method</TH><TH>Reference</TH><TH align="right">Amount</TH></TR>
              </THead>
              <TBody>
                {payments.map((p) => (
                  <TR key={p.id}>
                    <TD className="tabular">{date(p.paidAt)}</TD>
                    <TD>
                      {p.invoice?.client ? (
                        <Link to={`/clients/${p.invoice.client.id}`} className="hover:text-primary">{p.invoice.client.companyName}</Link>
                      ) : '—'}
                    </TD>
                    <TD>
                      {p.invoice ? (
                        <Link to={`/invoices/${p.invoice.id}`} className="tabular text-sm hover:text-primary">{p.invoice.invoiceNumber}</Link>
                      ) : '—'}
                    </TD>
                    <TD><Badge variant="secondary">{titleCase(p.method)}</Badge></TD>
                    <TD className="tabular text-sm text-muted-foreground">{p.reference ?? '—'}</TD>
                    <TD align="right" className="tabular font-medium text-success">{money(p.amount, p.currency)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {meta ? <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} pageSize={meta.pageSize} onPageChange={setPage} /> : null}
          </>
        )}
      </Card>
    </div>
  );
}
