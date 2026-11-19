import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Mail, Phone, MapPin, MessageCircle, Repeat, FileText } from 'lucide-react';
import { useClient } from '@/features/clients/useClients';
import { money, date } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/common/DataTable';
import { ErrorState } from '@/components/common/states';
import type { Invoice, Subscription } from '@/types/api';

export default function ClientDetailPage() {
  const { id = '' } = useParams();
  const { data: client, isLoading, error, refetch } = useClient(id);

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading || !client) {
    return (
      <div className="flex flex-col gap-5">
        <div className="skeleton h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-xl" />)}</div>
        <div className="skeleton h-80 rounded-xl" />
      </div>
    );
  }

  const subscriptions = (client.subscriptions ?? []) as Subscription[];
  const invoices = (client.invoices ?? []) as Invoice[];
  const currency = subscriptions[0]?.currency ?? invoices[0]?.currency ?? 'LKR';

  return (
    <div className="flex flex-col gap-5 animate-[fade-in_.2s_ease-out]">
      <Link to="/clients" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All clients
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{client.companyName}</h1>
            <Badge variant={client.status === 'ACTIVE' ? 'success' : 'muted'}>{client.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>
          </div>
          <p className="tabular mt-1 text-sm text-muted-foreground">{client.code} · client since {date(client.createdAt, 'MMMM yyyy')}</p>
        </div>
        <Button asChild><Link to={`/subscriptions?clientId=${client.id}`}><Repeat aria-hidden /> Add subscription</Link></Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outstanding</p>
          <p className="tabular mt-1.5 text-xl font-semibold text-warning">{money(client.stats.outstanding, currency)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Lifetime value</p>
          <p className="tabular mt-1.5 text-xl font-semibold">{money(client.stats.lifetimeValue, currency)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active subscriptions</p>
          <p className="tabular mt-1.5 text-xl font-semibold">{subscriptions.filter((s) => s.status === 'ACTIVE').length}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {client.contactPerson ? <p className="font-medium">{client.contactPerson}</p> : null}
            <a href={`mailto:${client.email}`} className="flex items-center gap-2 text-muted-foreground hover:text-primary">
              <Mail className="size-4 shrink-0" aria-hidden /> <span className="truncate">{client.email}</span>
            </a>
            {client.billingEmail ? (
              <a href={`mailto:${client.billingEmail}`} className="flex items-center gap-2 text-muted-foreground hover:text-primary">
                <Mail className="size-4 shrink-0" aria-hidden /> <span className="truncate">{client.billingEmail} (billing)</span>
              </a>
            ) : null}
            {client.phone ? (
              <a href={`tel:${client.phone}`} className="flex items-center gap-2 text-muted-foreground hover:text-primary">
                <Phone className="size-4 shrink-0" aria-hidden /> {client.phone}
              </a>
            ) : null}
            {client.whatsapp ? (
              <a
                href={`https://wa.me/${client.whatsapp.replace(/\D/g, '')}`}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-2 text-muted-foreground hover:text-primary"
              >
                <MessageCircle className="size-4 shrink-0" aria-hidden /> {client.whatsapp}
              </a>
            ) : null}
            {client.addressLine1 ? (
              <p className="flex items-start gap-2 text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{[client.addressLine1, client.addressLine2, client.city, client.country].filter(Boolean).join(', ')}</span>
              </p>
            ) : null}
            {client.notes ? (
              <div className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Internal notes</p>
                <p className="whitespace-pre-line">{client.notes}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center gap-2"><Repeat className="size-4 text-muted-foreground" aria-hidden /><CardTitle>Subscriptions</CardTitle></CardHeader>
            {subscriptions.length === 0 ? (
              <CardContent><p className="py-6 text-center text-sm text-muted-foreground">No subscriptions — this client will not be billed automatically.</p></CardContent>
            ) : (
              <Table>
                <THead><TR><TH>Service</TH><TH align="right">Amount</TH><TH align="center">Due day</TH><TH align="center">Status</TH></TR></THead>
                <TBody>
                  {subscriptions.map((s) => (
                    <TR key={s.id}>
                      <TD className="font-medium">{s.serviceName}</TD>
                      <TD align="right" className="tabular">{money(s.amount, s.currency)}</TD>
                      <TD align="center" className="tabular">{s.dueDay}</TD>
                      <TD align="center">
                        <Badge variant={s.status === 'ACTIVE' ? 'success' : s.status === 'PAUSED' ? 'warning' : 'muted'}>{s.status}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center gap-2"><FileText className="size-4 text-muted-foreground" aria-hidden /><CardTitle>Recent invoices</CardTitle></CardHeader>
            {invoices.length === 0 ? (
              <CardContent><p className="py-6 text-center text-sm text-muted-foreground">No invoices yet.</p></CardContent>
            ) : (
              <Table>
                <THead><TR><TH>Invoice</TH><TH>Period</TH><TH>Due</TH><TH align="right">Total</TH><TH align="center">Status</TH></TR></THead>
                <TBody>
                  {invoices.map((inv) => (
                    <TR key={inv.id}>
                      <TD><Link to={`/invoices/${inv.id}`} className="tabular font-medium hover:text-primary">{inv.invoiceNumber}</Link></TD>
                      <TD className="text-sm text-muted-foreground">{date(inv.periodStart, 'MMM yyyy')}</TD>
                      <TD className="tabular text-sm">{date(inv.dueDate, 'd MMM')}</TD>
                      <TD align="right" className="tabular font-medium">{money(inv.total, inv.currency)}</TD>
                      <TD align="center"><StatusBadge status={inv.status} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
