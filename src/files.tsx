import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { FileConnection } from '../shared/model.ts';
import { isSshConnection } from '../shared/model.ts';
import { maxTransferBytes } from '../shared/files.ts';
import type { RemoteEntry, RemoteText } from '../shared/files.ts';
import { confirmFileDiscard, setFileDirty } from './file-drafts.ts';
import { describe, request, RequestError, useOps } from './state.ts';
import { Icon } from './icons.tsx';
import { registerAgentFiles } from './agent-sessions.ts';

const Monaco = lazy(() => import('./monaco.tsx').then(module => ({ default: module.Monaco })));
const join = (path: string, name: string) => `${path.replace(/\/$/, '')}/${name}`;
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
type OpenFile = RemoteText & { draft: string };
const isDirty = (file: OpenFile) => file.content !== file.draft;
const confirmTabDiscard = (file: OpenFile) => !isDirty(file) || window.confirm(`Discard unsaved edits to ${file.path}?`);

export function FileBrowser({ connection }: { connection: FileConnection }) {
  const [session, setSession] = useState('');
  const sessionRef = useRef('');
  const [path, setPath] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const file = files.find(item => item.path === activePath);
  const dirty = files.some(isDirty);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!session) return;
    return registerAgentFiles(connection.id, { session, openPaths: new Set(files.map(item => item.path)) });
  }, [connection.id, session, files]);
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
    const target = join(path, name);
    if (files.some(item => item.path === target)) { setActivePath(target); return; }
    const result = await request<RemoteText>(`/files/${sessionRef.current}/read`, 'POST', { path: target });
    if (!alive.current) return;
    setFiles(previous => [...previous, { ...result, draft: result.content }]);
    setActivePath(result.path);
  }
  function save() {
    if (!file || !isDirty(file) || busyRef.current) return;
    void run(async () => {
      const result = await request<{ revision: string }>(`/files/${sessionRef.current}/save`, 'PUT', { path: file.path, content: file.draft, revision: file.revision });
      if (!alive.current) return;
      setFiles(previous => previous.map(item => item.path === file.path
        ? { ...item, content: file.draft, revision: result.revision } : item));
      setNotice('Saved to the remote server.');
    });
  }
  function closeFile(target: OpenFile) {
    if (!confirmTabDiscard(target)) return;
    const remaining = files.filter(item => item.path !== target.path);
    setFiles(remaining);
    if (activePath === target.path) setActivePath(remaining.at(-1)?.path ?? '');
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
      sessionRef.current = ''; setSession(''); setFiles([]); setActivePath(''); setEntries([]);
    });
  }
  const agent = isSshConnection(connection) && connection.auth_method === 'agent';
  return <div className="files-panel">
    {!session ? <form className="file-login" onSubmit={connect}>
      <span className="muted">{connection.type === 'SSH' ? 'SFTP' : connection.type}: {connection.username}@{connection.host}:{connection.port}</span>
      {!agent && <label>Password <input name="password" aria-label="File connection password" type="password" required autoComplete="off" maxLength={4096} /></label>}
      {agent && <p>Connect using the saved SSH agent identity.</p>}
      {files.length > 0 && <p>Your open files and edits are retained. Reconnect to save or reload them.</p>}
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
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await request(`/files/${sessionRef.current}`, 'DELETE');
          sessionRef.current = ''; setSession('');
        })}>Reconnect</button>
        <button type="button" disabled={busy} onClick={disconnect}>Disconnect</button>
      </form>
      <div className="files-content">
        <div className="remote-list" aria-label="Remote files">
          {entries.map(entry => <div className="remote-entry" key={entry.name}>
            <button className={`remote-entry-name ${entry.kind}`} disabled={busy || entry.kind === 'link'} title={entry.kind === 'link' ? `${entry.name} (symbolic link)` : entry.name} onClick={() => void run(() => entry.kind === 'directory' ? list(join(path, entry.name)) : open(entry.name))}>
              <Icon name={entry.kind === 'directory' ? 'folder' : entry.kind === 'link' ? 'link' : 'file'} />
              <span className="truncate">{entry.name}</span>
            </button>
            {entry.kind === 'file' && <button className="file-icon-button" disabled={busy} title={`Download ${entry.name}`} aria-label={`Download ${entry.name}`} onClick={() => void run(() => download(entry.name))}><Icon name="download" /></button>}
          </div>)}
          {!entries.length && <small>No entries in this directory.</small>}
        </div>
        <div className="remote-editor">
          {file ? <>
            <div className="file-tabs" role="tablist" aria-label="Open remote files">
              {files.map(item => <div className={`file-tab ${item.path === activePath ? 'active' : ''}`} key={item.path}>
                <button role="tab" aria-selected={item.path === activePath} title={item.path} disabled={busy}
                  onClick={() => setActivePath(item.path)}>
                  <Icon name="file" /><span className="truncate">{item.path.split('/').pop()}</span>
                  {isDirty(item) && <span className="dirty-indicator" aria-label="Unsaved">●</span>}
                </button>
                <button className="file-tab-close" disabled={busy} aria-label={`Close ${item.path}`} title={`Close ${item.path}`} onClick={() => closeFile(item)}><Icon name="close" /></button>
              </div>)}
            </div>
            <div className="panel-toolbar"><span className="truncate">{file.path}{isDirty(file) ? ' • Unsaved' : ''}</span>
              <button disabled={busy} onClick={() => { if (confirmTabDiscard(file)) void run(async () => {
                const result = await request<RemoteText>(`/files/${sessionRef.current}/read`, 'POST', { path: file.path });
                if (alive.current) setFiles(previous => previous.map(item => item.path === file.path ? { ...result, draft: result.content } : item));
              }); }}>Reload</button>
              <button className="primary" disabled={busy || !isDirty(file)} onClick={save}>Save to server</button>
            </div>
            {files.map(item => <div className="file-editor-host" key={item.path} hidden={item.path !== activePath}>
              <Suspense fallback={<p>Loading editor…</p>}><Monaco path={item.path} value={item.draft} readOnly={busy}
                change={draft => setFiles(previous => previous.map(openFile => openFile.path === item.path ? { ...openFile, draft } : openFile))}
                save={item.path === activePath ? save : () => {}} /></Suspense>
            </div>)}
          </> : <div className="workspace-empty">Select a UTF-8 text file to edit. Save uploads your changes.</div>}
        </div>
      </div>
    </>}
    {busy && <small role="status">Working…</small>}
    {error && <p role="alert" className="file-message error">{error}</p>}
    {notice && <p role="status" className="file-message">{notice}</p>}
  </div>;
}
