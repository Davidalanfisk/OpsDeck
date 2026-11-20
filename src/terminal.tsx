import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Connection } from '../shared/model.ts';
import '@xterm/xterm/css/xterm.css';

export function SshTerminal({ connection }: { connection: Extract<Connection, { type: 'SSH' }> }) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const socket = useRef<WebSocket>(null);
  const [status, setStatus] = useState('Disconnected');
  const [busy, setBusy] = useState(false);
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
    term.writeln(connection.auth_method === 'agent' ? 'OpsDeck SSH — connect using the selected agent identity.' : 'OpsDeck SSH — enter your password to connect.');
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
    const password = connection.auth_method === 'password' ? String(new FormData(form).get('password')) : undefined;
    form.reset();
    setBusy(true);
    setStatus('Connecting…');
    let failed = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ssh/${connection.client_id}/${connection.id}`);
    socket.current = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', password, cols: term.cols, rows: term.rows }));
    ws.onmessage = event => {
      if (socket.current !== ws) return;
      if (event.data instanceof ArrayBuffer) { term.write(new Uint8Array(event.data)); return; }
      const data = JSON.parse(event.data);
      if (data.state === 'connected') { setStatus('Connected'); term.focus(); }
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
      setBusy(false);
      if (!failed) setStatus('Disconnected');
      term.writeln('\r\n[SSH session closed]');
    };
  }

  return <div className="terminal-panel">
    <div className="panel-toolbar">
      <span className="truncate">{connection.username}@{connection.host}:{connection.port}</span>
      <span role="status" className="terminal-status">{status}</span>
    </div>
    <div className="terminal-body" ref={mount} />
    <form className="panel-toolbar terminal-login" onSubmit={connect}>
      {busy ? <button type="button" onClick={() => socket.current?.close()}>Disconnect</button> : <>
        {connection.auth_method === 'password' && <input aria-label="SSH password" type="password" name="password" placeholder="SSH password" required maxLength={4096} autoComplete="off" />}
        <button className="primary">Connect</button>
      </>}
    </form>
  </div>;
}
