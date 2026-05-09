import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AdminEvent } from '../lib/types';
import { Card, CardBody, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';

const TYPE_COLOR: Record<string, 'active' | 'paused' | 'killed' | 'model' | 'default'> = {
  usage: 'model',
  cool_down: 'paused',
  block: 'killed',
  grant: 'active',
};

export function EventsPage() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(50);

  async function refresh() {
    setLoading(true);
    try {
      const { events } = await api.listEvents({ limit });
      setEvents(events);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [limit]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Events</h1>
          <p className="text-sm text-zinc-500 mt-1">Recent session and subscription activity.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-2 py-1 text-sm text-zinc-100"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
          </select>
          <Button size="sm" variant="secondary" onClick={refresh}>Refresh</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm text-zinc-400">{events.length} events</span>
        </CardHeader>
        <CardBody flush>
          {loading ? (
            <div className="px-5 py-8 text-sm text-zinc-500">Loading...</div>
          ) : events.length === 0 ? (
            <div className="px-5 py-8 text-sm text-zinc-500">No events yet.</div>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {events.map((e) => (
                <div key={e.id} className="px-5 py-3 flex items-start gap-3">
                  <Badge variant={TYPE_COLOR[e.type] ?? 'default'}>{e.type}</Badge>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-500">
                      {new Date(e.created_at).toLocaleString()}
                      {e.user_id && <span className="ml-2 font-mono">user {e.user_id.slice(0, 8)}</span>}
                      {e.subscription_id && <span className="ml-2 font-mono">sub {e.subscription_id.slice(0, 8)}</span>}
                      {e.session_id && <span className="ml-2 font-mono">session {e.session_id.slice(0, 8)}</span>}
                    </div>
                    {e.detail && (
                      <pre className="mt-1 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
                        {JSON.stringify(e.detail, null, 0)}
                      </pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
