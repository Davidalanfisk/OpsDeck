import { request } from './state.ts';
import type { AgentConversation } from './agent-history.ts';

export type StoredConversation = { conversation: AgentConversation; version: number };
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(clientId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(clientId, current);
  void current.finally(() => { if (queues.get(clientId) === current) queues.delete(clientId); }).catch(() => undefined);
  return current;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function loadAgentConversations(clientId: string): Promise<StoredConversation[]> {
  return serialized(clientId, async () => {
    const base = `/clients/${clientId}/agent-conversations`;
    const stored = await request<StoredConversation[]>(base);
    const key = `opsdeck:agent-conversations:${clientId}`;
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const legacy: unknown = JSON.parse(raw);
      if (!Array.isArray(legacy)) throw new Error('Legacy conversation data is invalid; it has been retained in browser storage.');
      for (const conversation of legacy as AgentConversation[]) {
        if (!conversation || typeof conversation.id !== 'string' || !Array.isArray(conversation.messages) || !Array.isArray(conversation.history)) {
          throw new Error('Legacy conversation data is invalid; it has been retained in browser storage.');
        }
        const existing = stored.find(item => item.conversation.id === conversation.id);
        if (existing) {
          if (stable(existing.conversation) !== stable(conversation)) throw new Error('A legacy conversation differs from the saved copy. Browser data was retained; resolve the conflict before continuing.');
          continue;
        }
        const result = await request<{ version: number }>(`${base}/${encodeURIComponent(conversation.id)}`, 'PUT', { conversation, expectedVersion: 0 });
        stored.push({ conversation, version: result.version });
      }
      localStorage.removeItem(key);
    }
    return stored.sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt);
  });
}

export function saveAgentConversation(clientId: string, conversation: AgentConversation, expectedVersion: number): Promise<number> {
  return serialized(clientId, async () => {
    const result = await request<{ version: number }>(`/clients/${clientId}/agent-conversations/${encodeURIComponent(conversation.id)}`,
      'PUT', { conversation, expectedVersion });
    return result.version;
  });
}
