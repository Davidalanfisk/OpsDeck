import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { FileConnection } from '../shared/model.ts';
import { isSshConnection } from '../shared/model.ts';
import { maxTransferBytes } from '../shared/files.ts';
import type { RemoteEntry, RemoteText } from '../shared/files.ts';
import { confirmFileDiscard, setFileDirty } from './file-drafts.ts';
import { describe, request, RequestError, useOps } from './state.ts';

const Monaco = lazy(() => import('./monaco.tsx').then(module => ({ default: module.Monaco })));
const join = (path: string, name: string) => `${path.replace(/\/$/, '')}/${name}`;
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

export function FileBrowser({ connection }: { connection: FileConnection }) {
  const [session, setSession] = useState('');
  const sessionRef = useRef('');
  const [path, setPath] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [file, setFile] = useState<RemoteText>();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const dirty = Boolean(file && file.content !== content);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const id = `files:${connection.id}`;
  setFileDirty(id, dirty);
  useEffect(() => {
    alive.current = true;
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      alive.current = false;
      setFileDirty(id, false);
      window.removeEventListener('beforeunload', unload);
      if (sessionRef.current) void request(`/files/${sessionRef.current}`, 'DELETE', undefined, true).catch(() => {
        useOps.getState().setError('The file connection could not be closed; it will expire after 15 minutes of inactivity.');
      });
    };
  }, [id]);
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (error) {
      if (alive.current) {
        if (error instanceof RequestError && error.status === 410) { sessionRef.current = ''; setSession(''); }
        setError(describe(error));
      }
    }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function list(target: string, key = sessionRef.current) {
    const result = await request<{ path: string; entries: RemoteEntry[] }>(`/files/${key}/list`, 'POST', { path: target });
    if (!alive.current) return;
    setPath(result.path); setPathInput(result.path);
    setEntries(result.entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name)));
  }
  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = data.get('password') || undefined;
    const allowInsecure = data.get('allowInsecure') === 'on' || undefined;
    event.currentTarget.reset();
    void run(async () => {
      const result = await request<{ session: string; path: string }>('/files/connect', 'POST', {
        clientId: connection.client_id, connectionId: connection.id, password, allowInsecure,
      });
      if (!alive.current) { await request(`/files/${result.session}`, 'DELETE'); return; }
      sessionRef.current = result.session;
      setSession(result.session);
      await list(result.path, result.session);
    });
  }
  async function open(name: string) {
    if (!confirmFileDiscard(id)) return;
    const result = await request<RemoteText>(`/files/${sessionRef.current}/read`, 'POST', { path: join(path, name) });
    if (!alive.current) return;
    setFile(result); setContent(result.content);
  }
  function save() {
    if (!file || !dirty || busyRef.current) return;
    void run(async () => {
      const result = await request<{ revision: string }>(`/files/${sessionRef.current}/save`, 'PUT', { path: file.path, content, revision: file.revision });
      if (!alive.current) return;
      setFile({ ...file, content, revision: result.revision });
      setNotice('Saved to the remote server.');
    });
  }
  async function upload(upload: File) {
    if (upload.size > maxTransferBytes) throw new Error('Transfers are limited to 10 MiB.');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1]) : reject(new Error('Could not read the selected file.'));
      reader.readAsDataURL(upload);
    });
    await request(`/files/${sessionRef.current}/upload`, 'POST', { path: join(path, upload.name), data });
    await list(path);
    setNotice('Uploaded a new file. Existing files are never overwritten by Upload.');
  }
  async function download(name: string) {
    const result = await request<{ data: string }>(`/files/${sessionRef.current}/download`, 'POST', { path: join(path, name) });
    const data = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data]));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function disconnect() {
    if (!confirmFileDiscard(id)) return;
    void run(async () => {
      await request(`/files/${sessionRef.current}`, 'DELETE');
      sessionRef.current = ''; setSession(''); setFile(undefined); setEntries([]);
    });
  }
  const agent = isSshConnection(connection) && connection.auth_method === 'agent';
  return <div className="files-panel">
    <div className="panel-toolbar">
      <span className="truncate">{connection.type === 'SSH' ? 'SFTP' : connection.type}: {connection.username}@{connection.host}:{connection.port}</span>
      {session && <>
        <button disabled={busy} onClick={() => void run(async () => {
          await request(`/files/${sessionRef.current}`, 'DELETE');
          sessionRef.current = ''; setSession('');
        })}>Reconnect</button>
        <button disabled={busy} onClick={disconnect}>Disconnect</button>
      </>}
    </div>
    {!session ? <form className="file-login" onSubmit={connect}>
      {!agent && <label>Password <input name="password" aria-label="File connection password" type="password" required autoComplete="off" maxLength={4096} /></label>}
      {agent && <p>Connect using the saved SSH agent identity.</p>}
      {file && <p>Your open file and edits are retained. Reconnect to save or reload it.</p>}
      {connection.type === 'FTP' && <label className="error"><input name="allowInsecure" type="checkbox" required /> I understand FTP sends my password and files unencrypted.</label>}
      <button className="primary" disabled={busy}>Connect files</button>
    </form> : <>
      <form className="panel-toolbar" onSubmit={event => { event.preventDefault(); void run(() => list(pathInput)); }}>
        <button type="button" disabled={busy || path === '/'} onClick={() => void run(() => list(parent(path)))}>Up</button>
        <input className="remote-path" aria-label="Remote directory" value={pathInput} onChange={event => setPathInput(event.target.value)} />
        <button disabled={busy}>Go / Refresh</button>
        <label className="upload-button">Upload new file <input aria-label="Upload new file" type="file" disabled={busy} onChange={event => {
          const uploadFile = event.target.files?.[0]; event.target.value = '';
          if (uploadFile) void run(() => upload(uploadFile));
        }} /></label>
      </form>
      <div className="files-content">
        <div className="remote-list" aria-label="Remote files">
          {entries.map(entry => <div className="remote-entry" key={entry.name}>
            <button className="truncate" disabled={busy || entry.kind === 'link'} title={entry.name} onClick={() => void run(() => entry.kind === 'directory' ? list(join(path, entry.name)) : open(entry.name))}>
              {entry.kind === 'directory' ? '[dir] ' : entry.kind === 'link' ? '[link] ' : ''}{entry.name}
            </button>
            {entry.kind === 'file' && <button disabled={busy} aria-label={`Download ${entry.name}`} onClick={() => void run(() => download(entry.name))}>↓</button>}
          </div>)}
          {!entries.length && <small>No entries in this directory.</small>}
        </div>
        <div className="remote-editor">
          {file ? <>
            <div className="panel-toolbar"><span className="truncate">{file.path}{dirty ? ' • Unsaved' : ''}</span>
              <button disabled={busy} onClick={() => { if (confirmFileDiscard(id)) void run(async () => {
                const result = await request<RemoteText>(`/files/${sessionRef.current}/read`, 'POST', { path: file.path });
                setFile(result); setContent(result.content);
              }); }}>Reload</button>
              <button className="primary" disabled={busy || !dirty} onClick={save}>Save to server</button>
              <button disabled={busy} onClick={() => { if (confirmFileDiscard(id)) setFile(undefined); }}>Close file</button>
            </div>
            <Suspense fallback={<p>Loading editor…</p>}><Monaco path={file.path} value={content} readOnly={busy} change={setContent} save={save} /></Suspense>
          </> : <div className="workspace-empty">Select a UTF-8 text file to edit. Save uploads your changes.</div>}
        </div>
      </div>
    </>}
    {busy && <small role="status">Working…</small>}
    {error && <p role="alert" className="file-message error">{error}</p>}
    {notice && <p role="status" className="file-message">{notice}</p>}
  </div>;
}
