import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outline, readLines, readSymbol, replaceOnce, searchText, symbolIndex } from '../shared/code-index.ts';

const html = [
  '<html><head><style>',
  '.tree { color: green; }',
  '</style></head><body>',
  '<canvas id="scene"></canvas>',
  '<script>',
  'function drawTree(ctx) {',
  '  ctx.fillStyle = "{";',
  '  requestAnimationFrame(() => drawTree(ctx));',
  '}',
  'const animate = () => {',
  '  drawTree(ctx);',
  '};',
  '</script></body></html>',
].join('\n');

test('symbol index finds functions, HTML ids and CSS selectors', () => {
  const names = symbolIndex(html, '/site/index.html').symbols.map(symbol => `${symbol.line} ${symbol.kind} ${symbol.name}`);
  assert.ok(names.includes('2 selector .tree'));
  assert.ok(names.includes('4 id #scene'));
  assert.ok(names.includes('6 function drawTree'));
  assert.ok(names.includes('10 function animate'));
  const view = outline(html, '/site/index.html');
  assert.equal(view.total_lines, 13);
  assert.deepEqual(view.chunks, ['1-13']);
  assert.match(view.symbols, /L6 function drawTree/);
});

test('symbol reads return only the enclosing block, ignoring braces in strings', () => {
  const block = readSymbol(html, '/site/index.html', 'drawTree');
  assert.equal(block.start_line, 6);
  assert.equal(block.end_line, 9);
  assert.match(block.content, /^6\| function drawTree/);
  assert.throws(() => readSymbol(html, '/site/index.html', 'missing'), /search_file/);
});

test('line ranges are bounded and report the next chunk', () => {
  const big = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n');
  const first = readLines(big);
  assert.equal(first.end_line, 150);
  assert.equal(first.next_start_line, 151);
  assert.equal(first.complete, false);
  const last = readLines(big, 390, 999);
  assert.equal(last.end_line, 400);
  assert.equal(readLines('small\nfile').complete, true);
  const wide = Array.from({ length: 100 }, () => 'x'.repeat(500)).join('\n');
  assert.ok(readLines(wide).content.length <= 8000);
  assert.throws(() => readLines(big, 401), /start_line/);
});

test('search supports several terms and reports the enclosing symbol', () => {
  const found = searchText(html, '/site/index.html', 'requestAnimationFrame|fillStyle');
  assert.deepEqual(found.matches.map(match => match.line), [7, 8]);
  assert.equal(found.matches[0].in, 'L6 function drawTree');
  assert.throws(() => searchText(html, '', 'x'), /2–100/);
});

test('exact replacement requires one unique match and keeps CRLF endings', () => {
  assert.throws(() => replaceOnce('a\na', 'a', 'b'), /matches 2 places \(lines 1, 2\)/);
  assert.throws(() => replaceOnce('abc', 'zzz', 'b'), /not found/);
  const edited = replaceOnce('one\r\ntwo\r\nthree', 'two\nthree', 'TWO\nTHREE');
  assert.equal(edited.content, 'one\r\nTWO\r\nTHREE');
  assert.equal(edited.startLine, 2);
  assert.equal(edited.endLine, 3);
});
