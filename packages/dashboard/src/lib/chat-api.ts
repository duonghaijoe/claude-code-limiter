/* ================================================================
   Chat API client — QE portal member surface
   ================================================================ */

import type { Balance } from './types';

const TOKEN_KEY = 'qep_token';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  workspace_path: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  project_id: string;
  subscription_id: string | null;
  pinned_until: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

export interface UsageSummary {
  daily?: { credits: number; tokens: number };
  weekly?: { credits: number; tokens: number };
  monthly?: { credits: number; tokens: number };
  [key: string]: { credits: number; tokens: number } | undefined;
}

export interface SendStreamEvent {
  event: string;
  data: unknown;
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

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: opts?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data)
      ? String((data as { error: unknown }).error)
      : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const chatApi = {
  getBalance: () => request<{ balance: Balance }>('/api/chat/balance'),
  getUsage: () => request<UsageSummary>('/api/chat/usage'),

  listProjects: () => request<{ projects: Project[] }>('/api/chat/projects'),
  createProject: (name: string) =>
    request<{ project: Project }>('/api/chat/projects', { method: 'POST', body: { name } }),
  deleteProject: (id: string) =>
    request<{ deleted: boolean }>(`/api/chat/projects/${id}`, { method: 'DELETE' }),

  listSessions: (projectId?: string) =>
    request<{ sessions: Session[] }>(`/api/chat/sessions${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  createSession: (projectId: string) =>
    request<{ session: Session }>('/api/chat/sessions', { method: 'POST', body: { project_id: projectId } }),

  listMessages: (sessionId: string) =>
    request<{ messages: Message[] }>(`/api/chat/sessions/${sessionId}/messages`),

  /**
   * Send a message and yield streamed SSE events. Each yielded value is a
   * parsed `{ event, data }` pair. The stream ends when the server closes
   * the connection (typically after the `done` event).
   */
  async *sendMessage(sessionId: string, content: string, model?: string): AsyncGenerator<SendStreamEvent> {
    const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify({ content, model: model || undefined }),
    });

    if (res.status === 402) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error ?? 'quota_exhausted', 402, body);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ApiError(text || `Send failed (${res.status})`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseBlock(block);
        if (evt) yield evt;
      }
    }
    if (buf.trim()) {
      const evt = parseBlock(buf);
      if (evt) yield evt;
    }
  },
};

function parseBlock(block: string): SendStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let data: unknown = dataLines.join('\n');
  try { data = JSON.parse(data as string); } catch { /* keep string */ }
  return { event, data };
}

export { ApiError };
