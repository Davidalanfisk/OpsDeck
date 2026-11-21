const drafts = new Set<string>();
export function setFileDirty(id: string, dirty: boolean) {
  if (dirty) drafts.add(id);
  else drafts.delete(id);
}
export function confirmFileDiscard(id?: string) {
  return (id ? !drafts.has(id) : !drafts.size) || window.confirm('Discard unsaved remote file edits? Transfers already started are not cancelled.');
}
