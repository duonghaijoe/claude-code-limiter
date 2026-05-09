import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';

interface Props {
  subscriptionId: string;
  podName: string;
  onClose: () => void;
  onAuthenticated: () => void;
}

type Phase = 'connecting' | 'ready' | 'token' | 'saved' | 'closed' | 'error';

interface ServerFrame {
  type: 'ready' | 'data' | 'token-detected' | 'saved' | 'exit' | 'error';
  data?: string;
  error?: string;
  detail?: string;
  code?: number | null;
  subscription_id?: string;
}

export function SubAuthTerminal({ subscriptionId, podName, onClose, onAuthenticated }: Props) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [output, setOutput] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const outRef = useRef<HTMLPreElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;

    (async () => {
      try {
        const start = await api.startSubscriptionAuth(subscriptionId);
        if (cancelled) return;
        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${scheme}//${window.location.host}${start.ws_url}`);
        wsRef.current = ws;

        ws.onmessage = (ev) => {
          let frame: ServerFrame;
          try { frame = JSON.parse(ev.data); } catch { return; }
          handleFrame(frame);
        };
        ws.onerror = () => {
          if (cancelled) return;
          setPhase('error');
          setErrorText('WebSocket error');
        };
        ws.onclose = () => {
          if (cancelled) return;
          setPhase((p) => (p === 'saved' || p === 'error' ? p : 'closed'));
        };
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setErrorText(err instanceof Error ? err.message : 'Failed to mint ticket');
      }
    })();

    return () => {
      cancelled = true;
      try { ws?.close(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId]);

  function handleFrame(frame: ServerFrame) {
    switch (frame.type) {
      case 'ready':
        setPhase('ready');
        break;
      case 'data':
        if (typeof frame.data === 'string') {
          setOutput((prev) => prev + frame.data);
          requestAnimationFrame(() => {
            const el = outRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
        break;
      case 'token-detected':
        setPhase('token');
        break;
      case 'saved':
        setPhase('saved');
        onAuthenticated();
        break;
      case 'exit':
        setPhase((p) => (p === 'saved' ? p : 'closed'));
        break;
      case 'error':
        setPhase('error');
        setErrorText(`${frame.error}${frame.detail ? `: ${frame.detail}` : ''}`);
        break;
    }
  }

  function send(payload: object) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function submitInput(line: string, withNewline: boolean) {
    if (!line && !withNewline) return;
    send({ type: 'data', data: withNewline ? line + '\n' : line });
    setInput('');
    inputRef.current?.focus();
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitInput(input, true);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      send({ type: 'data', data: '' });
    }
  }

  const phaseLabel: Record<Phase, string> = {
    connecting: 'Connecting...',
    ready: 'Connected — paste your subscription credentials',
    token: 'Token detected, persisting...',
    saved: 'Token saved — subscription is active',
    closed: 'Session ended',
    error: errorText ?? 'Error',
  };

  const phaseColor: Record<Phase, string> = {
    connecting: 'text-zinc-400',
    ready: 'text-blue-400',
    token: 'text-yellow-400',
    saved: 'text-green-400',
    closed: 'text-zinc-500',
    error: 'text-red-400',
  };

  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader onClose={onClose}>Authenticate {podName}</ModalHeader>
      <ModalBody className="space-y-3">
        <div className={`text-xs font-medium ${phaseColor[phase]}`}>{phaseLabel[phase]}</div>
        <pre
          ref={outRef}
          className="h-80 overflow-auto rounded-lg border border-zinc-800 bg-black/60 p-3 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words"
        >
          {output || (phase === 'connecting' ? 'Opening exec...\n' : '')}
        </pre>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={phase !== 'ready' && phase !== 'token'}
            placeholder="Type and press Enter"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-40"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => submitInput(input, true)}
            disabled={phase !== 'ready' && phase !== 'token'}
          >
            Send
          </Button>
        </div>
        <p className="text-[11px] text-zinc-500">
          Run <code>claude setup-token</code> inside the pod and follow the prompts. The OAuth token (sk-ant-oat-...) is captured automatically.
        </p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}
