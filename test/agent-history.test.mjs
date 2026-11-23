import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newConversation, recoverConversation, saveConversation } from '../src/agent-history.ts';
import { agentNote, checkAgentDraft, registerAgentNote } from '../src/agent-drafts.ts';

test('conversations remain distinct and interrupted tool calls are recoverable', () => {
  const system = { role: 'system', content: 'instructions' };
  const first = newConversation(system);
  const second = newConversation(system);
  const history = [system, { role: 'assistant', content: 'Working', tool_calls: [
    { function: { name: 'first', arguments: {} } }, { function: { name: 'second', arguments: {} } },
  ] }, { role: 'tool', tool_name: 'first', content: 'done' }];
  const saved = saveConversation(saveConversation([], first), { ...second, history });
  assert.deepEqual(saved.map(item => item.id), [second.id, first.id]);
  const recovered = recoverConversation(saved[0], { ...system, content: 'new instructions' });
  assert.equal(recovered.history[0].content, 'new instructions');
  assert.equal(recovered.history[3].tool_name, 'second');
  assert.match(recovered.messages[0].content, /may have completed/);
  assert.equal(recoverConversation(recovered, system).messages.length, 1);
});

test('editor snapshots reject concurrent changes, closure, and busy saves', () => {
  const expected = { content: 'unsaved text', revision: 'original' };
  assert.doesNotThrow(() => checkAgentDraft(expected, expected));
  assert.throws(() => checkAgentDraft({ ...expected, content: 'newer typing' }, expected), /changed/);
  assert.throws(() => checkAgentDraft({ ...expected, revision: 'new revision' }, expected), /changed/);
  assert.throws(() => checkAgentDraft(undefined, expected), /changed/);
  assert.throws(() => checkAgentDraft(expected, expected, true), /busy/);
});

test('note draft registration is scoped and does not unregister a replacement', () => {
  const access = { read: () => ({ content: 'draft', revision: '1' }), apply: () => {} };
  const unregister = registerAgentNote('note', access);
  const replacement = { ...access };
  const removeReplacement = registerAgentNote('note', replacement);
  unregister();
  assert.equal(agentNote('note'), replacement);
  removeReplacement();
  assert.equal(agentNote('note'), undefined);
});
