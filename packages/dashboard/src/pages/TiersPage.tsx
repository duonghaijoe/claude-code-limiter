import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { LimitKind, ModelClass, Pool, Tier, TierLimit } from '../lib/types';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Input, Select } from '../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { Table } from '../components/Table';
import { ConfirmDialog } from '../components/ConfirmDialog';

type ShowToast = (title: string, msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODEL_CLASSES: ModelClass[] = ['opus', 'sonnet', 'haiku'];

function defaultLimits(): TierLimit[] {
  return [
    { id: 'session', label: 'Current session', kind: 'session', budget: 1500, window_hours: 5 },
    { id: 'weekly_all', label: 'Weekly — all models', kind: 'weekly_all', budget: 10000, reset_dow: 1, reset_hour: 0 },
  ];
}

function summarizeLimit(l: TierLimit): string {
  if (l.kind === 'session') return `session ${l.window_hours ?? 5}h: ${l.budget}`;
  if (l.kind === 'weekly_all') return `weekly all: ${l.budget}`;
  if (l.kind === 'weekly_model') return `weekly ${(l.models || []).join('+')}: ${l.budget}`;
  return `${l.kind}: ${l.budget}`;
}

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
          <p className="text-sm text-zinc-500 mt-1">Multi-limit budgets, pool allowlists, and token weights.</p>
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
                {
                  key: 'limits',
                  header: 'Limits',
                  render: (t) => (
                    <div className="text-xs text-zinc-300 space-y-0.5">
                      {(t.limits || []).length === 0 && <span className="text-zinc-500">— none —</span>}
                      {(t.limits || []).map((l) => (
                        <div key={l.id}>
                          <span className="text-zinc-400">{l.label}:</span> {summarizeLimit(l)}
                        </div>
                      ))}
                    </div>
                  ),
                },
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
  const [limits, setLimits] = useState<TierLimit[]>(
    tier && Array.isArray(tier.limits) && tier.limits.length > 0
      ? tier.limits.map((l) => ({ ...l }))
      : defaultLimits()
  );
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

  function updateLimit(idx: number, patch: Partial<TierLimit>) {
    setLimits((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function removeLimit(idx: number) {
    setLimits((prev) => prev.filter((_, i) => i !== idx));
  }

  function addLimit(kind: LimitKind) {
    if (kind === 'session') {
      setLimits((prev) => [...prev, {
        id: nextId(prev, 'session'),
        label: 'Current session',
        kind: 'session',
        budget: 1500,
        window_hours: 5,
      }]);
    } else if (kind === 'weekly_all') {
      setLimits((prev) => [...prev, {
        id: nextId(prev, 'weekly_all'),
        label: 'Weekly — all models',
        kind: 'weekly_all',
        budget: 10000,
        reset_dow: 1,
        reset_hour: 0,
      }]);
    } else {
      setLimits((prev) => [...prev, {
        id: nextId(prev, 'weekly_sonnet'),
        label: 'Weekly — Sonnet only',
        kind: 'weekly_model',
        budget: 5000,
        reset_dow: 1,
        reset_hour: 0,
        models: ['sonnet'],
      }]);
    }
  }

  async function submit() {
    if (limits.length === 0) {
      onError('Add at least one limit');
      return;
    }
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
        limits,
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

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-zinc-300">Rate limits</label>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => addLimit('session')}>+ Session</Button>
              <Button size="sm" variant="secondary" onClick={() => addLimit('weekly_all')}>+ Weekly all</Button>
              <Button size="sm" variant="secondary" onClick={() => addLimit('weekly_model')}>+ Weekly model</Button>
            </div>
          </div>
          <div className="space-y-3">
            {limits.length === 0 && (
              <div className="text-xs text-zinc-500 px-3 py-4 rounded-lg border border-zinc-800 bg-zinc-900/40">
                No limits — add at least one.
              </div>
            )}
            {limits.map((l, i) => (
              <LimitEditor
                key={i}
                limit={l}
                onChange={(patch) => updateLimit(i, patch)}
                onRemove={() => removeLimit(i)}
              />
            ))}
          </div>
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

function nextId(prev: TierLimit[], base: string): string {
  if (!prev.some((l) => l.id === base)) return base;
  let n = 2;
  while (prev.some((l) => l.id === `${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function LimitEditor({ limit, onChange, onRemove }: {
  limit: TierLimit;
  onChange: (patch: Partial<TierLimit>) => void;
  onRemove: () => void;
}) {
  function toggleModel(c: ModelClass) {
    const cur = new Set(limit.models || []);
    if (cur.has(c)) cur.delete(c); else cur.add(c);
    onChange({ models: Array.from(cur) as ModelClass[] });
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-3">
          <Input
            label="Id"
            value={limit.id}
            onChange={(e) => onChange({ id: e.target.value })}
          />
        </div>
        <div className="col-span-5">
          <Input
            label="Label"
            value={limit.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </div>
        <div className="col-span-4">
          <Select
            label="Kind"
            value={limit.kind}
            onChange={(e) => onChange({ kind: e.target.value as LimitKind })}
          >
            <option value="session">session</option>
            <option value="weekly_all">weekly_all</option>
            <option value="weekly_model">weekly_model</option>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-4">
          <Input
            label="Budget (credits)"
            type="number"
            value={String(limit.budget)}
            onChange={(e) => onChange({ budget: Number(e.target.value) || 0 })}
          />
        </div>
        {limit.kind === 'session' && (
          <div className="col-span-4">
            <Input
              label="Window hours"
              type="number"
              value={String(limit.window_hours ?? 5)}
              onChange={(e) => onChange({ window_hours: Number(e.target.value) || 1 })}
            />
          </div>
        )}
        {(limit.kind === 'weekly_all' || limit.kind === 'weekly_model') && (
          <>
            <div className="col-span-4">
              <Select
                label="Reset day (UTC)"
                value={String(limit.reset_dow ?? 1)}
                onChange={(e) => onChange({ reset_dow: Number(e.target.value) })}
              >
                {DOW_LABELS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </div>
            <div className="col-span-4">
              <Input
                label="Reset hour (UTC)"
                type="number"
                value={String(limit.reset_hour ?? 0)}
                onChange={(e) => onChange({ reset_hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
              />
            </div>
          </>
        )}
      </div>
      {limit.kind === 'weekly_model' && (
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Models in this bucket</label>
          <div className="flex items-center gap-3">
            {MODEL_CLASSES.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(limit.models || []).includes(c)}
                  onChange={() => toggleModel(c)}
                />
                {c}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="danger" onClick={onRemove}>Remove</Button>
      </div>
    </div>
  );
}
