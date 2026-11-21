import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import Markdown from 'react-markdown';
import type { Note } from '../shared/model.ts';
import { describe, readLocal, request, useOps, writeLocal } from './state.ts';
import { SshTerminal } from './terminal.tsx';
import { DesktopBrowser } from './desktop-browser.tsx';
import { isFileConnection } from '../shared/model.ts';
import { FileBrowser } from './files.tsx';

type Draft = { content: string; updatedAt: string };
const saves = new Map<string, { timer: ReturnType<typeof setTimeout>; draft: Draft }>();
const inFlight = new Map<string, Promise<void>>();

export async function flushNote(note: Note) {
  const pending = saves.get(note.id);
  if (pending) {
    clearTimeout(pending.timer);
    saves.delete(note.id);
  }
  const previous = inFlight.get(note.id);
  if (!pending) return previous;
  const { draft } = pending;
  const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    const state = useOps.getState();
    const latest = state.deck?.notes.find(item => item.id === note.id) ?? note;
    const saved = await request<Note>(`/clients/${note.client_id}/notes/${note.id}`, 'PUT', {
      title: latest.title, content: draft.content,
    }, draft.content.length < 9500);
    if (readLocal<Draft>(`note:${note.id}`)?.updatedAt === draft.updatedAt) writeLocal(`note:${note.id}`, undefined);
    const deck = useOps.getState().deck;
    if (deck?.client.id === note.client_id) useOps.getState().setDeck({
      ...deck, notes: deck.notes.map(item => item.id === note.id ? saved : item),
    });
  });
  inFlight.set(note.id, current);
  try { await current; }
  finally { if (inFlight.get(note.id) === current) inFlight.delete(note.id); }
}

function queueNote(note: Note, draft: Draft) {
  if (!writeLocal(`note:${note.id}`, draft)) useOps.getState().setError('Browser storage is unavailable; leave the note open until it saves.');
  const previous = saves.get(note.id);
  if (previous) clearTimeout(previous.timer);
  saves.set(note.id, { draft, timer: setTimeout(() => {
    void flushNote(note).catch(error => useOps.getState().setError(`Note autosave failed: ${describe(error)}`));
  }, 350) });
}

function NoteEditor({ note }: { note: Note }) {
  const draft = readLocal<Draft>(`note:${note.id}`);
  const [content, setContent] = useState(draft?.content ?? note.content);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    const savedDraft = readLocal<Draft>(`note:${note.id}`);
    if (savedDraft) queueNote(note, savedDraft);
    const flush = () => { void flushNote(note).catch(error => useOps.getState().setError(`Note autosave failed: ${describe(error)}`)); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [note.id]);
  return <div className="note-panel">
    <div className="panel-toolbar">
      <span className="eyebrow">MARKDOWN NOTE</span>
      <div className="segment">
        <button aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
        <button aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
      </div>
    </div>
    {preview
      ? <article className="markdown"><Markdown components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        img: ({ alt }) => <span>{alt}</span>,
      }}>{content}</Markdown></article>
      : <textarea className="note-body" aria-label="Markdown note content" maxLength={250000} value={content}
        placeholder="Write a runbook, a handover, or anything worth keeping…"
        onChange={event => {
          const next = event.target.value;
          setContent(next);
          queueNote(note, { content: next, updatedAt: `${Date.now()}-${Math.random()}` });
        }} />}
  </div>;
}

type ItemParams = { itemId: string };
function NotePanel({ params }: IDockviewPanelProps<ItemParams>) {
  const note = useOps(state => state.deck?.notes.find(item => item.id === params.itemId));
  return note ? <NoteEditor key={note.id} note={note} /> : <Gone item="note" />;
}

function TerminalPanel({ params }: IDockviewPanelProps<ItemParams>) {
  const connection = useOps(state => state.deck?.connections.find(item => item.id === params.itemId));
  return connection?.type === 'SSH'
    ? <SshTerminal key={connection.updated_at} connection={connection} />
    : <Gone item="SSH connection" />;
}

function LinkPanel({ params, api }: IDockviewPanelProps<ItemParams>) {
  const connection = useOps(state => state.deck?.connections.find(item => item.id === params.itemId));
  if (!connection || isFileConnection(connection)) return <Gone item="web connection" />;
  if (window.opsDeckDesktop) return <DesktopBrowser key={connection.url} bridge={window.opsDeckDesktop}
    api={api} id={connection.id} clientId={connection.client_id} url={connection.url} name={connection.name} />;
  return <div className="link-panel">
    <div className="panel-toolbar"><span className="eyebrow">{connection.type}</span>
      <a href={connection.url} target="_blank" rel="noopener noreferrer">Open separately ↗</a>
    </div>
    <iframe src={connection.url} title={connection.name} referrerPolicy="no-referrer"
      sandbox="allow-forms allow-scripts allow-popups allow-popups-to-escape-sandbox" />
    <small>Some sites block embedding or require a full browser tab. Use “Open separately” if needed.</small>
  </div>;
}

function FilesPanel({ params }: IDockviewPanelProps<ItemParams>) {
  const connection = useOps(state => state.deck?.connections.find(item => item.id === params.itemId));
  return connection && isFileConnection(connection)
    ? <FileBrowser key={connection.updated_at} connection={connection} />
    : <Gone item="file connection" />;
}

function Gone({ item }: { item: string }) {
  return <div className="workspace-empty">This {item} is no longer available. Close this tab to remove it.</div>;
}

export const panels = { note: NotePanel, terminal: TerminalPanel, link: LinkPanel, files: FilesPanel };
