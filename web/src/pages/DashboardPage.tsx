import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDownRight, ArrowUpRight, Users, Repeat, AlertTriangle, Wallet, CalendarClock, Activity } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import { money, date, percent, relative, titleCase } from '@/lib/format';
import type { DashboardPayload } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/PageHeader';
import { CardSkeleton, ErrorState } from '@/components/common/states';
import { cn } from '@/lib/utils';

function Metric({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  changePct,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Users;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  changePct?: number;
}) {
  const toneClass = {
    default: 'bg-primary/10 text-primary',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-destructive/12 text-destructive',
  }[tone];

  const up = (changePct ?? 0) >= 0;

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div className={cn('grid size-8 shrink-0 place-items-center rounded-lg', toneClass)}>
            <Icon className="size-4" aria-hidden />
          </div>
        </div>
        <p className="tabular mt-3 text-metric font-semibold">{value}</p>
        <div className="mt-1.5 flex items-center gap-2">
          {changePct !== undefined ? (
            <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', up ? 'text-success' : 'text-destructive')}>
              {up ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
              {percent(Math.abs(changePct))}
            </span>
          ) : null}
          {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Recharts renders in SVG, so colours must be real values, not CSS classes. */
function useChartColors() {
  const read = (name: string) =>
    `hsl(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`;
  return {
    billed: read('--chart-1'),
    collected: read('--chart-2'),
    outstanding: read('--chart-3'),
    grid: read('--border'),
    text: read('--muted-foreground'),
    surface: read('--popover'),
  };
}

function ChartTooltip({ active, payload, label, currency }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover p-3 shadow-lg">
      <p className="mb-1.5 text-xs font-semibold">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: entry.color }} aria-hidden />
          {titleCase(entry.dataKey)}
          <span className="tabular ml-auto font-medium text-foreground">{money(entry.value, currency)}</span>
        </p>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.dashboard,
    queryFn: () => api.get<DashboardPayload>('/dashboard'),
  });

  const colors = useChartColors();

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Dashboard" description="Loading your billing overview…" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
        <div className="skeleton h-80 rounded-xl" />
      </div>
    );
  }

  const { overview, revenue, topClients, ageing, activity, upcoming } = data;
  const cur = overview.mrr.currency;

  return (
    <div className="flex flex-col gap-6 animate-[fade-in_.2s_ease-out]">
      <PageHeader
        title="Dashboard"
        description={`${overview.clients.active} active clients · ${overview.invoices.thisMonth} invoices issued this month`}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/invoices?overdueOnly=true">
                <AlertTriangle aria-hidden /> {overview.invoices.overdue} overdue
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/clients?new=1">Add client</Link>
            </Button>
          </>
        }
      />

      {/* --- KPI row --- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Monthly recurring revenue"
          value={money(overview.mrr.current, cur)}
          changePct={overview.mrr.changePct}
          sub="vs last month"
          icon={Repeat}
        />
        <Metric
          label="Collected this month"
          value={money(overview.money.collectedThisMonth, cur)}
          sub={`${percent(overview.money.collectionRatePct, 0)} collection rate`}
          icon={Wallet}
          tone="success"
        />
        <Metric
          label="Outstanding"
          value={money(overview.money.outstanding, cur)}
          sub={`${overview.invoices.unpaid + overview.invoices.overdue} open invoices`}
          icon={CalendarClock}
          tone="warning"
        />
        <Metric
          label="Overdue"
          value={money(overview.money.overdueAmount, cur)}
          sub={`${overview.invoices.overdue} invoices past due`}
          icon={AlertTriangle}
          tone={overview.invoices.overdue > 0 ? 'danger' : 'default'}
        />
      </div>

      {/* --- revenue + ageing --- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Revenue</CardTitle>
              <p className="text-sm text-muted-foreground">Billed vs collected, last 12 months</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: colors.billed }} />Billed</span>
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: colors.collected }} />Collected</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={revenue} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="gBilled" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={colors.billed} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={colors.billed} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gCollected" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={colors.collected} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={colors.collected} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: colors.text }} tickLine={false} axisLine={false} tickFormatter={(m: string) => m.slice(5)} />
                  <YAxis tick={{ fontSize: 11, fill: colors.text }} tickLine={false} axisLine={false} tickFormatter={(v: number) => money(v, cur, true)} width={64} />
                  <Tooltip content={<ChartTooltip currency={cur} />} />
                  <Area type="monotone" dataKey="billed" stroke={colors.billed} strokeWidth={2} fill="url(#gBilled)" />
                  <Area type="monotone" dataKey="collected" stroke={colors.collected} strokeWidth={2} fill="url(#gCollected)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Receivables ageing</CardTitle>
            <p className="text-sm text-muted-foreground">Outstanding by days past due</p>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ageing} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: colors.text }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: colors.text }} tickLine={false} axisLine={false} tickFormatter={(v: number) => money(v, cur, true)} width={64} />
                  <Tooltip content={<ChartTooltip currency={cur} />} cursor={{ fill: colors.grid, opacity: 0.3 }} />
                  <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                    {ageing.map((b) => (
                      <Cell key={b.bucket} fill={b.bucket === 'current' ? colors.collected : b.bucket === '90+' ? 'hsl(0 84% 60%)' : colors.outstanding} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* --- lists --- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Due in the next 30 days</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {upcoming.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing due in the next 30 days.</p>
            ) : (
              upcoming.map((inv) => (
                <Link
                  key={inv.id}
                  to={`/invoices/${inv.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-secondary"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{inv.client.companyName}</p>
                    <p className="text-xs text-muted-foreground">{inv.invoiceNumber} · due {date(inv.dueDate, 'd MMM')}</p>
                  </div>
                  <span className="tabular shrink-0 text-sm font-semibold">
                    {money(Number(inv.total) - Number(inv.amountPaid), inv.currency)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top clients by revenue</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {topClients.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No billing history yet.</p>
            ) : (
              topClients.map((c, i) => (
                <Link key={c.id} to={`/clients/${c.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-secondary">
                  <span className="tabular grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.companyName}</p>
                    <p className="text-xs text-muted-foreground">{c.invoiceCount} invoices</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular text-sm font-semibold">{money(c.billed, cur, true)}</p>
                    {c.outstanding > 0 ? (
                      <p className="tabular text-xs text-warning">{money(c.outstanding, cur, true)} open</p>
                    ) : null}
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Activity className="size-4 text-muted-foreground" aria-hidden />
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {activity.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing has happened yet.</p>
            ) : (
              activity.map((a) => (
                <div key={a.id} className="flex gap-3">
                  <div className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{titleCase(a.action.replace('.', ' '))}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.actorType === 'SYSTEM' ? 'Automation' : a.actor} · {relative(a.at)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        <Users className="size-4" aria-hidden />
        <span>
          {overview.clients.newThisMonth} new client{overview.clients.newThisMonth === 1 ? '' : 's'} this month ·
          {' '}{overview.churn.cancelledThisMonth} cancellation{overview.churn.cancelledThisMonth === 1 ? '' : 's'}
        </span>
        <Badge variant="muted" className="ml-auto">Churn {percent(overview.churn.churnRatePct)}</Badge>
      </div>
    </div>
  );
}
