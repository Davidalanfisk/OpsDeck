import { homedir } from 'node:os';
import { join } from 'node:path';
import { createOllama } from '../desktop/ollama.ts';
import { ollamaModels } from '../shared/ollama.ts';

const directory = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'OpsDeck', 'workspace')
  : process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'OpsDeck', 'workspace')
    : undefined;
if (!directory) throw new Error('Automatic setup supports macOS Apple silicon and Windows x64 only.');
const ollama = createOllama(directory);
const model = process.argv[2] ?? ollama.status().recommended;
if (!ollamaModels.some(option => option === model)) {
  throw new Error(`Choose a model: ${ollamaModels.join(', ')}`);
}
let previous = '';
const timer = setInterval(() => {
  const status = ollama.status();
  const message = `${status.detail}${status.progress === undefined ? '' : ` ${Math.round(status.progress * 100)}%`}`;
  if (message !== previous) { console.log(message); previous = message; }
}, 2000);
const interrupt = () => ollama.close();
process.once('SIGINT', interrupt);
try {
  await ollama.setup(model);
  console.log(`Installed ${model}. Start OpsDeck and select it in Local agent.`);
} finally {
  clearInterval(timer);
  process.off('SIGINT', interrupt);
  ollama.close();
}
