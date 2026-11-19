import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Input, Label } from '@/components/ui/input';
import { useAuth } from '@/features/auth/AuthProvider';
import { ApiError } from '@/lib/api';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values.email, values.password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      // Deliberately generic: never reveal whether the email exists.
      setFormError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : 'Incorrect email or password.',
      );
    }
  });

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      {/* Brand panel — hidden on mobile so the form is above the fold. */}
      <div className="relative hidden overflow-hidden bg-primary lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-25"
          style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, white 0, transparent 45%), radial-gradient(circle at 80% 70%, white 0, transparent 40%)' }}
          aria-hidden
        />
        <div className="relative flex items-center gap-2.5 text-primary-foreground">
          <div className="grid size-8 place-items-center rounded-lg bg-primary-foreground/15 font-bold backdrop-blur">A</div>
          <span className="font-semibold tracking-tight">AutoBilling</span>
        </div>
        <div className="relative max-w-md text-primary-foreground">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Add a client once.<br />Bill them forever.
          </h2>
          <p className="mt-4 text-primary-foreground/80">
            Recurring invoices, PDF generation and payment reminders — generated, sent and chased automatically.
          </p>
        </div>
        <p className="relative text-sm text-primary-foreground/60">© {new Date().getFullYear()} AutoBilling</p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm animate-[slide-up_.3s_cubic-bezier(.16,1,.3,1)]">
          <div className="mb-8 lg:hidden">
            <div className="grid size-9 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">A</div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Sign in with your billing workspace account.</p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
            {formError ? (
              <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
                {formError}
              </div>
            ) : null}

            <Field>
              <Label htmlFor="email" required>Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                placeholder="admin@example.com"
                aria-invalid={Boolean(errors.email)}
                {...register('email')}
              />
              <FieldError message={errors.email?.message} />
            </Field>

            <Field>
              <Label htmlFor="password" required>Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  className="pr-10"
                  aria-invalid={Boolean(errors.password)}
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              </div>
              <FieldError message={errors.password?.message} />
            </Field>

            <Button type="submit" size="lg" loading={isSubmitting} className="mt-2 w-full">
              Sign in
            </Button>
          </form>

          <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" aria-hidden />
            Protected by rate limiting and audit logging
          </p>
        </div>
      </div>
    </div>
  );
}
