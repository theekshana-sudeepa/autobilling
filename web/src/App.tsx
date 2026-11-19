import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { AppShell } from '@/components/layout/AppShell';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';

// Route-level code splitting: the dashboard is the landing page and ships in
// the main bundle; everything else loads on demand.
const ClientsPage = lazy(() => import('@/pages/ClientsPage'));
const ClientDetailPage = lazy(() => import('@/pages/ClientDetailPage'));
const SubscriptionsPage = lazy(() => import('@/pages/SubscriptionsPage'));
const InvoicesPage = lazy(() => import('@/pages/InvoicesPage'));
const InvoiceDetailPage = lazy(() => import('@/pages/InvoiceDetailPage'));
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage'));
const EmailLogsPage = lazy(() => import('@/pages/EmailLogsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3">
        <div className="size-9 animate-spin rounded-full border-2 border-border border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function AppRoutes() {
  const { status } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={status === 'authenticated' ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="clients" element={<Suspense fallback={<Splash />}><ClientsPage /></Suspense>} />
        <Route path="clients/:id" element={<Suspense fallback={<Splash />}><ClientDetailPage /></Suspense>} />
        <Route path="subscriptions" element={<Suspense fallback={<Splash />}><SubscriptionsPage /></Suspense>} />
        <Route path="invoices" element={<Suspense fallback={<Splash />}><InvoicesPage /></Suspense>} />
        <Route path="invoices/:id" element={<Suspense fallback={<Splash />}><InvoiceDetailPage /></Suspense>} />
        <Route path="payments" element={<Suspense fallback={<Splash />}><PaymentsPage /></Suspense>} />
        <Route path="email-logs" element={<Suspense fallback={<Splash />}><EmailLogsPage /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<Splash />}><SettingsPage /></Suspense>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <Toaster
            position="top-right"
            richColors
            closeButton
            toastOptions={{ className: 'font-sans text-sm' }}
          />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
