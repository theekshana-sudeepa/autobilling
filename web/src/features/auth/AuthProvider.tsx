import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthenticated, setAccessToken } from '@/lib/api';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'STAFF';
  isActive: boolean;
  lastLoginAt: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const queryClient = useQueryClient();

  /**
   * Session re-hydration. The access token is memory-only, so on every page
   * load we exchange the httpOnly refresh cookie for a fresh one. This is the
   * single reason the app briefly shows a splash instead of the login screen.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const token = await api.refresh();
      if (cancelled) return;
      if (!token) {
        setStatus('anonymous');
        return;
      }
      try {
        const me = await api.get<AuthUser>('/auth/me');
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The API client tells us when a refresh finally fails mid-session.
  useEffect(() => {
    onUnauthenticated(() => {
      setUser(null);
      setStatus('anonymous');
      queryClient.clear();
    });
  }, [queryClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<{ accessToken: string; user: AuthUser }>('/auth/login', { email, password });
      setAccessToken(result.accessToken);
      setUser(result.user);
      setStatus('authenticated');
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, logout, isAdmin: user?.role === 'ADMIN' }),
    [user, status, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
