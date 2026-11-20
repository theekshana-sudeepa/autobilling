import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Repeat,
  FileText,
  CreditCard,
  Mail,
  Settings as SettingsIcon,
  Menu,
  X,
  Sun,
  Moon,
  LogOut,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/AuthProvider';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/subscriptions', label: 'Subscriptions', icon: Repeat },
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/payments', label: 'Payments', icon: CreditCard },
  { to: '/email-logs', label: 'Email logs', icon: Mail },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ab-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function AppShell() {
  const [mobileOpenPath, setMobileOpenPath] = useState<string | null>(null);
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();

  // Derived from pathname so the drawer automatically closes on navigation without cascading effects.
  const mobileOpen = mobileOpenPath === location.pathname;
  const openMobile = () => setMobileOpenPath(location.pathname);
  const closeMobile = () => setMobileOpenPath(null);

  // Global shortcuts: ⌘K search, g+i invoices, g+c clients.
  useEffect(() => {
    let lastKey = '';
    const handler = (e: KeyboardEvent) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
        return;
      }
      if (inField) return;
      if (lastKey === 'g') {
        const map: Record<string, string> = { i: '/invoices', c: '/clients', d: '/', s: '/subscriptions', p: '/payments' };
        const target = map[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          navigate(target);
        }
      }
      lastKey = e.key.toLowerCase();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  const nav = (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-3 py-4">
      {NAV.map(({ to, label, icon: Icon, ...rest }) => (
        <NavLink
          key={to}
          to={to}
          end={'end' in rest ? rest.end : undefined}
          className={({ isActive }) =>
            cn(
              'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon className={cn('size-4 shrink-0 transition-transform group-hover:scale-110', isActive && 'text-primary')} aria-hidden />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only-focusable absolute left-4 top-4 z-50 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">
        Skip to content
      </a>

      {/* --- desktop sidebar --- */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-5">
          <div className="grid size-7 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">A</div>
          <span className="text-sm font-semibold tracking-tight">AutoBilling</span>
        </div>
        {nav}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold">
              {initials(user?.name ?? 'U')}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user?.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.role === 'ADMIN' ? 'Administrator' : 'Staff'}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="Sign out">
              <LogOut aria-hidden />
            </Button>
          </div>
        </div>
      </aside>

      {/* --- mobile drawer --- */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm animate-[fade-in_.15s_ease-out]" onClick={closeMobile} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-card animate-[slide-up_.2s_cubic-bezier(.16,1,.3,1)]">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <span className="text-sm font-semibold">AutoBilling</span>
              <Button variant="ghost" size="icon" onClick={closeMobile} aria-label="Close menu">
                <X aria-hidden />
              </Button>
            </div>
            {nav}
          </aside>
        </div>
      ) : null}

      {/* --- main column --- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={openMobile} aria-label="Open menu">
            <Menu aria-hidden />
          </Button>

          <div className="relative hidden max-w-sm flex-1 sm:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              id="global-search"
              type="search"
              placeholder="Search clients, invoices…"
              aria-label="Search"
              className="h-9 w-full rounded-lg border border-input bg-secondary/50 pl-9 pr-14 text-sm outline-none transition-colors focus:border-ring focus:bg-background focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(`/invoices?search=${encodeURIComponent(e.currentTarget.value)}`);
              }}
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:block">
              ⌘K
            </kbd>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
              {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
            </Button>
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => void logout()} aria-label="Sign out">
              <LogOut aria-hidden />
            </Button>
          </div>
        </header>

        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
