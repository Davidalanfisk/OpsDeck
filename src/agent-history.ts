import type { AgentMessage } from '../shared/ollama.ts';
import type { SessionSummary } from '../shared/agent-context.ts';

export type DisplayMessage = { role: 'user' | 'assistant' | 'action' | 'tool' | 'error'; content: string };
export type AgentConversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: DisplayMessage[];
  history: AgentMessage[];
  summary?: SessionSummary;
};

export function newConversation(system: AgentMessage): AgentConversation {
  return { id: crypto.randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [], history: [system] };
}

export function saveConversation(conversations: AgentConversation[], current: AgentConversation) {
  return [current, ...conversations.filter(item => item.id !== current.id)];
}

export function recoverConversation(conversation: AgentConversation, system: AgentMessage): AgentConversation {
  const history = [...conversation.history];
  let summary = conversation.summary;
  let interrupted = false;
  if (history[0]?.role === 'system') history[0] = system;
  for (let i = 0; i < history.length; i++) {
    const calls = history[i].role === 'assistant' ? history[i].tool_calls : undefined;
    if (!calls?.length) continue;
    let completed = 0;
    while (history[i + 1 + completed]?.role === 'tool' && completed < calls.length) completed++;
    if (completed < calls.length) {
      interrupted = true;
      const missing = calls.slice(completed).map(call => ({
        role: 'tool' as const, tool_name: call.function.name,
        content: JSON.stringify({ error: 'The previous session ended before this action result was recorded. Inspect the target before retrying; the action may have completed.' }),
      }));
      history.splice(i + 1 + completed, 0, ...missing);
      if (summary && i + 1 + completed <= summary.through) summary = { ...summary, through: summary.through + missing.length };
    }
    i += calls.length;
  }
  return { ...conversation, history, summary, messages: interrupted ? [...conversation.messages, {
    role: 'error', content: 'The previous session ended before an action result was recorded. Inspect the target before retrying; the action may have completed.',
  }] : conversation.messages };
}
