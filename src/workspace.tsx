import { useCallback, useEffect, useRef, useState } from 'react';
import { DockviewDefaultTab, DockviewReact } from 'dockview';
import type { DockviewApi, DockviewReadyEvent, IDockviewHeaderActionsProps, IDockviewPanelHeaderProps, SerializedDockview } from 'dockview';
import { isFileConnection } from '../shared/model.ts';
import type { Connection, Deck, Note, Workspace } from '../shared/model.ts';
import { ConnectionEditor, NamedEditor } from './editors.tsx';
import { flushNote, panels } from './panels.tsx';
import { describe, readLocal, refreshDeck, request, useOps, writeLocal } from './state.ts';
import { confirmFileDiscard } from './file-drafts.ts';
import { Icon } from './icons.tsx';
import 'dockview/dist/styles/dockview.css';

type Snapshot = { saved: SerializedDockview; raw: string };
type Editor = { kind: 'connection'; item?: Connection } | { kind: 'note'; item?: Note } | { kind: 'workspace' };
const connectionPanel = (connection: Connection) => connection.type === 'SSH' ? 'terminal' : isFileConnection(connection) ? 'files' : 'link';
function SafeTab(props: IDockviewPanelHeaderProps) {
  const [title, setTitle] = useState(props.api.title ?? 'pane');
  const middle = useRef(false);
  useEffect(() => {
    const listener = props.api.onDidTitleChange(event => setTitle(event.title));
    return () => listener.dispose();
  }, [props.api]);
  const connection = useOps(state => state.deck?.connections.find(item => item.id === props.params.itemId));
  const icon = props.api.id.startsWith('files:') ? 'folder' : connection
    ? connection.type === 'SSH' ? 'terminal' : isFileConnection(connection) ? 'folder' : 'window' : 'note';
  const close = () => { if (confirmFileDiscard(props.api.id)) props.api.close(); };
  return <div className="window-tab"><Icon name={icon} /><DockviewDefaultTab {...props} hideClose
    onPointerDown={event => { middle.current = event.button === 1; }}
    onPointerLeave={() => { middle.current = false; }}
    onPointerUp={event => { if (middle.current && event.button === 1) close(); middle.current = false; }} />
    <button className="window-control window-close" type="button" aria-label={`Close ${title}`} title={`Close ${title}`}
      onPointerDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); close(); }}><Icon name="close" /></button>
  </div>;
}

function WindowActions({ api, containerApi }: IDockviewHeaderActionsProps) {
  const [maximized, setMaximized] = useState(api.isMaximized());
  useEffect(() => {
    const listener = containerApi.onDidMaximizedGroupChange(() => setMaximized(api.isMaximized()));
    return () => listener.dispose();
  }, [api, containerApi]);
  return <div className="window-actions"><button type="button" className="window-control"
    aria-label={maximized ? 'Restore pane' : 'Maximize pane'} title={maximized ? 'Restore pane' : 'Maximize pane'}
    onClick={() => maximized ? api.exitMaximized() : api.maximize()}>
    <Icon name={maximized ? 'restore' : 'maximize'} />
  </button></div>;
}

function restore(dock: DockviewApi, layout: unknown) {
  if (!layout || typeof layout !== 'object' || !('grid' in layout) || !('panels' in layout)) {
    throw new Error('Invalid Dockview layout');
  }
  dock.fromJSON(layout as SerializedDockview);
}

function Empty() {
  return <div className="workspace-empty">
    <span className="empty-icon">⊞</span>
    <h2>Your workspace is clear</h2>
    <p>Open a connection or note to start. Drag tabs to dock them and drag dividers to resize.</p>
  </div>;
}

