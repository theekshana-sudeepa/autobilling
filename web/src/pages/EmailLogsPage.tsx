import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Search, RotateCw, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import { dateTime, relative, titleCase } from '@/lib/format';
import type { EmailLog } from '@/types/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/PageHeader';
import { EmailStatusBadge } from '@/components/common/StatusBadge';
import { Table, TBody, TD, TH, THead, TR, Pagination } from '@/components/common/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/utils';

const STATUSES = ['', 'SENT', 'QUEUED', 'FAILED', 'CANCELLED'] as const;

export default function EmailLogsPage() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.emailLogs({ page, status, search }),
    queryFn: () => api.list<EmailLog[]>('/email-logs', { page, pageSize: 25, status: status || undefined, search: search || undefined }),
    placeholderData: (prev) => prev,
    // Delivery status changes without user action — poll while the tab is open.
    refetchInterval: 60_000,
  });

  const resend = useMutation({
    mutationFn: (id: string) => api.post<{ status: string }>(`/email-logs/${id}/resend`),
    onSuccess: (r) => {
      if (r.status === 'sent') toast.success('Email resent');
      else toast.error('Resend failed', { description: 'Queued for automatic retry.' });
      void qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (e) => toast.error('Could not resend', { description: (e as Error).message }),
  });

  const requeue = useMutation({
    mutationFn: (id: string) => api.post(`/email-logs/${id}/requeue`),
    onSuccess: () => {
      toast.success('Back in the retry queue');
      void qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
  });

  const logs = data?.data ?? [];
  const meta = data?.meta;
  const counts = (meta?.statusCounts as Array<{ status: string; _count: number }> | undefined) ?? [];
  const failedCount = counts.find((c) => c.status === 'FAILED')?._count ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Email logs"
        description="Every invoice, reminder and receipt the system has sent — with delivery status and retry history."
        actions={<Button variant="outline" onClick={() => void refetch()}><RotateCw aria-hidden /> Refresh</Button>}
      />

      {failedCount > 0 ? (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-medium text-destructive">{failedCount} email{failedCount === 1 ? '' : 's'} failed permanently</p>
            <p className="text-muted-foreground">
              These exhausted every retry. Check the address is valid, then requeue them.
            </p>
          </div>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setStatus('FAILED')}>Show failed</Button>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Recipient, subject or invoice…" className="pl-9" aria-label="Search email logs" />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by delivery status">
            {STATUSES.map((s) => (
              <button
                key={s || 'all'}
                onClick={() => { setStatus(s); setPage(1); }}
                aria-pressed={status === s}
                className={cn(
                  'h-9 rounded-lg border px-3 text-xs font-medium transition-colors',
                  status === s ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary',
                )}
              >
                {s ? titleCase(s) : 'All'}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : logs.length === 0 ? (
          <EmptyState icon={Mail} title="No emails yet" description="Invoices and reminders will appear here the moment the automation sends them." />
        ) : (
          <>
            <Table>
              <THead>
                <TR><TH>Type</TH><TH>Recipient</TH><TH>Invoice</TH><TH align="center">Status</TH><TH>When</TH><TH /></TR>
              </THead>
              <TBody>
                {logs.map((log) => (
                  <TR key={log.id}>
                    <TD>
                      <p className="text-sm font-medium">{titleCase(log.type)}</p>
                      <p className="max-w-[24ch] truncate text-xs text-muted-foreground sm:max-w-[40ch]">{log.subject}</p>
                    </TD>
                    <TD>
                      <p className="text-sm">{log.toEmail}</p>
                      {log.client ? <p className="text-xs text-muted-foreground">{log.client.companyName}</p> : null}
                    </TD>
                    <TD>
                      {log.invoice ? (
                        <Link to={`/invoices/${log.invoice.id}`} className="tabular text-sm hover:text-primary">{log.invoice.invoiceNumber}</Link>
                      ) : '—'}
                    </TD>
                    <TD align="center">
                      <EmailStatusBadge status={log.status} />
                      {log.attempts > 1 ? <p className="mt-0.5 text-xs text-muted-foreground">{log.attempts} attempts</p> : null}
                    </TD>
                    <TD>
                      <p className="text-sm">{log.sentAt ? dateTime(log.sentAt) : relative(log.createdAt)}</p>
                      {log.lastError ? <p className="max-w-[30ch] truncate text-xs text-destructive" title={log.lastError}>{log.lastError}</p> : null}
                    </TD>
                    <TD align="right">
                      <div className="flex justify-end gap-1">
                        {log.invoiceId ? (
                          <Button variant="ghost" size="sm" loading={resend.isPending} onClick={() => resend.mutate(log.id)}>Resend</Button>
                        ) : null}
                        {isAdmin && log.status === 'FAILED' ? (
                          <Button variant="ghost" size="sm" onClick={() => requeue.mutate(log.id)}>Requeue</Button>
                        ) : null}
                      </div>
                    </TD>
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
