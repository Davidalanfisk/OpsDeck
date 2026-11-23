import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionBoundary, contextMessages, estimateTokens, makeSummary, needsCompaction, summaryChunks } from '../shared/agent-context.ts';
import { recoverConversation } from '../src/agent-history.ts';

const system = { role: 'system', content: 'instructions' };
const history = [
  system, { role: 'user', content: 'first' },
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
  { role: 'tool', tool_name: 'read_file', content: 'old file contents' },
  { role: 'assistant', content: 'done' }, { role: 'user', content: 'second' },
  { role: 'assistant', content: 'answer' }, { role: 'user', content: 'current' },
];

test('compaction keeps whole recent turns and original history intact', async () => {
  const original = structuredClone(history);
  const seen = [];
  const summary = await makeSummary(history, undefined, 2, async (prior, chunk) => {
    seen.push({ prior, chunk });
    return 'first turn summary';
  });
  assert.equal(summary.through, 5);
  assert.match(seen[0].chunk, /old file contents/);
  const prompt = contextMessages(history, summary, 'pinned fact');
  assert.match(prompt[0].content, /pinned fact/);
  assert.match(prompt[0].content, /first turn summary/);
  assert.deepEqual(prompt.slice(1), history.slice(5));
  assert.deepEqual(history, original);
  assert.equal(compactionBoundary(history, 1, 1), 7);
  assert.throws(() => contextMessages(history, { content: 'bad', through: 3 }), /boundary/);
});

test('summary failures preserve prior state and long multilingual chunks are bounded', async () => {
  const longHistory = [system, { role: 'user', content: '😀'.repeat(5000) }, { role: 'user', content: 'next' }];
  const chunks = summaryChunks(longHistory, 1, 2);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 4000));
  let count = 0;
  await assert.rejects(makeSummary(longHistory, undefined, 1, async () => {
    if (++count === 2) throw new Error('model unavailable');
    return 'first chunk';
  }), /model unavailable/);
  assert.equal(longHistory[1].content.length, 10000);
  await assert.rejects(makeSummary(history, undefined, 1, async () => ''), /invalid/);
  assert.equal(await makeSummary([system, { role: 'user', content: 'only turn' }], undefined, 1, async () => 'unused'), undefined);
});

test('context budget includes tool payload and interrupted recovery adjusts summary boundary', () => {
  assert.ok(estimateTokens([system], []) < estimateTokens([system, { role: 'user', content: 'é'.repeat(100) }], []));
  assert.equal(needsCompaction([system, { role: 'user', content: 'x'.repeat(30000) }], []), true);
  const interrupted = { id: 'a', title: 'a', updatedAt: 0, messages: [],
    history: [system, { role: 'user', content: 'a' }, history[2], { role: 'user', content: 'b' }],
    summary: { content: 'summary', through: 3 } };
  const recovered = recoverConversation(interrupted, system);
  assert.equal(recovered.summary.through, 4);
  assert.equal(contextMessages(recovered.history, recovered.summary)[1].content, 'b');
});
test('earlier tool traces are shortened in context while the current turn stays intact', () => {
  const big = 'x'.repeat(5000);
  const traced = [system, { role: 'user', content: 'old' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { content: big } } }] },
    { role: 'tool', tool_name: 'read_file', content: big }, { role: 'user', content: 'now' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
    { role: 'tool', tool_name: 'read_file', content: big },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
    { role: 'tool', tool_name: 'read_file', content: big }];
  const prompt = contextMessages(traced);
  assert.match(prompt[2].tool_calls[0].function.arguments.content, /5000 chars omitted/);
  assert.match(prompt[3].content, /omitted_from_context/);
  assert.equal(prompt[6].content, big);
  assert.equal(traced[3].content, big);
  const aggressive = contextMessages(traced, undefined, '', 1);
  assert.match(aggressive[6].content, /omitted_from_context/);
  assert.equal(aggressive[8].content, big);
  assert.ok(summaryChunks(traced, 1, 4).join('').length < 3000);
});
