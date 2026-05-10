import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Pool, Tier, WindowType } from '../lib/types';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Input, Select } from '../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { Table } from '../components/Table';
import { ConfirmDialog } from '../components/ConfirmDialog';

type ShowToast = (title: string, msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

export function TiersPage({ showToast }: { showToast: ShowToast }) {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Tier | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Tier | null>(null);

  const poolName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pools) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? id;
  }, [pools]);

  async function refresh() {
    try {
      const [t, p] = await Promise.all([api.listTiers(), api.listPools()]);
      setTiers(t.tiers);
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
      await api.deleteTier(deleting.id);
      showToast('Deleted', `Tier ${deleting.name} removed`, 'success');
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
          <h1 className="text-2xl font-semibold text-zinc-100">Tiers</h1>
          <p className="text-sm text-zinc-500 mt-1">Credit budgets, pool allowlists, and token weights.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>+ New tier</Button>
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm text-zinc-400">{tiers.length} {tiers.length === 1 ? 'tier' : 'tiers'}</span>
        </CardHeader>
        <CardBody flush>
          {loading ? (
            <div className="px-5 py-8 text-sm text-zinc-500">Loading...</div>
          ) : (
            <Table
              data={tiers}
              keyExtractor={(t) => t.id}
              emptyMessage="No tiers configured"
              columns={[
                { key: 'name', header: 'Name', render: (t) => <span className="text-zinc-100 font-medium">{t.name}</span> },
                { key: 'budget', header: 'Budget', render: (t) => <span className="text-zinc-300">{(Number(t.credit_budget) || 0).toFixed(0)}</span> },
                { key: 'window', header: 'Window', render: (t) => <span className="text-zinc-400">{t.window_type}</span> },
                {
                  key: 'pools',
                  header: 'Pools',
                  render: (t) => (
                    <div className="text-xs text-zinc-400 space-y-0.5">
                      <div>allowed: {t.allowed_pools.length ? t.allowed_pools.map(poolName).join(', ') : '—'}</div>
                      <div>failover: {t.failover_pools.length ? t.failover_pools.map(poolName).join(', ') : '—'}</div>
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (t) => (
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(t)}>Edit</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(t)}>Delete</Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {(creating || editing) && (
        <TierModal
          tier={editing}
          pools={pools}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refresh();
            showToast(editing ? 'Updated' : 'Created', 'Tier saved', 'success');
          }}
          onError={(m) => showToast('Save failed', m, 'error')}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete tier?"
        message={deleting ? `Remove tier "${deleting.name}"? Users assigned to it will lose access until reassigned.` : ''}
        confirmLabel="Delete"
      />
    </div>
  );
}

function TierModal({ tier, pools, onClose, onSaved, onError }: {
  tier: Tier | null;
  pools: Pool[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(tier?.name ?? '');
  const [budget, setBudget] = useState(String(tier?.credit_budget ?? 1000));
  const [windowType, setWindowType] = useState<WindowType>(tier?.window_type ?? 'monthly');
  const [allowed, setAllowed] = useState<string[]>(tier?.allowed_pools ?? []);
  const [failover, setFailover] = useState<string[]>(tier?.failover_pools ?? []);
  const [weightsJson, setWeightsJson] = useState(JSON.stringify(tier?.credit_weights ?? {
    per_input_token: 0.001,
    per_output_token: 0.005,
    per_cache_read_token: 0.0001,
    per_cache_create_token: 0.001,
  }, null, 2));
  const [busy, setBusy] = useState(false);

  function togglePool(poolId: string, list: string[], setList: (l: string[]) => void) {
    setList(list.includes(poolId) ? list.filter((x) => x !== poolId) : [...list, poolId]);
  }

  async function submit() {
    let weights: Record<string, number>;
    try {
      weights = JSON.parse(weightsJson);
    } catch {
      onError('Credit weights must be valid JSON');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name,
        credit_budget: Number(budget),
        window_type: windowType,
        allowed_pools: allowed,
        failover_pools: failover,
        credit_weights: weights,
      };
      if (tier) await api.updateTier(tier.id, body);
      else await api.createTier(body);
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save tier');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader onClose={onClose}>{tier ? `Edit ${tier.name}` : 'New tier'}</ModalHeader>
      <ModalBody className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Credit budget" type="number" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <Select label="Window" value={windowType} onChange={(e) => setWindowType(e.target.value as WindowType)}>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
            <option value="sliding_24h">sliding_24h</option>
          </Select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Allowed pools (in priority order)</label>
          <div className="space-y-1.5 max-h-40 overflow-y-auto rounded-lg border border-zinc-800 p-3 bg-zinc-900/40">
            {pools.length === 0 && <div className="text-xs text-zinc-500">No pools yet — create one first.</div>}
            {pools.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowed.includes(p.id)}
                  onChange={() => togglePool(p.id, allowed, setAllowed)}
                />
                {p.name} <span className="text-xs text-zinc-500">({p.plan})</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Failover pools</label>
          <div className="space-y-1.5 max-h-40 overflow-y-auto rounded-lg border border-zinc-800 p-3 bg-zinc-900/40">
            {pools.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={failover.includes(p.id)}
                  onChange={() => togglePool(p.id, failover, setFailover)}
                />
                {p.name} <span className="text-xs text-zinc-500">({p.plan})</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Credit weights (JSON)</label>
          <textarea
            value={weightsJson}
            onChange={(e) => setWeightsJson(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <p className="text-xs text-zinc-500 mt-1">Snapshot of these weights is frozen on each usage event.</p>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !name}>{busy ? 'Saving...' : tier ? 'Save' : 'Create'}</Button>
      </ModalFooter>
    </Modal>
  );
}
