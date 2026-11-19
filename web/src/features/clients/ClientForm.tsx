import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Input, Label, Textarea } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { clientFormSchema, type ClientFormValues } from './useClients';
import type { Client } from '@/types/api';

const EMPTY: ClientFormValues = {
  companyName: '',
  contactPerson: '',
  email: '',
  billingEmail: '',
  ccEmails: '',
  phone: '',
  whatsapp: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  country: '',
  taxId: '',
  notes: '',
  status: 'ACTIVE',
};

export function ClientForm({
  client,
  onSubmit,
  onCancel,
  submitting,
  error,
}: {
  client?: Client | null;
  onSubmit: (values: ClientFormValues) => void;
  onCancel: () => void;
  submitting: boolean;
  error?: unknown;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ClientFormValues>({
    resolver: zodResolver(clientFormSchema),
    defaultValues: client
      ? {
          ...EMPTY,
          ...Object.fromEntries(Object.entries(client).map(([k, v]) => [k, v ?? ''])),
          status: client.status,
        }
      : EMPTY,
  });

  // Server-side validation errors land on the exact fields that caused them.
  useEffect(() => {
    if (error instanceof ApiError && error.status === 422) {
      for (const [field, message] of Object.entries(error.fieldErrors)) {
        setError(field as keyof ClientFormValues, { message });
      }
    }
  }, [error, setError]);

  return (
    <form
      id="client-form"
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-5"
      noValidate
    >
      <section className="grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2">
          <Label htmlFor="companyName" required>Company name</Label>
          <Input id="companyName" placeholder="Silverline Supermarket" aria-invalid={Boolean(errors.companyName)} {...register('companyName')} />
          <FieldError message={errors.companyName?.message} />
        </Field>

        <Field>
          <Label htmlFor="contactPerson">Contact person</Label>
          <Input id="contactPerson" placeholder="Nuwan Perera" {...register('contactPerson')} />
          <FieldError message={errors.contactPerson?.message} />
        </Field>

        <Field>
          <Label htmlFor="taxId">Tax / VAT ID</Label>
          <Input id="taxId" placeholder="Optional" {...register('taxId')} />
        </Field>

        <Field>
          <Label htmlFor="email" required>Primary email</Label>
          <Input id="email" type="email" placeholder="accounts@company.lk" aria-invalid={Boolean(errors.email)} {...register('email')} />
          <FieldError message={errors.email?.message} />
        </Field>

        <Field>
          <Label htmlFor="billingEmail">Billing email</Label>
          <Input id="billingEmail" type="email" placeholder="Defaults to primary email" {...register('billingEmail')} />
          <FieldError message={errors.billingEmail?.message} />
        </Field>

        <Field className="sm:col-span-2">
          <Label htmlFor="ccEmails">CC on invoices</Label>
          <Input id="ccEmails" placeholder="owner@company.lk, cfo@company.lk" {...register('ccEmails')} />
          <p className="text-xs text-muted-foreground">Comma separated. Everyone here receives every invoice and reminder.</p>
          <FieldError message={errors.ccEmails?.message} />
        </Field>

        <Field>
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" type="tel" placeholder="+94 77 123 4567" {...register('phone')} />
        </Field>

        <Field>
          <Label htmlFor="whatsapp">WhatsApp</Label>
          <Input id="whatsapp" type="tel" placeholder="+94 77 123 4567" {...register('whatsapp')} />
        </Field>
      </section>

      <section className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <Field className="sm:col-span-2">
          <Label htmlFor="addressLine1">Address</Label>
          <Input id="addressLine1" placeholder="No. 12, Galle Road" {...register('addressLine1')} />
        </Field>
        <Field className="sm:col-span-2">
          <Input id="addressLine2" placeholder="Line 2 (optional)" aria-label="Address line 2" {...register('addressLine2')} />
        </Field>
        <Field>
          <Label htmlFor="city">City</Label>
          <Input id="city" placeholder="Colombo" {...register('city')} />
        </Field>
        <Field>
          <Label htmlFor="country">Country</Label>
          <Input id="country" placeholder="Sri Lanka" {...register('country')} />
        </Field>
      </section>

      <section className="grid gap-4 border-t border-border pt-5">
        <Field>
          <Label htmlFor="notes">Internal notes</Label>
          <Textarea id="notes" rows={3} placeholder="Not shown to the client." {...register('notes')} />
        </Field>

        <Field>
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring"
            {...register('status')}
          >
            <option value="ACTIVE">Active — invoices generate automatically</option>
            <option value="INACTIVE">Inactive — billing paused</option>
          </select>
        </Field>
      </section>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={submitting}>{client ? 'Save changes' : 'Add client'}</Button>
      </div>
    </form>
  );
}
