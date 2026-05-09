import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Pool, Subscription } from '../lib/types';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Input, Select } from '../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { Table } from '../components/Table';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SubAuthTerminal } from '../components/SubAuthTerminal';

type ShowToast = (title: string, msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

export function SubscriptionsPage({ showToast }: { showToast: ShowToast }) {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Subscription | null>(null);
  const [authing, setAuthing] = useState<Subscription | null>(null);

  const poolName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pools) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? id;
  }, [pools]);

  async function refresh() {
    try {
      const [s, p] = await Promise.all([api.listSubscriptions(), api.listPools()]);
      setSubs(s.subscriptions);
      setPools(p.pools);
    } catch (err) {
      showToast('Load failed', err instanceof Error ? err.message : '', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleDelete() {
    if (!deleting) return;
    try {
      await api.deleteSubscription(deleting.id);
      showToast('Deleted', `Subscription ${deleting.pod_name} removed`, 'success');
      setDeleting(null);
      refresh();
    } catch (err) {
      showToast('Delete failed', err instanceof Error ? err.message : '', 'error');
    }
  }

  function statusBadge(sub: Subscription) {
    switch (sub.status) {
      case 'active': return <Badge variant="active">active</Badge>;
      case 'pending_auth': return <Badge variant="paused">pending auth</Badge>;
      case 'cool_down': return <Badge variant="paused">cool-down</Badge>;
      case 'disabled': return <Badge variant="killed">disabled</Badge>;
      default: return <Badge>{sub.status}</Badge>;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Subscriptions</h1>
          <p className="text-sm text-zinc-500 mt-1">One Claude subscription per pod. Authenticate via interactive setup-token.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)} disabled={!pools.length}>+ New subscription</Button>
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm text-zinc-400">{subs.length} {subs.length === 1 ? 'subscription' : 'subscriptions'}</span>
        </CardHeader>
        <CardBody flush>
          {loading ? (
            <div className="px-5 py-8 text-sm text-zinc-500">Loading...</div>
          ) : (
            <Table
              data={subs}
              keyExtractor={(s) => s.id}
              emptyMessage={pools.length === 0 ? 'Create a pool first.' : 'No subscriptions yet'}
              columns={[
                {
                  key: 'pod',
                  header: 'Pod',
                  render: (s) => (
                    <div>
                      <div className="text-zinc-100 font-medium">{s.pod_name}</div>
                      <div className="text-xs text-zinc-500 font-mono">{s.pod_endpoint}</div>
                    </div>
                  ),
                },
                { key: 'pool', header: 'Pool', render: (s) => <span className="text-zinc-300">{poolName(s.pool_id)}</span> },
                { key: 'login', header: 'Login email', render: (s) => <span className="text-zinc-300">{s.login_email}</span> },
                { key: 'status', header: 'Status', render: (s) => statusBadge(s) },
                {
                  key: 'health',
                  header: 'Health',
                  render: (s) => (
                    <span className="text-xs text-zinc-500">
                      {s.last_health ? new Date(s.last_health).toLocaleString() : '—'}
                      {s.cool_down_until && new Date(s.cool_down_until) > new Date() && (
                        <div className="text-yellow-500">cool until {new Date(s.cool_down_until).toLocaleTimeString()}</div>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (s) => (
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="primary" onClick={() => setAuthing(s)}>Authenticate</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(s)}>Delete</Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {creating && (
        <CreateSubscriptionModal
          pools={pools}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); refresh(); showToast('Created', 'Subscription added — authenticate next', 'success'); }}
          onError={(m) => showToast('Create failed', m, 'error')}
        />
      )}
      {authing && (
        <SubAuthTerminal
          subscriptionId={authing.id}
          podName={authing.pod_name}
          onClose={() => { setAuthing(null); refresh(); }}
          onAuthenticated={() => { showToast('Authenticated', `${authing.pod_name} is active`, 'success'); refresh(); }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete subscription?"
        message={deleting ? `Remove ${deleting.pod_name}? The OAuth token will be wiped.` : ''}
        confirmLabel="Delete"
      />
    </div>
  );
}

function CreateSubscriptionModal({ pools, onClose, onSaved, onError }: {
  pools: Pool[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [poolId, setPoolId] = useState(pools[0]?.id ?? '');
  const [podName, setPodName] = useState('');
  const [podEndpoint, setPodEndpoint] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.createSubscription({
        pool_id: poolId,
        pod_name: podName,
        pod_endpoint: podEndpoint,
        login_email: loginEmail,
        notes: notes || undefined,
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ModalHeader onClose={onClose}>New subscription</ModalHeader>
      <ModalBody className="space-y-4">
        <Select label="Pool" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
          {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input label="Pod name" value={podName} onChange={(e) => setPodName(e.target.value)} placeholder="sub-pod-1" autoFocus hint="Docker container name." />
        <Input label="Pod endpoint" value={podEndpoint} onChange={(e) => setPodEndpoint(e.target.value)} placeholder="http://sub-pod-1:4000" />
        <Input label="Login email" type="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="claude-acct-1@team.com" />
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !poolId || !podName || !podEndpoint || !loginEmail}>{busy ? 'Saving...' : 'Create'}</Button>
      </ModalFooter>
    </Modal>
  );
}
