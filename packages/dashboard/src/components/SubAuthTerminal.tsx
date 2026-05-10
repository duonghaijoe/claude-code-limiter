import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
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
  const [errorText, setErrorText] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#60a5fa',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    if (containerRef.current) {
      term.open(containerRef.current);
      try { fit.fit(); } catch { /* container not measured yet */ }
    }

    term.writeln('\x1b[90mOpening exec...\x1b[0m');

    // Forward keystrokes to the WS as raw bytes — xterm already maps Enter,
    // Ctrl+C, arrows, paste, etc. into the right escape sequences.
    const dataDisp = term.onData((data) => {
      const w = wsRef.current;
      if (!w || w.readyState !== w.OPEN) return;
      w.send(JSON.stringify({ type: 'data', data }));
    });

    const onResize = () => {
      try {
        fit.fit();
        const w = wsRef.current;
        if (w && w.readyState === w.OPEN) {
          w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('resize', onResize);

    (async () => {
      try {
        const start = await api.startSubscriptionAuth(subscriptionId);
        if (cancelled) return;
        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${scheme}//${window.location.host}${start.ws_url}`);
        wsRef.current = ws;

        ws.onopen = () => {
          // Push initial size to the pty so output wraps to our viewport.
          try {
            ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          } catch { /* ignore */ }
        };

        ws.onmessage = (ev) => {
          let frame: ServerFrame;
          try { frame = JSON.parse(ev.data); } catch { return; }
          handleFrame(frame, term);
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

    // Refit shortly after mount once the modal animates in.
    const fitTimer = window.setTimeout(() => {
      try { fit.fit(); } catch { /* ignore */ }
      term.focus();
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(fitTimer);
      window.removeEventListener('resize', onResize);
      try { dataDisp.dispose(); } catch { /* ignore */ }
      try { ws?.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId]);

  function handleFrame(frame: ServerFrame, term: Terminal) {
    switch (frame.type) {
      case 'ready':
        setPhase('ready');
        break;
      case 'data':
        if (typeof frame.data === 'string') term.write(frame.data);
        break;
      case 'token-detected':
        setPhase('token');
        break;
      case 'saved':
        setPhase('saved');
        term.writeln('\r\n\x1b[32m✓ Token saved — subscription is active.\x1b[0m');
        onAuthenticated();
        break;
      case 'exit':
        setPhase((p) => (p === 'saved' ? p : 'closed'));
        if (typeof frame.code === 'number') {
          term.writeln(`\r\n\x1b[90m[exec exited with code ${frame.code}]\x1b[0m`);
        }
        break;
      case 'error':
        setPhase('error');
        setErrorText(`${frame.error}${frame.detail ? `: ${frame.detail}` : ''}`);
        term.writeln(`\r\n\x1b[31m[error] ${frame.error}${frame.detail ? `: ${frame.detail}` : ''}\x1b[0m`);
        break;
    }
  }

  const phaseLabel: Record<Phase, string> = {
    connecting: 'Connecting...',
    ready: 'Connected — type into the terminal',
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
        <div
          ref={containerRef}
          className="h-96 rounded-lg border border-zinc-800 bg-black/80 p-2 overflow-hidden"
          onClick={() => termRef.current?.focus()}
        />
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
