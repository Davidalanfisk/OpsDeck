import { maxTextBytes } from '../shared/files.ts';
import type { RemoteText } from '../shared/files.ts';
import { request } from './state.ts';

type TerminalAccess = { read: () => string; send: (command: string) => void };
type EditorSnapshot = { content: string; revision: string };
type FileAccess = {
  session: string;
  readOpen: (path: string) => EditorSnapshot | undefined;
  applyOpen: (path: string, expected: EditorSnapshot, content: string) => void;
};
const terminals = new Map<string, TerminalAccess>();
const fileSessions = new Map<string, FileAccess>();

export function registerAgentTerminal(id: string, access: TerminalAccess) {
  terminals.set(id, access);
  return () => { if (terminals.get(id) === access) terminals.delete(id); };
}
export function registerAgentFiles(id: string, access: FileAccess) {
  fileSessions.set(id, access);
  return () => { if (fileSessions.get(id) === access) fileSessions.delete(id); };
}
export function terminalRead(id: string) {
  const terminal = terminals.get(id);
  if (!terminal) throw new Error('Open and connect this SSH terminal first.');
  return terminal.read();
}
export function terminalSend(id: string, command: string) {
  const terminal = terminals.get(id);
  if (!terminal) throw new Error('Open and connect this SSH terminal first.');
  if (!command || command.length > 2000 || /[\0-\x1f\x7f]/.test(command)) throw new Error('SSH commands must be a single line of at most 2000 characters.');
  terminal.send(command);
  return 'Command sent. Read the terminal separately to see its output; completion is not guaranteed.';
}
function fileSession(id: string) {
  const session = fileSessions.get(id);
  if (!session) throw new Error('Open and connect this file browser first.');
  return session;
}
function canonicalPath(path: string) {
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('Use an absolute remote path.');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
export async function fileList(id: string, path: string) {
  return request(`/files/${fileSession(id).session}/list`, 'POST', { path });
}
export async function fileRead(id: string, path: string) {
  const session = fileSession(id);
  path = canonicalPath(path);
  const open = session.readOpen(path);
  if (open) return { path, ...open, editorDraft: true };
  return { ...await request<RemoteText>(`/files/${session.session}/read`, 'POST', { path }), editorDraft: false };
}
export async function fileSearch(id: string, path: string, query: string) {
  if (query.length < 2 || query.length > 200 || /[\r\n]/.test(query)) throw new Error('Search text must be 2–200 characters on one line.');
  const file = await fileRead(id, path);
  const matches: { line: number; text: string; truncated?: boolean }[] = [];
  let total = 0;
  for (const [index, line] of file.content.split('\n').entries()) {
    const position = line.toLowerCase().indexOf(query.toLowerCase());
    if (position < 0) continue;
    total++;
    if (matches.length < 30) {
      const start = Math.max(0, position - 200);
      matches.push({ line: index + 1, text: line.slice(start, start + 500),
        ...(start > 0 || line.length > start + 500 ? { truncated: true } : {}) });
    }
  }
  return { path: file.path, revision: file.revision, editorDraft: file.editorDraft, matches, total, truncated: total > matches.length };
}
export async function fileWrite(id: string, path: string, content: string, revision: string, snapshot?: EditorSnapshot & { editorDraft: boolean }) {
  const session = fileSession(id);
  path = canonicalPath(path);
  if (new TextEncoder().encode(content).length > maxTextBytes) throw new Error('Text files are limited to 1 MiB.');
  const open = session.readOpen(path);
  if (open || snapshot?.editorDraft) {
    if (!open || !snapshot?.editorDraft || snapshot.revision !== revision) throw new Error('The editor state changed. Read the file again before editing.');
    session.applyOpen(path, snapshot, content);
    return 'Updated the open editor draft. Save to server to upload it.';
  }
  return request(`/files/${session.session}/save`, 'PUT', { path, content, revision });
}
export async function fileCreate(id: string, path: string, content: string) {
  const session = fileSession(id);
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > maxTextBytes) throw new Error('Text files are limited to 1 MiB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await request(`/files/${session.session}/upload`, 'POST', { path, data: btoa(binary) });
  return 'Created the new file. Refresh the file browser to see it.';
}
