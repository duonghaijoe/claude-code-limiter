/* ================================================================
   Admin API client — QE portal
   ================================================================ */

import type {
  AdminEvent,
  AuthStartResponse,
  Grant,
  LoginResponse,
  Pool,
  Subscription,
  Tier,
  User,
} from './types';

const TOKEN_KEY = 'qep_token';
const USER_KEY = 'qep_user';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function getStoredUser(): LoginResponse['user'] | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setStoredUser(u: LoginResponse['user']) {
  localStorage.setItem(USER_KEY, JSON.stringify(u));
}

class ApiError extends Error {
  status: number;
  detail?: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

let onUnauthorized: (() => void) | null = null;

async function request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method: opts?.method ?? 'GET',
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401) {
    clearAuth();
    onUnauthorized?.();
    throw new ApiError('Session expired', 401);
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data)
      ? String((data as { error: unknown }).error)
      : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }

  return data as T;
}

function qs(params?: Record<string, string | number | undefined | null>): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function login(email: string, password: string): Promise<LoginResponse> {
  const data = await request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  setToken(data.token);
  setStoredUser(data.user);
  return data;
}

function logout() {
  clearAuth();
}

export const api = {
  // auth
  login,
  logout,
  isAuthenticated: () => !!getToken(),
  getStoredUser,
  getToken,
  setUnauthorizedHandler: (fn: () => void) => { onUnauthorized = fn; },

  // users
  listUsers: () => request<{ users: User[] }>('/api/admin/users'),
  createUser: (body: { email: string; name: string; password?: string; tier_id?: string; role?: string }) =>
    request<{ user: User }>('/api/admin/users', { method: 'POST', body }),
  updateUser: (id: string, body: Partial<{ name: string; tier_id: string; role: string; status: string; password: string }>) =>
    request<{ user: User }>(`/api/admin/users/${id}`, { method: 'PUT', body }),
  deleteUser: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  // tiers
  listTiers: () => request<{ tiers: Tier[] }>('/api/admin/tiers'),
  createTier: (body: Partial<Tier>) =>
    request<{ tier: Tier }>('/api/admin/tiers', { method: 'POST', body }),
  updateTier: (id: string, body: Partial<Tier>) =>
    request<{ tier: Tier }>(`/api/admin/tiers/${id}`, { method: 'PUT', body }),
  deleteTier: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/tiers/${id}`, { method: 'DELETE' }),

  // pools
  listPools: () => request<{ pools: Pool[] }>('/api/admin/pools'),
  createPool: (body: { name: string; plan: string }) =>
    request<{ pool: Pool }>('/api/admin/pools', { method: 'POST', body }),
  deletePool: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/pools/${id}`, { method: 'DELETE' }),

  // subscriptions
  listSubscriptions: () => request<{ subscriptions: Subscription[] }>('/api/admin/subscriptions'),
  createSubscription: (body: { pool_id: string; pod_name: string; pod_endpoint: string; login_email: string; notes?: string }) =>
    request<{ subscription: Subscription }>('/api/admin/subscriptions', { method: 'POST', body }),
  updateSubscription: (id: string, body: Partial<Subscription>) =>
    request<{ subscription: Subscription }>(`/api/admin/subscriptions/${id}`, { method: 'PUT', body }),
  deleteSubscription: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/subscriptions/${id}`, { method: 'DELETE' }),
  startSubscriptionAuth: (id: string) =>
    request<AuthStartResponse>(`/api/admin/subscriptions/${id}/auth/start`, { method: 'POST' }),

  // grants
  listGrants: (userId: string) =>
    request<{ grants: Grant[] }>(`/api/admin/users/${userId}/grants`),
  createGrant: (userId: string, body: { amount: number; reason?: string; expires_at: string }) =>
    request<{ grant: Grant }>(`/api/admin/users/${userId}/grants`, { method: 'POST', body }),

  // events
  listEvents: (params?: { limit?: number; user_id?: string }) =>
    request<{ events: AdminEvent[] }>(`/api/admin/events${qs(params)}`),
};

export { ApiError };
