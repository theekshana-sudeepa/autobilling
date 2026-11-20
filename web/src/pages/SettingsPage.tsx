import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { Building2, Mail, Bell, Server, Upload, Send, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';
import type { AppSettings } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState } from '@/components/common/states';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/utils';

const TABS = [
  { id: 'company', label: 'Company', icon: Building2 },
  { id: 'billing', label: 'Billing', icon: Mail },
  { id: 'reminders', label: 'Reminders', icon: Bell },
  { id: 'email', label: 'Email delivery', icon: Server },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function SettingsPage() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<TabId>('company');
  const [testEmail, setTestEmail] = useState('');

  const { data: settings, isLoading, error, refetch } = useQuery({
    queryKey: qk.settings,
    queryFn: () => api.get<AppSettings>('/settings'),
  });

  const form = useForm<AppSettings>({ values: settings });
  const invoicePrefix = useWatch({ control: form.control, name: 'invoicePrefix' });
  const automationEnabled = useWatch({ control: form.control, name: 'automationEnabled' });

  const save = useMutation({
    mutationFn: (values: Partial<AppSettings>) => api.patch<AppSettings>('/settings', values),
    onSuccess: () => {
      toast.success('Settings saved', { description: 'Changes apply to the next automation run.' });
      setDraftOffsets(null);
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
    onError: (e) => toast.error('Could not save settings', { description: (e as Error).message }),
  });

  const sendTest = useMutation({
    mutationFn: (to: string) => api.post<{ ok: boolean; provider: string; error?: string }>('/settings/test-email', { to }),
    onSuccess: (r) =>
      r.ok
        ? toast.success('Test email sent', { description: `Delivered via ${r.provider}. Check the inbox and the spam folder.` })
        : toast.error('Delivery failed', { description: r.error ?? 'Check your provider credentials.' }),
    onError: (e) => toast.error('Test failed', { description: (e as Error).message }),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      return api.post<AppSettings>('/settings/logo', { filename: file.name, dataBase64 });
    },
    onSuccess: () => {
      toast.success('Logo updated', { description: 'It appears on the next invoice PDF and email.' });
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
    onError: (e) => toast.error('Upload failed', { description: (e as Error).message }),
  });

  const [draftOffsets, setDraftOffsets] = useState<number[] | null>(null);
  const offsets = draftOffsets ?? settings?.reminderOffsets ?? [];

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading || !settings) {
    return <div className="flex flex-col gap-4">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-40 rounded-xl" />)}</div>;
  }

  const readOnly = !isAdmin;
  const onSave = form.handleSubmit((values) => save.mutate({ ...values, reminderOffsets: offsets }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Settings"
        description="Company identity, billing defaults, reminder cadence and email delivery."
        actions={!readOnly ? <Button onClick={onSave} loading={save.isPending}>Save changes</Button> : undefined}
      />

      {readOnly ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <span>You have staff access — settings are read-only. Ask an administrator to make changes.</span>
        </div>
      ) : null}

      <div className="flex gap-1.5 overflow-x-auto border-b border-border pb-px" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden /> {label}
          </button>
        ))}
      </div>

      <form onSubmit={onSave} className="flex flex-col gap-4">
        {tab === 'company' ? (
          <Card>
            <CardHeader><CardTitle>Company identity</CardTitle><p className="text-sm text-muted-foreground">Shown on every invoice PDF and email.</p></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field><Label htmlFor="companyName">Trading name</Label><Input id="companyName" disabled={readOnly} {...form.register('companyName')} /></Field>
              <Field><Label htmlFor="legalName">Legal name</Label><Input id="legalName" disabled={readOnly} {...form.register('legalName')} /></Field>
              <Field><Label htmlFor="taxId">Tax / VAT ID</Label><Input id="taxId" disabled={readOnly} {...form.register('taxId')} /></Field>
              <Field><Label htmlFor="website">Website</Label><Input id="website" type="url" disabled={readOnly} {...form.register('website')} /></Field>
              <Field className="sm:col-span-2"><Label htmlFor="addressLine1">Address</Label><Input id="addressLine1" disabled={readOnly} {...form.register('addressLine1')} /></Field>
              <Field><Label htmlFor="city">City</Label><Input id="city" disabled={readOnly} {...form.register('city')} /></Field>
              <Field><Label htmlFor="country">Country</Label><Input id="country" disabled={readOnly} {...form.register('country')} /></Field>
              <Field><Label htmlFor="supportPhone">Support phone</Label><Input id="supportPhone" disabled={readOnly} {...form.register('supportPhone')} /></Field>

              <Field className="sm:col-span-2">
                <Label>Logo</Label>
                <div className="flex items-center gap-4 rounded-lg border border-dashed border-border p-4">
                  {settings.logoPath ? (
                    <img src={settings.logoPath} alt="Company logo" className="h-12 w-auto max-w-[160px] object-contain" />
                  ) : (
                    <div className="grid h-12 w-24 place-items-center rounded bg-secondary text-xs text-muted-foreground">No logo</div>
                  )}
                  <div>
                    <label className={cn('inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-secondary', readOnly && 'pointer-events-none opacity-50')}>
                      <Upload className="size-4" aria-hidden /> Upload
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml"
                        className="sr-only"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo.mutate(f); }}
                      />
                    </label>
                    <p className="mt-1.5 text-xs text-muted-foreground">PNG, JPG or SVG · max 2 MB · 300×80 px works best.</p>
                  </div>
                </div>
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {tab === 'billing' ? (
          <Card>
            <CardHeader><CardTitle>Billing defaults</CardTitle><p className="text-sm text-muted-foreground">Applied to newly generated invoices.</p></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field>
                <Label htmlFor="invoicePrefix">Invoice prefix</Label>
                <Input id="invoicePrefix" disabled={readOnly} {...form.register('invoicePrefix')} />
                <p className="tabular text-xs text-muted-foreground">Produces {invoicePrefix || 'INV'}-{new Date().getFullYear()}-00081</p>
              </Field>
              <Field>
                <Label htmlFor="defaultCurrency">Default currency</Label>
                <select id="defaultCurrency" disabled={readOnly} className="h-9 rounded-lg border border-input bg-background px-3 text-sm" {...form.register('defaultCurrency')}>
                  {['LKR', 'USD', 'EUR', 'GBP', 'AUD', 'INR'].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field>
                <Label htmlFor="invoiceLeadDays">Generate invoice this many days before due</Label>
                <Input id="invoiceLeadDays" type="number" min={0} max={30} disabled={readOnly} {...form.register('invoiceLeadDays')} />
              </Field>
              <Field>
                <Label htmlFor="timezone">Timezone</Label>
                <Input id="timezone" disabled={readOnly} {...form.register('timezone')} />
                <p className="text-xs text-muted-foreground">Decides what "today" means for every job.</p>
              </Field>
              <Field className="sm:col-span-2">
                <Label htmlFor="paymentInstructions">Payment instructions</Label>
                <Textarea id="paymentInstructions" rows={5} disabled={readOnly} {...form.register('paymentInstructions')} />
                <p className="text-xs text-muted-foreground">Printed on the PDF and included in every reminder email.</p>
              </Field>
              <Field className="sm:col-span-2">
                <Label htmlFor="invoiceFooter">Invoice footer</Label>
                <Input id="invoiceFooter" disabled={readOnly} {...form.register('invoiceFooter')} />
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {tab === 'reminders' ? (
          <Card>
            <CardHeader>
              <CardTitle>Reminder schedule</CardTitle>
              <p className="text-sm text-muted-foreground">Days relative to the due date. Negative is before, 0 is the due date, positive is overdue.</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                {[-14, -7, -5, -3, -1, 0, 1, 3, 7, 14, 21, 30].map((offset) => {
                  const active = offsets.includes(offset);
                  return (
                    <button
                      key={offset}
                      type="button"
                      disabled={readOnly}
                      aria-pressed={active}
                      onClick={() =>
                        setDraftOffsets((prev) => {
                          const base = prev ?? settings.reminderOffsets;
                          return active ? base.filter((o) => o !== offset) : [...base, offset].sort((a, b) => a - b);
                        })
                      }
                      className={cn(
                        'h-9 rounded-lg border px-3 text-sm font-medium transition-colors disabled:opacity-50',
                        active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary',
                      )}
                    >
                      {offset < 0 ? `${Math.abs(offset)}d before` : offset === 0 ? 'Due date' : `${offset}d after`}
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg bg-secondary/60 p-4 text-sm">
                <p className="mb-2 font-medium">Preview for an invoice due on the 5th</p>
                <ol className="flex flex-col gap-1 text-muted-foreground">
                  {[...offsets].sort((a, b) => a - b).map((o) => (
                    <li key={o} className="tabular flex items-center gap-2">
                      <span className="inline-block w-16 text-right font-medium text-foreground">{o > 0 ? `+${o}` : o}d</span>
                      <span>
                        {o < 0 ? 'Friendly reminder' : o === 0 ? 'Due today notice' : o >= (settings.finalNoticeDay ?? 14) ? 'Final notice' : 'Overdue reminder'}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <Label htmlFor="finalNoticeDay">Final notice after (days overdue)</Label>
                  <Input id="finalNoticeDay" type="number" min={1} max={90} disabled={readOnly} {...form.register('finalNoticeDay')} />
                </Field>
                <Field>
                  <Label>Automation</Label>
                  <label className="flex h-9 items-center gap-2.5 text-sm">
                    <input type="checkbox" disabled={readOnly} className="size-4 accent-[hsl(var(--primary))]" {...form.register('automationEnabled')} />
                    <span>Run invoice generation and reminders automatically</span>
                  </label>
                  {automationEnabled === false ? (
                    <Badge variant="warning">Paused — nothing is being sent</Badge>
                  ) : null}
                </Field>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {tab === 'email' ? (
          <Card>
            <CardHeader><CardTitle>Email delivery</CardTitle><p className="text-sm text-muted-foreground">Resend is primary; SMTP is the failover when Resend is unreachable.</p></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field>
                <Label htmlFor="billingEmail">From address</Label>
                <Input id="billingEmail" type="email" disabled={readOnly} {...form.register('billingEmail')} />
                <p className="text-xs text-muted-foreground">Must be a verified sender on your domain.</p>
              </Field>
              <Field><Label htmlFor="replyToEmail">Reply-to</Label><Input id="replyToEmail" type="email" disabled={readOnly} {...form.register('replyToEmail')} /></Field>

              <Field>
                <Label htmlFor="emailProvider">Provider</Label>
                <select id="emailProvider" disabled={readOnly} className="h-9 rounded-lg border border-input bg-background px-3 text-sm" {...form.register('emailProvider')}>
                  <option value="resend">Resend (recommended)</option>
                  <option value="smtp">SMTP</option>
                </select>
              </Field>
              <div />

              <Field><Label htmlFor="smtpHost">SMTP host</Label><Input id="smtpHost" disabled={readOnly} placeholder="mail.example.com" {...form.register('smtpHost')} /></Field>
              <Field><Label htmlFor="smtpPort">SMTP port</Label><Input id="smtpPort" type="number" disabled={readOnly} placeholder="465" {...form.register('smtpPort')} /></Field>
              <Field><Label htmlFor="smtpUser">SMTP user</Label><Input id="smtpUser" disabled={readOnly} {...form.register('smtpUser')} /></Field>
              <Field>
                <Label htmlFor="smtpPassword">SMTP password</Label>
                <Input id="smtpPassword" type="password" disabled={readOnly} placeholder={settings.smtpPasswordSet ? '•••••••• (unchanged)' : 'Not set'} {...form.register('smtpPassword' as never)} />
                <p className="text-xs text-muted-foreground">Encrypted at rest with AES-256-GCM. Leave blank to keep the current value.</p>
              </Field>

              <Field className="sm:col-span-2">
                <Label htmlFor="testEmail">Send a test email</Label>
                <div className="flex gap-2">
                  <Input id="testEmail" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" />
                  <Button type="button" variant="outline" disabled={!testEmail || readOnly} loading={sendTest.isPending} onClick={() => sendTest.mutate(testEmail)}>
                    <Send aria-hidden /> Send test
                  </Button>
                </div>
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {!readOnly ? (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>Save changes</Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
