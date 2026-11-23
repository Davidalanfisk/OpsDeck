import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Client } from '../shared/model.ts';
import { ClientEditor } from './editors.tsx';
import { describe, refreshDeck, request, useOps } from './state.ts';
import { WorkspaceView } from './workspace.tsx';
import { Updates } from './updates.tsx';
import './styles.css';

function Dashboard() {
  const [clients, setClients] = useState<Client[]>([]);
  const [filter, setFilter] = useState('');
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [editor, setEditor] = useState<{ item?: Client }>();
  const navigate = useOps(store => store.navigate);
  const setError = useOps(store => store.setError);

  function load() {
    setState('loading');
    return request<Client[]>('/clients').then(data => { setClients(data); setState('loaded'); })
      .catch(error => { setState('failed'); setError(describe(error)); });
  }
  useEffect(() => { void load(); }, []);
  const query = filter.trim().toLowerCase();
  const results = clients.filter(client => `${client.name} ${client.description}`.toLowerCase().includes(query));
  const close = () => setEditor(undefined);
  return <main className="dashboard">
    <div className="dashboard-head">
      <div>
        <p className="eyebrow">OPERATIONS WORKSPACE</p>
        <h1>Clients</h1>
        <p className="muted">Pick a client to resume their workspace, connections and notes.</p>
      </div>
      <button className="primary" onClick={() => setEditor({})}>+ New client</button>
    </div>
    <label className="client-search">Search clients <input type="search" placeholder="Search by name or description…" value={filter}
      onChange={event => setFilter(event.target.value)} /></label>
    <div className="client-grid">
      {results.map(client => <article className="client-card" key={client.id}>
        <div className="card-top">
          <span className="client-mark" style={{ color: client.colour }}>{client.name.slice(0, 2).toUpperCase()}</span>
          <button className="quiet" aria-label={`Edit ${client.name}`} onClick={() => setEditor({ item: client })}>⋯</button>
        </div>
        <h2>{client.name}</h2>
        <p className="muted">{client.description || 'No description'}</p>
        <button className="open-workspace" onClick={() => navigate({ clientId: client.id })}>Open workspace <span>→</span></button>
      </article>)}
    </div>
    {state === 'loading' && <p role="status">Loading clients…</p>}
    {state === 'failed' && <button onClick={load}>Retry loading clients</button>}
    {state === 'loaded' && !clients.length && <div className="dashboard-empty">
      <h2>No clients yet</h2><p className="muted">Create a client to start a workspace.</p>
    </div>}
    {state === 'loaded' && !!clients.length && !results.length && <p>No clients match your search.</p>}
    {editor && <ClientEditor value={editor.item} close={close} save={async data => {
      const item = editor.item;
      const saved = await request<Client>(`/clients${item ? `/${item.id}` : ''}`, item ? 'PUT' : 'POST', data);
      setClients(items => [...items.filter(client => client.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
    }} remove={editor.item && (async () => {
      const id = editor.item!.id;
      await request(`/clients/${id}`, 'DELETE');
      setClients(items => items.filter(client => client.id !== id));
    })} />}
  </main>;
}

function App() {
  const { clientId, workspaceId } = useOps(state => state.location);
  const deck = useOps(state => state.deck);
  const error = useOps(state => state.error);
  const setError = useOps(state => state.setError);
  const navigate = useOps(state => state.navigate);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!clientId) return;
    let active = true;
    setLoadError('');
    void refreshDeck(clientId).catch(error => { if (active) setLoadError(describe(error)); });
    return () => { active = false; };
  }, [clientId, retry]);
  const workspace = deck?.workspaces.find(item => item.id === workspaceId) ?? deck?.workspaces[0];
  useEffect(() => {
    if (clientId && workspace && workspace.id !== workspaceId) navigate({ clientId, workspaceId: workspace.id });
  }, [clientId, workspace, workspaceId, navigate]);

  return <div className="app">
    <header className="app-header">
      <button className="brand" onClick={() => navigate({})}><span className="brand-mark">▰</span> OpsDeck</button>
      <span className="header-label">CONTROL DESK</span>
      <span className="spacer" />
      {window.opsDeckDesktop && <Updates />}
      <span className="header-label"><span className="dot online" /> SELF-HOSTED</span>
    </header>
    {error && <div role="alert" className="banner">{error}<button className="quiet" aria-label="Dismiss error" onClick={() => setError()}>×</button></div>}
    {!clientId ? <Dashboard /> : deck && workspace
      ? <WorkspaceView key={workspace.id} deck={deck} workspace={workspace} />
      : <main className="dashboard">
        <button onClick={() => navigate({})}>‹ Clients</button>
        {loadError ? <><p role="alert">{loadError}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></>
          : <p role="status">{deck ? 'No workspace found for this client.' : 'Opening workspace…'}</p>}
      </main>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
