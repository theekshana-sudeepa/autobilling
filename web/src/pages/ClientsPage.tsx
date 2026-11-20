import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Search, Users, MoreHorizontal, Trash2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/PageHeader';
import { Modal, ConfirmDialog } from '@/components/common/Modal';
import { Table, TBody, TD, TH, THead, TR, Pagination } from '@/components/common/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states';
import { ClientForm } from '@/features/clients/ClientForm';
import { useClients, useCreateClient, useDeleteClient, useUpdateClient } from '@/features/clients/useClients';
import { useAuth } from '@/features/auth/AuthProvider';
import { money, date } from '@/lib/format';
import type { Client } from '@/types/api';

/** Debounce so typing does not fire a request per keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function ClientsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAdmin } = useAuth();

  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [status, setStatus] = useState<'ACTIVE' | 'INACTIVE' | ''>('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Client | null>(null);
  const [formOpen, setFormOpen] = useState(searchParams.get('new') === '1');
  const [deleting, setDeleting] = useState<Client | null>(null);

  const debouncedSearch = useDebounced(search);

  const { data, isLoading, isFetching, error, refetch } = useClients({
    page,
    pageSize: 20,
    search: debouncedSearch || undefined,
    status: status || undefined,
    sortBy: 'companyName',
    sortDir: 'asc',
  });

  const createClient = useCreateClient();
  const updateClient = useUpdateClient(editing?.id ?? '');
  const deleteClient = useDeleteClient();

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    if (searchParams.has('new')) {
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const clients = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Clients"
        description="Every business you bill. Adding a client here is step one — the subscription does the rest."
        actions={
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus aria-hidden /> Add client
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by company, contact, email or code…"
              className="pl-9"
              aria-label="Search clients"
            />
          </div>
          <div className="flex items-center gap-2">
            {(['', 'ACTIVE', 'INACTIVE'] as const).map((s) => (
              <button
                key={s || 'all'}
                onClick={() => { setStatus(s); setPage(1); }}
                aria-pressed={status === s}
                className={`h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                  status === s ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary'
                }`}
              >
                {s === '' ? 'All' : s === 'ACTIVE' ? 'Active' : 'Inactive'}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : clients.length === 0 ? (
          <EmptyState
            icon={Users}
            title={debouncedSearch ? 'No clients match that search' : 'No clients yet'}
            description={
              debouncedSearch
                ? 'Try a different company name, email or client code.'
                : 'Add your first POS client and attach a monthly subscription — invoices then generate on their own.'
            }
            action={
              debouncedSearch ? (
                <Button variant="outline" onClick={() => { setSearch(''); setPage(1); }}>Clear search</Button>
              ) : (
                <Button onClick={() => setFormOpen(true)}><Plus aria-hidden /> Add your first client</Button>
              )
            }
          />
        ) : (
          <>
            <div aria-busy={isFetching} className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
              <Table>
                <THead>
                  <TR>
                    <TH>Client</TH>
                    <TH>Contact</TH>
                    <TH align="center">Subscriptions</TH>
                    <TH align="right">MRR</TH>
                    <TH align="center">Status</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {clients.map((client) => (
                    <TR key={client.id}>
                      <TD>
                        <Link to={`/clients/${client.id}`} className="group block">
                          <p className="font-medium group-hover:text-primary">{client.companyName}</p>
                          <p className="tabular text-xs text-muted-foreground">{client.code} · joined {date(client.createdAt, 'MMM yyyy')}</p>
                        </Link>
                      </TD>
                      <TD>
                        <p className="text-sm">{client.contactPerson ?? '—'}</p>
                        <a href={`mailto:${client.email}`} className="text-xs text-muted-foreground hover:text-primary">{client.email}</a>
                      </TD>
                      <TD align="center">
                        <Badge variant={client.activeSubscriptions ? 'default' : 'muted'}>{client.activeSubscriptions ?? 0}</Badge>
                      </TD>
                      <TD align="right" className="tabular font-medium">
                        {client.mrr ? money(client.mrr, client.currency ?? 'LKR') : '—'}
                      </TD>
                      <TD align="center">
                        <Badge variant={client.status === 'ACTIVE' ? 'success' : 'muted'}>
                          {client.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                        </Badge>
                      </TD>
                      <TD align="right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => { setEditing(client); setFormOpen(true); }} aria-label={`Edit ${client.companyName}`}>
                            <Pencil aria-hidden />
                          </Button>
                          {isAdmin ? (
                            <Button variant="ghost" size="icon" onClick={() => setDeleting(client)} aria-label={`Delete ${client.companyName}`}>
                              <Trash2 aria-hidden />
                            </Button>
                          ) : (
                            <Button variant="ghost" size="icon" asChild aria-label={`Open ${client.companyName}`}>
                              <Link to={`/clients/${client.id}`}><MoreHorizontal aria-hidden /></Link>
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>

            {meta ? (
              <Pagination
                page={meta.page}
                totalPages={meta.totalPages}
                total={meta.total}
                pageSize={meta.pageSize}
                onPageChange={setPage}
              />
            ) : null}
          </>
        )}
      </Card>

      <Modal
        open={formOpen}
        onOpenChange={(open) => (open ? setFormOpen(true) : closeForm())}
        title={editing ? `Edit ${editing.companyName}` : 'Add a client'}
        description={editing ? 'Changes apply to future invoices only.' : 'You can attach subscriptions once the client exists.'}
        size="lg"
      >
        <ClientForm
          client={editing}
          submitting={createClient.isPending || updateClient.isPending}
          error={editing ? updateClient.error : createClient.error}
          onCancel={closeForm}
          onSubmit={(values) => {
            const mutation = editing ? updateClient : createClient;
            mutation.mutate(values, { onSuccess: closeForm });
          }}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.companyName}?`}
        message="This archives the client and cancels their subscriptions. Invoices and payments are kept for your records. Clients with unpaid invoices cannot be deleted."
        confirmLabel="Delete client"
        destructive
        loading={deleteClient.isPending}
        onConfirm={() => {
          if (!deleting) return;
          deleteClient.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
        }}
      />
    </div>
  );
}
