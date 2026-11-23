import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SshConnection } from '../shared/model.ts';
import { registerAgentTerminal } from './agent-sessions.ts';
import { notifyCredentialChange, useConnectionCredentials } from './connection-credentials.ts';
import { describe, request } from './state.ts';
import '@xterm/xterm/css/xterm.css';

export function SshTerminal({ connection }: { connection: SshConnection }) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const socket = useRef<WebSocket>(null);
  const connected = useRef(false);
  const [status, setStatus] = useState('Disconnected');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const { credential, credentialError } = useConnectionCredentials(connection.client_id, connection.id);
  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    const term = new Terminal({
      cursorBlink: true, scrollback: 10000, fontSize: 13,
      theme: { background: '#0d111a', foreground: '#e3e7f2', cursor: '#a892ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    const unregister = registerAgentTerminal(connection.id, {
      read: () => {
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let i = Math.max(0, buffer.length - 100); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        return lines.join('\n').slice(-12000);
      },
      send: command => {
        if (!connected.current || socket.current?.readyState !== WebSocket.OPEN) throw new Error('The SSH terminal is not connected.');
        socket.current.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
      },
    });
    term.writeln(connection.auth_method === 'agent' ? 'OpsDeck SSH — connect using the selected agent identity.' : 'OpsDeck SSH — enter a password or use a saved password to connect.');
    const send = (data: object) => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(data));
    };
    const sized = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const typed = term.onData(data => {
      if (socket.current?.readyState !== WebSocket.OPEN) return;
      for (let offset = 0; offset < data.length;) {
        let end = offset + 8000;
        if (/[\uD800-\uDBFF]/.test(data[end - 1] ?? '') && end < data.length) end--;
        send({ type: 'input', data: data.slice(offset, end) });
        offset = end;
      }
    });
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    });
    observer.observe(element);
    return () => {
      const ws = socket.current;
      unregister();
      connected.current = false;
      socket.current = null;
      ws?.close();
      terminal.current = null;
      observer.disconnect();
      sized.dispose();
      typed.dispose();
      term.dispose();
    };
  }, []);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = terminal.current;
    if (!term || socket.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const enteredPassword = connection.auth_method === 'password' ? password || undefined : undefined;
    const remember = data.get('remember') === 'on' || undefined;
    form.reset();
    setPassword('');
    setBusy(true);
    setStatus('Connecting…');
    let failed = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ssh/${connection.client_id}/${connection.id}`);
    socket.current = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', password: enteredPassword, remember, cols: term.cols, rows: term.rows }));
    ws.onmessage = event => {
      if (socket.current !== ws) return;
      if (event.data instanceof ArrayBuffer) { term.write(new Uint8Array(event.data)); return; }
      const data = JSON.parse(event.data);
      if (data.state === 'connected') { connected.current = true; setStatus('Connected'); if (remember) notifyCredentialChange(); term.focus(); }
      if (data.state === 'error') { failed = true; setStatus(data.detail); term.writeln(`\r\n${data.detail}`); }
    };
    ws.onerror = () => {
      if (socket.current !== ws) return;
      failed = true;
      setStatus('Connection unavailable');
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      connected.current = false;
      setBusy(false);
      if (!failed) setStatus('Disconnected');
      term.writeln('\r\n[SSH session closed]');
    };
  }

  return <div className="terminal-panel">
    <div className="terminal-body" ref={mount} />
    <form className="panel-toolbar terminal-login" onSubmit={connect}>
      <span className="truncate terminal-status" title={`${connection.username}@${connection.host}:${connection.port}`}>
        {connection.username}@{connection.host}:{connection.port} · <span role="status">{status}</span>
      </span>
      {busy ? <button type="button" onClick={() => socket.current?.close()}>Disconnect</button> : <>
        {connection.auth_method === 'password' && <>
          <input aria-label="SSH password" type="password" name="password" placeholder={credential?.saved && credential.available ? 'Saved password (optional)' : 'SSH password'} required={!credential?.saved || !credential.available} value={password} onChange={event => setPassword(event.target.value)} maxLength={4096} autoComplete="off" />
          {credential?.available && <label><input type="checkbox" name="remember" disabled={!password} /> Save password securely</label>}
          {credential && !credential.available && <span>Secure password storage unavailable.</span>}
        </>}
        {credential?.stored && <button type="button" onClick={() => {
          setBusy(true);
          void request('/files/credentials', 'DELETE', { clientId: connection.client_id, connectionId: connection.id })
            .then(() => { notifyCredentialChange(); setStatus('Saved password removed'); })
            .catch(error => setStatus(describe(error)))
            .finally(() => setBusy(false));
        }}>Forget saved password</button>}
        <button className="primary">Connect</button>
      </>}
    </form>
    {credentialError && <p role="alert" className="error">{credentialError}</p>}
  </div>;
}
