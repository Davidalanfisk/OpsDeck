export type DraftSnapshot = { content: string; revision: string };
type DraftAccess = {
  read: () => { content: string; revision: string };
  apply: (expected: { content: string; revision: string }, content: string) => void;
};

export function checkAgentDraft(current: DraftSnapshot | undefined, expected: DraftSnapshot, busy = false) {
  if (busy || !current || current.content !== expected.content || current.revision !== expected.revision) {
    throw new Error('The open editor changed or is busy. Read it again before editing.');
  }
}

const notes = new Map<string, DraftAccess>();

export function registerAgentNote(id: string, access: DraftAccess) {
  notes.set(id, access);
  return () => { if (notes.get(id) === access) notes.delete(id); };
}

export function agentNote(id: string) {
  return notes.get(id);
}
