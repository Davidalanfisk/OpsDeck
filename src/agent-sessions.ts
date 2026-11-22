import { maxTextBytes } from '../shared/files.ts';
import type { RemoteText } from '../shared/files.ts';
import { request } from './state.ts';

type TerminalAccess = { read: () => string; send: (command: string) => void };
type FileAccess = { session: string; openPaths: Set<string> };
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
export async function fileList(id: string, path: string) {
  return request(`/files/${fileSession(id).session}/list`, 'POST', { path });
}
export async function fileRead(id: string, path: string) {
  return request<RemoteText>(`/files/${fileSession(id).session}/read`, 'POST', { path });
}
export async function fileWrite(id: string, path: string, content: string, revision: string) {
  const session = fileSession(id);
  if (session.openPaths.has(path)) throw new Error('Close this file in the editor before the agent writes it, to protect its draft.');
  if (new TextEncoder().encode(content).length > maxTextBytes) throw new Error('Text files are limited to 1 MiB.');
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
