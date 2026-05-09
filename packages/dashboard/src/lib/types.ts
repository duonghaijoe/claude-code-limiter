/* ================================================================
   Admin domain types — QE portal
   ================================================================ */

export type WindowType = 'daily' | 'weekly' | 'monthly' | 'sliding_24h';

export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'paused' | 'killed';

export interface Balance {
  allowed: boolean;
  budget: number;
  granted: number;
  spent: number;
  remaining: number;
  window_type: WindowType;
  window_start?: string;
  reason?: string;
}

export interface CreditWeights {
  per_input_token?: number;
  per_output_token?: number;
  per_cache_read_token?: number;
  per_cache_create_token?: number;
  [key: string]: number | undefined;
}

export interface User {
  id: string;
  email: string;
  name: string;
  tier_id: string | null;
  role: UserRole;
  status: UserStatus;
  last_seen: string | null;
  created_at: string;
  balance?: Balance;
}

export interface Tier {
  id: string;
  name: string;
  credit_budget: number;
  window_type: WindowType;
  allowed_pools: string[];
  failover_pools: string[];
  credit_weights: CreditWeights;
  created_at?: string;
}

export interface Pool {
  id: string;
  name: string;
  plan: string;
  created_at?: string;
}

export type SubscriptionStatus = 'pending_auth' | 'active' | 'cool_down' | 'disabled';

export interface Subscription {
  id: string;
  pool_id: string;
  pod_name: string;
  pod_endpoint: string;
  login_email: string;
  status: SubscriptionStatus;
  oauth_token: string | null;
  oauth_token_added_at: string | null;
  cool_down_until: string | null;
  last_health: string | null;
  notes: string | null;
  created_at?: string;
}

export interface Grant {
  id: string;
  user_id: string;
  amount: number;
  reason: string | null;
  granted_by: string | null;
  granted_at: string;
  expires_at: string;
}

export interface AdminEvent {
  id: string;
  user_id: string | null;
  type: string;
  detail: Record<string, unknown> | null;
  subscription_id: string | null;
  session_id: string | null;
  created_at: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    tier_id: string | null;
  };
}

export interface AuthStartResponse {
  ticket: string;
  ws_url: string;
  expires_in: number;
}
