/**
 * ---------------------------------------------------------------------------
 * API CLIENT
 * ---------------------------------------------------------------------------
 * The access token lives in memory only — never localStorage. An XSS payload
 * therefore cannot read it, and the refresh token is an httpOnly cookie the
 * script cannot touch either. The cost is that a page reload has no token, so
 * the app calls /auth/refresh on boot to re-hydrate the session.
 *
 * Concurrent 401s are coalesced: fifty parallel queries expiring at once
 * trigger exactly ONE refresh call, and all fifty retry with the new token.
 */

const BASE = import.meta.env.VITE_API_URL ?? '';
const API = `${BASE}/api/v1`;

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  meta?: PageMeta & Record<string, unknown>;
  error?: { code: string; message: string; details?: ValidationDetail[] };
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ValidationDetail {
  field: string;
  message: string;
  code: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ValidationDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Feed straight into react-hook-form's setError. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.details ?? []).map((d) => [d.field, d.message]));
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

// --- token store ------------------------------------------------------------

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const getAccessToken = (): string | null => accessToken;
export const onUnauthenticated = (fn: () => void): void => {
  onSessionLost = fn;
};

// --- refresh coalescing -----------------------------------------------------

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return null;
      const json = (await res.json()) as ApiEnvelope<{ accessToken: string }>;
      accessToken = json.data.accessToken;
      return accessToken;
    } catch {
      return null;
    } finally {
      // Release the lock on the next tick so racers all see the same result.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();

  return refreshPromise;
}

// --- core request -----------------------------------------------------------

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  raw?: boolean;
  skipRetry?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, raw, skipRetry, headers, ...rest } = options;

  const res = await fetch(buildUrl(path, query), {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 401 → refresh once, then replay the original request.
  if (res.status === 401 && !skipRetry && !path.startsWith('/auth/refresh')) {
    const token = await refreshAccessToken();
    if (token) return request<T>(path, { ...options, skipRetry: true });
    accessToken = null;
    onSessionLost?.();
    throw new ApiError(401, 'UNAUTHORIZED', 'Your session expired. Please sign in again.');
  }

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'REQUEST_FAILED', res.statusText);
    return (await res.blob()) as T;
  }

  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!res.ok || !json?.ok) {
    throw new ApiError(
      res.status,
      json?.error?.code ?? 'REQUEST_FAILED',
      json?.error?.message ?? `Request failed with status ${res.status}`,
      json?.error?.details,
    );
  }

  return json.data;
}

/** Same as request() but keeps the pagination envelope. */
async function requestPaged<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; meta: PageMeta & Record<string, unknown> }> {
  const { body, query, headers, ...rest } = options;
  const res = await fetch(buildUrl(path, query), {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    const token = await refreshAccessToken();
    if (token) return requestPaged<T>(path, options);
    accessToken = null;
    onSessionLost?.();
    throw new ApiError(401, 'UNAUTHORIZED', 'Your session expired. Please sign in again.');
  }

  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !json?.ok) {
    throw new ApiError(res.status, json?.error?.code ?? 'REQUEST_FAILED', json?.error?.message ?? res.statusText, json?.error?.details);
  }

  return {
    data: json.data,
    meta: json.meta ?? { page: 1, pageSize: 20, total: Array.isArray(json.data) ? json.data.length : 0, totalPages: 1 },
  };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'GET', query }),
  list: <T>(path: string, query?: RequestOptions['query']) => requestPaged<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  blob: (path: string) => request<Blob>(path, { method: 'GET', raw: true }),
  refresh: refreshAccessToken,
};

/** Opens a PDF in a new tab with the Authorization header applied. */
export async function openInvoicePdf(invoiceId: string, invoiceNumber: string, download = false): Promise<void> {
  const blob = await api.blob(`/invoices/${invoiceId}/pdf`);
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${invoiceNumber}.pdf`;
    a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
