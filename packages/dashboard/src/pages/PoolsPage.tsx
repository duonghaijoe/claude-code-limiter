import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Pool } from '../lib/types';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { Table } from '../components/Table';
import { ConfirmDialog } from '../components/ConfirmDialog';

type ShowToast = (title: string, msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

export function PoolsPage({ showToast }: { showToast: ShowToast }) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Pool | null>(null);

  async function refresh() {
    try {
      const { pools } = await api.listPools();
      setPools(pools);
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
      await api.deletePool(deleting.id);
      showToast('Deleted', `Pool ${deleting.name} removed`, 'success');
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
          <h1 className="text-2xl font-semibold text-zinc-100">Pools</h1>
          <p className="text-sm text-zinc-500 mt-1">Groups of subscriptions that share the same plan.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>+ New pool</Button>
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm text-zinc-400">{pools.length} {pools.length === 1 ? 'pool' : 'pools'}</span>
        </CardHeader>
        <CardBody flush>
          {loading ? (
            <div className="px-5 py-8 text-sm text-zinc-500">Loading...</div>
          ) : (
            <Table
              data={pools}
              keyExtractor={(p) => p.id}
              emptyMessage="No pools yet"
              columns={[
                { key: 'name', header: 'Name', render: (p) => <span className="text-zinc-100 font-medium">{p.name}</span> },
                { key: 'plan', header: 'Plan', render: (p) => <span className="text-zinc-300">{p.plan}</span> },
                { key: 'id', header: 'ID', render: (p) => <span className="text-xs text-zinc-500 font-mono">{p.id}</span> },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (p) => (
                    <Button size="sm" variant="danger" onClick={() => setDeleting(p)}>Delete</Button>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {creating && (
        <CreatePoolModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); refresh(); showToast('Created', 'Pool added', 'success'); }}
          onError={(m) => showToast('Create failed', m, 'error')}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete pool?"
        message={deleting ? `Remove pool "${deleting.name}"? Associated subscriptions will be orphaned.` : ''}
        confirmLabel="Delete"
      />
    </div>
  );
}

function CreatePoolModal({ onClose, onSaved, onError }: {
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('claude_max');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.createPool({ name, plan });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create pool');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ModalHeader onClose={onClose}>New pool</ModalHeader>
      <ModalBody className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="qa-max-pool" autoFocus />
        <Input label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="claude_max" hint="Free-form label, e.g. claude_pro, claude_max." />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !name || !plan}>{busy ? 'Saving...' : 'Create'}</Button>
      </ModalFooter>
    </Modal>
  );
}
