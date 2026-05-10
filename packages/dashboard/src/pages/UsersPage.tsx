import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Tier, User } from '../lib/types';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Input, Select } from '../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { Table } from '../components/Table';
import { Badge, StatusBadge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';

type ShowToast = (title: string, msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

export function UsersPage({ showToast }: { showToast: ShowToast }) {
  const [users, setUsers] = useState<User[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [granting, setGranting] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const tierLookup = useMemo(() => {
    const m = new Map<string, Tier>();
    for (const t of tiers) m.set(t.id, t);
    return m;
  }, [tiers]);

  async function refresh() {
    try {
      const [u, t] = await Promise.all([api.listUsers(), api.listTiers()]);
      setUsers(u.users);
      setTiers(t.tiers);
    } catch (err) {
      showToast('Load failed', err instanceof Error ? err.message : 'Could not load users', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleDelete() {
    if (!deleting) return;
    try {
      await api.deleteUser(deleting.id);
      showToast('Deleted', `${deleting.email} removed`, 'success');
      setDeleting(null);
      refresh();
    } catch (err) {
      showToast('Delete failed', err instanceof Error ? err.message : '', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Users</h1>
          <p className="text-sm text-zinc-500 mt-1">Accounts, tiers, and credit balances.</p>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>+ New user</Button>
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm text-zinc-400">{users.length} {users.length === 1 ? 'user' : 'users'}</span>
        </CardHeader>
        <CardBody flush>
          {loading ? (
            <div className="px-5 py-8 text-sm text-zinc-500">Loading...</div>
          ) : (
            <Table
              data={users}
              keyExtractor={(u) => u.id}
              emptyMessage="No users yet"
              columns={[
                {
                  key: 'email',
                  header: 'User',
                  render: (u) => (
                    <div>
                      <div className="text-zinc-100 font-medium">{u.name}</div>
                      <div className="text-xs text-zinc-500">{u.email}</div>
                    </div>
                  ),
                },
                {
                  key: 'role',
                  header: 'Role',
                  render: (u) => <Badge variant={u.role === 'admin' ? 'model' : 'default'}>{u.role}</Badge>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (u) => <StatusBadge status={u.status} />,
                },
                {
                  key: 'tier',
                  header: 'Tier',
                  render: (u) => (
                    <span className="text-zinc-300">
                      {u.tier_id ? tierLookup.get(u.tier_id)?.name ?? '—' : '—'}
                    </span>
                  ),
                },
                {
                  key: 'balance',
                  header: 'Limits',
                  render: (u) => {
                    if (!u.balance) return <span className="text-zinc-500">—</span>;
                    const limits = u.balance.limits || [];
                    if (limits.length === 0) {
                      return <span className="text-zinc-500">—</span>;
                    }
                    return (
                      <div className="text-xs space-y-0.5">
                        {limits.map((l) => {
                          const remaining = Number(l.remaining) || 0;
                          const total = Number(l.effective_budget) || 0;
                          const cls = !l.allowed ? 'text-red-400' : remaining <= total * 0.1 ? 'text-amber-300' : 'text-zinc-200';
                          return (
                            <div key={l.id} className={cls}>
                              <span className="text-zinc-500">{l.label}:</span> {remaining.toFixed(0)} / {total.toFixed(0)}
                            </div>
                          );
                        })}
                      </div>
                    );
                  },
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (u) => (
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setGranting(u)}>Grant</Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(u)}>Edit</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(u)}>Delete</Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {showCreate && (
        <CreateUserModal
          tiers={tiers}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); refresh(); showToast('Created', 'User added', 'success'); }}
          onError={(m) => showToast('Create failed', m, 'error')}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          tiers={tiers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); showToast('Updated', 'Changes saved', 'success'); }}
          onError={(m) => showToast('Save failed', m, 'error')}
        />
      )}
      {granting && (
        <GrantModal
          user={granting}
          onClose={() => setGranting(null)}
          onSaved={() => { setGranting(null); refresh(); showToast('Granted', 'Credits added', 'success'); }}
          onError={(m) => showToast('Grant failed', m, 'error')}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete user?"
        message={deleting ? `Permanently remove ${deleting.email}? This cannot be undone.` : ''}
        confirmLabel="Delete"
      />
    </div>
  );
}

function CreateUserModal({ tiers, onClose, onSaved, onError }: {
  tiers: Tier[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [tierId, setTierId] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.createUser({
        email,
        name,
        password: password || undefined,
        tier_id: tierId || undefined,
        role,
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create user');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ModalHeader onClose={onClose}>New user</ModalHeader>
      <ModalBody className="space-y-4">
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Leave blank for SSO-only accounts." />
        <Select label="Tier" value={tierId} onChange={(e) => setTierId(e.target.value)}>
          <option value="">— None —</option>
          {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </Select>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !email || !name}>{busy ? 'Saving...' : 'Create'}</Button>
      </ModalFooter>
    </Modal>
  );
}

function EditUserModal({ user, tiers, onClose, onSaved, onError }: {
  user: User;
  tiers: Tier[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [tierId, setTierId] = useState(user.tier_id ?? '');
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.updateUser(user.id, {
        name,
        tier_id: tierId || undefined,
        role,
        status,
        password: password || undefined,
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ModalHeader onClose={onClose}>Edit {user.email}</ModalHeader>
      <ModalBody className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select label="Tier" value={tierId} onChange={(e) => setTierId(e.target.value)}>
          <option value="">— None —</option>
          {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as User['role'])}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </Select>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as User['status'])}>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="killed">Killed</option>
        </Select>
        <Input label="Reset password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Leave blank to keep current password." />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button>
      </ModalFooter>
    </Modal>
  );
}

function GrantModal({ user, onClose, onSaved, onError }: {
  user: User;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [amount, setAmount] = useState('100');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const expiresAt = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
      await api.createGrant(user.id, {
        amount: Number(amount),
        reason: reason || undefined,
        expires_at: expiresAt,
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not grant');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ModalHeader onClose={onClose}>Grant credits — {user.email}</ModalHeader>
      <ModalBody className="space-y-4">
        <Input label="Amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Top-up for QA week" />
        <Input label="Expires in (days)" type="number" value={days} onChange={(e) => setDays(e.target.value)} />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !amount || !days}>{busy ? 'Saving...' : 'Grant'}</Button>
      </ModalFooter>
    </Modal>
  );
}
