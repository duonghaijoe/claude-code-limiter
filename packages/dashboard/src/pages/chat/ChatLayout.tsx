import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { chatApi, type Project, type Session, type Message } from '../../lib/chat-api';
import type { Balance } from '../../lib/types';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../components/Modal';
import { useToast } from '../../hooks/useToast';
import { ToastContainer } from '../../components/Toast';

export function ChatLayout() {
  const navigate = useNavigate();
  const { toasts, showToast, removeToast } = useToast();
  const stored = api.getStoredUser();

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [composer, setComposer] = useState('');
  const [model, setModel] = useState<string>('');
  const [streaming, setStreaming] = useState(false);
  const [streamPreview, setStreamPreview] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.setUnauthorizedHandler(() => navigate('/dashboard/login', { replace: true }));
  }, [navigate]);

  // Initial load
  useEffect(() => {
    void (async () => {
      try {
        const [proj, bal] = await Promise.all([chatApi.listProjects(), chatApi.getBalance()]);
        setProjects(proj.projects);
        setBalance(bal.balance);
        if (proj.projects[0]) setActiveProject(proj.projects[0].id);
      } catch (err) {
        showToast('Load failed', err instanceof Error ? err.message : '', 'error');
      }
    })();
  }, [showToast]);

  // Load sessions when project changes
  useEffect(() => {
    if (!activeProject) { setSessions([]); setActiveSession(null); return; }
    void (async () => {
      try {
        const { sessions } = await chatApi.listSessions(activeProject);
        setSessions(sessions);
        setActiveSession(sessions[0]?.id ?? null);
      } catch (err) {
        showToast('Sessions load failed', err instanceof Error ? err.message : '', 'error');
      }
    })();
  }, [activeProject, showToast]);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSession) { setMessages([]); return; }
    void (async () => {
      try {
        const { messages } = await chatApi.listMessages(activeSession);
        setMessages(messages);
      } catch (err) {
        showToast('Messages load failed', err instanceof Error ? err.message : '', 'error');
      }
    })();
  }, [activeSession, showToast]);

  // Scroll to bottom on message change
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamPreview]);

  async function refreshBalance() {
    try {
      const { balance } = await chatApi.getBalance();
      setBalance(balance);
    } catch { /* ignore */ }
  }

  async function newProject(name: string) {
    try {
      const { project } = await chatApi.createProject(name);
      setProjects((p) => [project, ...p]);
      setActiveProject(project.id);
      setShowNewProject(false);
    } catch (err) {
      showToast('Create failed', err instanceof Error ? err.message : '', 'error');
    }
  }

  async function newSession() {
    if (!activeProject) return;
    try {
      const { session } = await chatApi.createSession(activeProject);
      setSessions((s) => [session, ...s]);
      setActiveSession(session.id);
    } catch (err) {
      showToast('New session failed', err instanceof Error ? err.message : '', 'error');
    }
  }

  async function send() {
    if (!activeSession || !composer.trim() || streaming) return;
    const content = composer.trim();
    const userMsg: Message = {
      id: `pending-${Date.now()}`,
      session_id: activeSession,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setComposer('');
    setStreaming(true);
    setStreamPreview('');

    try {
      let assistantText = '';
      let creditCost: number | null = null;
      for await (const evt of chatApi.sendMessage(activeSession, content, model)) {
        if (evt.event === 'result' && evt.data && typeof evt.data === 'object') {
          const d = evt.data as { type?: string; result?: unknown };
          if (d.type === 'result' && typeof d.result === 'string') {
            assistantText = d.result;
            setStreamPreview(assistantText);
          }
        } else if (evt.event === 'message' && evt.data && typeof evt.data === 'object') {
          // Best-effort streaming preview from assistant deltas if SDK emits them.
          const d = evt.data as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
          if (d.type === 'assistant' && d.message?.content) {
            const text = d.message.content
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text)
              .join('');
            if (text) {
              assistantText = text;
              setStreamPreview(assistantText);
            }
          }
        } else if (evt.event === 'meta' && evt.data && typeof evt.data === 'object') {
          const d = evt.data as { credit_cost?: number };
          if (typeof d.credit_cost === 'number') creditCost = d.credit_cost;
        } else if (evt.event === 'error' && evt.data && typeof evt.data === 'object') {
          const d = evt.data as { detail?: string; error?: string };
          showToast('Stream error', d.detail ?? d.error ?? 'unknown', 'error');
        }
      }

      const assistantMsg: Message = {
        id: `assistant-${Date.now()}`,
        session_id: activeSession,
        role: 'assistant',
        content: assistantText || '(empty response)',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (creditCost != null) {
        showToast('Turn complete', `${creditCost.toFixed(2)} credits`, 'info', 2500);
      }
      await refreshBalance();
    } catch (err) {
      const apiErr = err as { status?: number; detail?: { balance?: Balance } };
      if (apiErr.status === 402) {
        showToast('Quota exhausted', 'Ask an admin to grant more credits.', 'warning');
        if (apiErr.detail?.balance) setBalance(apiErr.detail.balance);
      } else {
        showToast('Send failed', err instanceof Error ? err.message : '', 'error');
      }
    } finally {
      setStreaming(false);
      setStreamPreview('');
    }
  }

  function logout() {
    api.logout();
    navigate('/dashboard/login');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Left: projects */}
      <aside className="w-64 border-r border-zinc-800 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">QE Portal</div>
              <div className="text-[11px] text-zinc-500 truncate">{stored?.email}</div>
            </div>
            <button onClick={logout} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Sign out</button>
          </div>
        </div>
        <div className="px-3 py-3 border-b border-zinc-800">
          <BalanceWidget balance={balance} onRefresh={refreshBalance} />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">Projects</span>
            <button
              onClick={() => setShowNewProject(true)}
              className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              + New
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="px-2 py-3 text-xs text-zinc-500">No projects yet.</div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                onClick={() => setActiveProject(p.id)}
                className={`w-full text-left px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors ${
                  activeProject === p.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }`}
              >
                {p.name}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Middle: sessions */}
      <aside className="w-56 border-r border-zinc-800 flex flex-col">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">Sessions</span>
          <Button size="sm" variant="secondary" onClick={newSession} disabled={!activeProject}>+ New</Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {sessions.length === 0 ? (
            <div className="px-2 py-3 text-xs text-zinc-500">No sessions.</div>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSession(s.id)}
                className={`w-full text-left px-2 py-1.5 rounded-md text-xs font-mono cursor-pointer transition-colors ${
                  activeSession === s.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
                }`}
              >
                {s.id.slice(0, 8)} <span className="text-zinc-600">·</span> <span className="text-zinc-600">{new Date(s.created_at).toLocaleDateString()}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Right: thread */}
      <main className="flex-1 flex flex-col">
        <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="text-sm text-zinc-400">
            {activeSession ? <>Session <span className="font-mono text-zinc-300">{activeSession.slice(0, 12)}</span></> : 'No session selected'}
          </div>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model (e.g. claude-sonnet-4-6)"
            className="w-72"
          />
        </div>

        <div ref={threadRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {messages.length === 0 && !streaming && (
            <div className="text-center text-sm text-zinc-500 mt-8">
              {activeSession ? 'No messages yet — send a prompt to begin.' : 'Select or create a session.'}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Assistant · streaming</div>
              <pre className="text-sm text-zinc-200 whitespace-pre-wrap break-words font-sans">
                {streamPreview || 'Thinking...'}
              </pre>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 px-6 py-4">
          <div className="flex items-end gap-3">
            <textarea
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={3}
              placeholder={activeSession ? 'Send a prompt — Cmd+Enter to send' : 'Pick a session first'}
              disabled={!activeSession || streaming}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none disabled:opacity-40"
            />
            <Button variant="primary" onClick={send} disabled={!activeSession || !composer.trim() || streaming}>
              {streaming ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </div>
      </main>

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={newProject} />
      )}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

function BalanceWidget({ balance, onRefresh }: { balance: Balance | null; onRefresh: () => void }) {
  if (!balance) {
    return <div className="text-xs text-zinc-500">No balance loaded.</div>;
  }
  const total = balance.budget + balance.granted;
  const pct = total > 0 ? Math.max(0, Math.min(100, (balance.remaining / total) * 100)) : 0;
  const color = balance.allowed ? 'bg-blue-500' : 'bg-red-500';
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">Credits ({balance.window_type})</span>
        <button onClick={onRefresh} className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer">↻</button>
      </div>
      <div className="text-sm text-zinc-200">
        {balance.remaining.toFixed(0)} <span className="text-zinc-500">/ {total.toFixed(0)}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {!balance.allowed && balance.reason && (
        <div className="mt-2 text-[11px] text-red-400">{balance.reason}</div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-3xl rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600/15 border border-blue-500/30 text-blue-50'
            : 'bg-zinc-900 border border-zinc-800 text-zinc-100'
        }`}
      >
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{message.role}</div>
        <pre className="text-sm whitespace-pre-wrap break-words font-sans">{message.content}</pre>
      </div>
    </div>
  );
}

function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal open onClose={onClose}>
      <ModalHeader onClose={onClose}>New project</ModalHeader>
      <ModalBody>
        <Input label="Project name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="qa-week-12" />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => name.trim() && onCreate(name.trim())} disabled={!name.trim()}>Create</Button>
      </ModalFooter>
    </Modal>
  );
}