export function WorkspaceView({ deck, workspace }: { deck: Deck; workspace: Workspace }) {
  const { client, notes, connections, workspaces } = deck;
  const navigate = useOps(state => state.navigate);
  const [editor, setEditor] = useState<Editor>();
  const [filter, setFilter] = useState('');
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState('Restoring…');
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [dock, setDock] = useState<DockviewApi>();
  const latest = useRef<Snapshot>(undefined);
  const base = `/clients/${client.id}`;
  const path = `${base}/workspaces/${workspace.id}`;
  const key = `workspace:${workspace.id}`;
  const onReady = useCallback(({ api }: DockviewReadyEvent) => setDock(api), []);

  useEffect(() => {
    if (!dock) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sync = Promise.resolve();
    let pending = false;
    let restoring = true;
    const setError = useOps.getState().setError;
    function flush() {
      clearTimeout(timer);
      if (!pending || !latest.current) return;
      pending = false;
      const { saved, raw } = latest.current;
      sync = sync.then(async () => {
        await request(`${path}/session`, 'PUT', saved, raw.length < 14_000);
        if (active && latest.current?.raw === raw) setSaveState('Session synced');
      }).catch(error => {
        if (active && latest.current?.raw === raw) {
          pending = true;
          setSaveState('Session sync failed');
          setError(`Layout could not sync: ${describe(error)}`);
        }
      });
    }
    function capture() {
      if (!active || restoring || !dock) return;
      const saved = dock.toJSON();
      const raw = JSON.stringify(saved);
      if (latest.current?.raw === raw) return;
      latest.current = { saved, raw };
      setSaveState(writeLocal(key, saved) ? 'Saved on this browser' : 'Syncing…');
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    }
    const layoutListener = dock.onDidLayoutChange(capture);
    const tabListener = dock.onDidActivePanelChange(() => queueMicrotask(capture));
    const pagehide = () => { capture(); flush(); };
    window.addEventListener('pagehide', pagehide);
    const cached = readLocal<SerializedDockview>(key);
    void (async () => {
      let snapshot = cached;
      if (!snapshot) {
        try { snapshot = await request<SerializedDockview | null>(`${path}/session`) ?? undefined; }
        catch (error) { if (active) setError(`Could not load the last session: ${describe(error)}`); }
      }
      if (!active) return;
      try {
        const layout = snapshot ?? workspace.layout;
        if (layout) restore(dock, layout);
      } catch {
        dock.clear();
        writeLocal(key, undefined);
        setError('The previous layout could not be restored. An empty workspace was opened.');
      }
      restoring = false;
      setReady(true);
      capture();
    })();
    return () => {
      active = false;
      layoutListener.dispose();
      tabListener.dispose();
      window.removeEventListener('pagehide', pagehide);
      flush();
    };
  }, [dock, path, key]);

  function openPanel(item: Connection | Note, files = false) {
    if (!dock || !ready) return;
    const kind = 'title' in item ? 'note' : files ? 'files' : connectionPanel(item);
    const id = `${kind === 'files' ? 'files' : 'item'}:${item.id}`;
    const existing = dock.getPanel(id);
    if (existing) { existing.api.setActive(); return; }
    dock.addPanel({
      id, component: kind, title: 'title' in item ? item.title : item.name,
      params: { itemId: item.id }, renderer: 'always',
    });
  }

  const closeEditor = () => setEditor(undefined);
  const closePanel = (id: string) => { dock?.getPanel(`item:${id}`)?.api.close(); dock?.getPanel(`files:${id}`)?.api.close(); };
  const q = filter.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(q);
  const setError = useOps.getState().setError;

  return <div className="workspace-page">
    <div className="workspace-bar">
      <button onClick={() => navigate({})}>‹ Clients</button>
      <span className="dot" style={{ backgroundColor: client.colour }} />
      <strong className="truncate">{client.name}</strong>
      <select aria-label="Workspace" value={workspace.id}
        onChange={event => navigate({ clientId: client.id, workspaceId: event.target.value })}>
        {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button onClick={() => setEditor({ kind: 'workspace' })}>+ Workspace</button>
      <span className="spacer" />
      <span className="sync-state" role="status">{saveState}</span>
      <button disabled={!ready || !workspace.layout} onClick={() => {
        if (!dock || !workspace.layout || !confirmFileDiscard()) return;
        try { restore(dock, workspace.layout); }
        catch (error) { setError(`Saved layout could not be loaded: ${describe(error)}`); }
      }}>Load layout</button>
      <button className="primary" disabled={!ready} onClick={async () => {
        if (!dock) return;
        try {
          await request(path, 'PUT', dock.toJSON());
          await refreshDeck(client.id);
          setSaveState('Named layout saved');
        } catch (error) { setError(describe(error)); }
      }}>Save layout</button>
    </div>
    <div className="workspace-main">
      <aside className={`library ${libraryOpen ? '' : 'collapsed'}`} aria-label="Workspace library">
        <button className="library-toggle" onClick={() => setLibraryOpen(!libraryOpen)} aria-expanded={libraryOpen}
          aria-label={libraryOpen ? 'Collapse library' : 'Expand library'}>{libraryOpen ? 'Library ‹' : '›'}</button>
        {libraryOpen && <div className="library-content">
          <input type="search" aria-label="Find connections and notes" placeholder="Find items…" value={filter}
            onChange={event => setFilter(event.target.value)} />
          <div className="library-heading"><h2>Connections</h2><button aria-label="Add connection" onClick={() => setEditor({ kind: 'connection' })}>+</button></div>
          {connections.filter(item => matches(`${item.name} ${item.type}`)).map(item =>
            <Item key={item.id} name={item.name} detail={item.type} disabled={!ready}
              open={() => openPanel(item)} edit={() => setEditor({ kind: 'connection', item })} />)}
          {connections.filter(item => item.type === 'SSH' && matches(`${item.name} ${item.type}`)).map(item =>
            <button className="ssh-files-button" key={`files:${item.id}`} disabled={!ready} onClick={() => openPanel(item, true)}>Files: {item.name}</button>)}
          {!connections.length && <small className="muted">No connections yet.</small>}
          <div className="library-heading"><h2>Notes</h2><button aria-label="Add note" onClick={() => setEditor({ kind: 'note' })}>+</button></div>
          {notes.filter(item => matches(`${item.title} ${item.content}`)).map(item =>
            <Item key={item.id} name={item.title} detail="Markdown" disabled={!ready}
              open={() => openPanel(item)} edit={() => setEditor({ kind: 'note', item })} />)}
          {!notes.length && <small className="muted">No notes yet.</small>}
        </div>}
      </aside>
      <div className="dock-area">
        <DockviewReact className="dockview-theme-dark ops-dock" components={panels} onReady={onReady}
          defaultTabComponent={SafeTab} rightHeaderActionsComponent={WindowActions}
          disableFloatingGroups={Boolean(window.opsDeckDesktop)} watermarkComponent={Empty} />
      </div>
    </div>
    {editor?.kind === 'connection' && <ConnectionEditor value={editor.item} close={closeEditor}
      save={async data => {
        const item = editor.item;
        if (item && !confirmFileDiscard(`files:${item.id}`)) throw new Error('Save the remote file or discard edits before changing this connection.');
        const saved = await request<Connection>(`${base}/connections${item ? `/${item.id}` : ''}`, item ? 'PUT' : 'POST', data);
        if (item && connectionPanel(item) !== connectionPanel(saved)) {
          const open = dock?.getPanel(`item:${item.id}`) || dock?.getPanel(`files:${item.id}`);
          closePanel(item.id);
          if (open) openPanel(saved);
        } else {
          dock?.getPanel(`item:${saved.id}`)?.api.setTitle(saved.name);
          dock?.getPanel(`files:${saved.id}`)?.api.setTitle(saved.name);
        }
        await refreshDeck(client.id);
      }}
      remove={editor.item && (async () => {
        const item = editor.item!;
        if (!confirmFileDiscard(`files:${item.id}`)) throw new Error('Save the remote file or discard edits before deleting this connection.');
        await request(`${base}/connections/${item.id}`, 'DELETE');
        closePanel(item.id);
        await refreshDeck(client.id);
      })} />}
    {editor?.kind === 'note' && <NamedEditor kind="note" title={editor.item?.title} close={closeEditor}
      save={async title => {
        const item = editor.item;
        if (item) await flushNote(item);
        const content = useOps.getState().deck?.notes.find(note => note.id === item?.id)?.content ?? '';
        const saved = await request<Note>(`${base}/notes${item ? `/${item.id}` : ''}`, item ? 'PUT' : 'POST', { title, content });
        await refreshDeck(client.id);
        if (item) dock?.getPanel(`item:${item.id}`)?.api.setTitle(saved.title);
        else openPanel(saved);
      }}
      remove={editor.item && (async () => {
        const item = editor.item!;
        await flushNote(item);
        await request(`${base}/notes/${item.id}`, 'DELETE');
        writeLocal(`note:${item.id}`, undefined);
        closePanel(item.id);
        await refreshDeck(client.id);
      })} />}
    {editor?.kind === 'workspace' && <NamedEditor kind="workspace" close={closeEditor}
      save={async name => {
        const created = await request<Workspace>(`${base}/workspaces`, 'POST', { name });
        await refreshDeck(client.id);
        navigate({ clientId: client.id, workspaceId: created.id });
      }} />}
  </div>;
}

function Item({ name, detail, open, edit, disabled }: { name: string; detail: string; open: () => void; edit: () => void; disabled: boolean }) {
  return <div className="library-item">
    <button className="item-open" disabled={disabled} onClick={open} title={name}>
      <span className="truncate">{name}</span><small>{detail}</small>
    </button>
    <button className="quiet" onClick={edit} aria-label={`Edit ${name}`}>⋯</button>
  </div>;
}
