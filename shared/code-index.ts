export const chunkLines = 150;
export const maxSnippetChars = 8000;
const maxLineChars = 1000;
const maxSymbols = 250;

export type CodeSymbol = { name: string; kind: string; line: number };

const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'new', 'typeof', 'await']);
const sectionTags = /<(script|style|canvas|svg|section|form|header|footer|nav|main|template)\b/i;
const patterns: [RegExp, string][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, 'class'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, 'function'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/, 'function'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([\w$]+)/, 'type'],
  [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([\w$]+)/, 'function'],
  [/^\s*(?:async\s+)?def\s+(\w+)/, 'function'],
  [/^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method'],
  [/^\s*([\w$.]+)\s*[:=]\s*(?:async\s+)?function\b/, 'function'],
  [/^\s*export\s+(?:const|let|var)\s+([\w$]+)/, 'export'],
  [/^\s*export\s*\{([^}]+)\}/, 'export'],
  [/^\s*module\.exports(?:\.([\w$]+))?\s*=/, 'export'],
];

export function lineList(content: string) {
  return content.split(/\r?\n/);
}

export function symbolIndex(content: string, path = '') {
  const css = /\.(css|scss|sass|less)$/i.test(path);
  const html = /\.(html?|php|vue|svelte)$/i.test(path);
  const markdown = /\.(md|markdown)$/i.test(path) || !path;
  const symbols: CodeSymbol[] = [];
  let inStyle = false;
  let truncated = false;
  const add = (name: string, kind: string, line: number) => {
    if (symbols.length >= maxSymbols) { truncated = true; return; }
    symbols.push({ name: name.trim().slice(0, 120), kind, line });
  };
  for (const [index, raw] of lineList(content).entries()) {
    if (truncated) break;
    const line = raw.length > 2000 ? raw.slice(0, 2000) : raw;
    const number = index + 1;
    if (markdown) {
      const heading = /^(#{1,6})\s+(.+)/.exec(line);
      if (heading) { add(heading[2], `h${heading[1].length}`, number); continue; }
    }
    if (html) {
      if (/<style\b/i.test(line)) inStyle = true;
      const tag = sectionTags.exec(line);
      if (tag) add(`<${tag[1].toLowerCase()}>`, 'section', number);
      for (const id of line.matchAll(/\bid\s*=\s*["']([^"'<>]+)["']/gi)) add(`#${id[1]}`, 'id', number);
      if (/<\/style>/i.test(line)) { inStyle = false; continue; }
    }
    if (css || inStyle) {
      const selector = /^\s*([^{};/][^{};]*?)\s*\{/.exec(line);
      if (selector && !/^\s*</.test(selector[1])) add(selector[1], selector[1].startsWith('@') ? 'at-rule' : 'selector', number);
      continue;
    }
    for (const [pattern, kind] of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match[1] ?? 'module.exports';
      if (kind === 'method' && keywords.has(name)) continue;
      add(name, kind, number);
      break;
    }
  }
  return { symbols, truncated };
}

function numbered(lines: string[], start: number) {
  let lineTruncated = false;
  const text = lines.map((line, index) => {
    if (line.length > maxLineChars) { lineTruncated = true; line = `${line.slice(0, maxLineChars)}…[line truncated]`; }
    return `${start + index}| ${line}`;
  }).join('\n');
  return { text, lineTruncated };
}

export function readLines(content: string, start = 1, end?: number) {
  const lines = lineList(content);
  const total = lines.length;
  if (!Number.isSafeInteger(start) || start < 1 || start > total) throw new Error(`start_line must be between 1 and ${total}.`);
  let last = Math.min(total, end ?? start + chunkLines - 1, start + chunkLines - 1);
  if (!Number.isSafeInteger(last) || last < start) throw new Error('end_line must be at least start_line.');
  let selected = lines.slice(start - 1, last);
  let view = numbered(selected, start);
  while (view.text.length > maxSnippetChars && selected.length > 1) {
    selected = selected.slice(0, Math.max(1, Math.floor(selected.length * 0.7)));
    view = numbered(selected, start);
  }
  last = start + selected.length - 1;
  const requestedEnd = Math.min(total, end ?? last);
  return {
    start_line: start, end_line: last, total_lines: total, content: view.text,
    ...(view.lineTruncated ? { line_truncated: true } : {}),
    ...(last < requestedEnd || (end === undefined && last < total) ? { truncated: true, next_start_line: last + 1 } : {}),
    complete: start === 1 && last === total && !view.lineTruncated,
  };
}

export function chunkMap(total: number) {
  const chunks: string[] = [];
  for (let start = 1; start <= total && chunks.length < 40; start += chunkLines) chunks.push(`${start}-${Math.min(total, start + chunkLines - 1)}`);
  return { chunks, ...(Math.ceil(total / chunkLines) > chunks.length ? { more_chunks: true } : {}) };
}

export function outline(content: string, path = '') {
  const { symbols, truncated } = symbolIndex(content, path);
  const total = lineList(content).length;
  let text = '';
  let shown = 0;
  for (const symbol of symbols) {
    const next = `L${symbol.line} ${symbol.kind} ${symbol.name}\n`;
    if (text.length + next.length > 5000) break;
    text += next; shown++;
  }
  return {
    total_lines: total, bytes: new TextEncoder().encode(content).length,
    symbols: text.trimEnd() || '(no symbols detected)',
    ...(truncated || shown < symbols.length ? { symbols_truncated: true } : {}),
    ...chunkMap(total),
  };
}

function blockEnd(lines: string[], start: number) {
  const first = lines[start - 1] ?? '';
  const tag = /<(script|style|template|svg|canvas|section|form|header|footer|nav|main|div|ul|ol|table)\b/i.exec(first);
  if (tag && !new RegExp(`</${tag[1]}>`, 'i').test(first)) {
    for (let i = start; i < lines.length && i < start + 400; i++) if (new RegExp(`</${tag[1]}>`, 'i').test(lines[i])) return i + 1;
  }
  let depth = 0;
  let opened = false;
  for (let i = start - 1; i < lines.length && i < start + 600; i++) {
    const line = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
    for (const character of line) {
      if (character === '{') { depth++; opened = true; }
      else if (character === '}') depth--;
    }
    if (opened && depth <= 0) return i + 1;
    if (!opened && i >= start + 3) break;
    if (!opened && /;\s*$/.test(line)) return i + 1;
  }
  const indent = /^\s*/.exec(first)![0].length;
  if (/:\s*(#.*)?$/.test(first)) {
    let end = start;
    for (let i = start; i < lines.length && i < start + 600; i++) {
      if (!lines[i].trim()) continue;
      if (/^\s*/.exec(lines[i])![0].length <= indent) break;
      end = i + 1;
    }
    return end;
  }
  if (/^#{1,6}\s/.test(first)) {
    const level = /^#+/.exec(first)![0].length;
    for (let i = start; i < lines.length; i++) {
      const heading = /^(#{1,6})\s/.exec(lines[i]);
      if (heading && heading[1].length <= level) return i;
    }
    return lines.length;
  }
  return Math.min(lines.length, start + 39);
}

export function readSymbol(content: string, path: string, name: string) {
  const { symbols } = symbolIndex(content, path);
  const wanted = name.trim();
  let found = symbols.filter(symbol => symbol.name === wanted || symbol.name === `#${wanted}`);
  if (!found.length) found = symbols.filter(symbol => symbol.name.toLowerCase() === wanted.toLowerCase());
  if (!found.length) found = symbols.filter(symbol => symbol.name.toLowerCase().includes(wanted.toLowerCase()));
  if (!found.length) throw new Error(`Symbol "${name}" was not found. Use search_file or file_outline to locate it.`);
  const symbol = found[0];
  const lines = lineList(content);
  const start = Math.max(1, symbol.line - (lines[symbol.line - 2]?.trim().startsWith('@') ? 1 : 0));
  const end = Math.max(start, blockEnd(lines, symbol.line));
  return {
    symbol: `${symbol.kind} ${symbol.name}`, ...readLines(content, start, end),
    ...(found.length > 1 ? { other_matches: found.slice(1, 11).map(item => `L${item.line} ${item.kind} ${item.name}`) } : {}),
  };
}

export function searchText(content: string, path: string, query: string) {
  const terms = query.split('|').map(term => term.trim()).filter(Boolean);
  if (!terms.length || terms.length > 8 || terms.some(term => term.length < 2 || term.length > 100) || /[\r\n]/.test(query)) {
    throw new Error('Search for 1–8 literal terms separated by |, each 2–100 characters on one line.');
  }
  const lower = terms.map(term => term.toLowerCase());
  const { symbols } = symbolIndex(content, path);
  const containers = symbols.filter(symbol => ['class', 'function', 'method', 'section'].includes(symbol.kind) || /^h\d$/.test(symbol.kind));
  const matches: { line: number; text: string; in?: string; truncated?: boolean }[] = [];
  let total = 0;
  let size = 0;
  for (const [index, line] of lineList(content).entries()) {
    const text = line.toLowerCase();
    const position = Math.min(...lower.map(term => { const at = text.indexOf(term); return at < 0 ? Infinity : at; }));
    if (position === Infinity) continue;
    total++;
    if (matches.length >= 40 || size > 6000) continue;
    const start = Math.max(0, position - 120);
    const container = containers.filter(symbol => symbol.line <= index + 1).at(-1);
    const match = { line: index + 1, text: line.slice(start, start + 300).trim(),
      ...(container ? { in: `L${container.line} ${container.kind} ${container.name}` } : {}),
      ...(start > 0 || line.length > start + 300 ? { truncated: true } : {}) };
    size += JSON.stringify(match).length;
    matches.push(match);
  }
  return { terms, matches, total, truncated: total > matches.length, total_lines: lineList(content).length };
}

export function replaceOnce(content: string, oldText: string, newText: string) {
  if (!oldText) throw new Error('old_text must contain the exact existing text to replace.');
  if (content.includes('\r\n') && !oldText.includes('\r')) {
    oldText = oldText.replace(/\n/g, '\r\n');
    newText = newText.replace(/\r?\n/g, '\r\n');
  }
  const positions: number[] = [];
  for (let at = content.indexOf(oldText); at >= 0 && positions.length < 11; at = content.indexOf(oldText, at + 1)) positions.push(at);
  const lineAt = (at: number) => content.slice(0, at).split('\n').length;
  if (!positions.length) throw new Error('old_text was not found exactly. Re-read the relevant lines (without the "N| " prefixes) and copy the text exactly.');
  if (positions.length > 1) {
    throw new Error(`old_text matches ${positions.length > 10 ? 'more than 10' : positions.length} places (lines ${positions.slice(0, 10).map(lineAt).join(', ')}). Include more surrounding lines so it is unique.`);
  }
  const updated = content.slice(0, positions[0]) + newText + content.slice(positions[0] + oldText.length);
  const startLine = lineAt(positions[0]);
  const endLine = startLine + Math.max(0, newText.split('\n').length - 1);
  return { content: updated, startLine, endLine };
}
