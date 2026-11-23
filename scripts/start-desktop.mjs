import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const source = process.env.OPSDECK_SOURCE_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const updates = join(homedir(), 'Library', 'Application Support', 'OpsDeck', 'source-updates');
const pointer = join(updates, 'current.json');
let directory = source;
if (process.platform === 'darwin' && existsSync(pointer)) {
  const { version } = JSON.parse(readFileSync(pointer, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid installed update pointer.');
  directory = join(updates, 'versions', version);
}
const require = createRequire(join(directory, 'package.json'));
const child = spawn(require('electron'), [directory], { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
