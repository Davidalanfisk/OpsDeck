import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const suite = process.argv[2];
if (!['smoke', 'portable-smoke'].includes(suite)) throw new Error('Unknown desktop smoke suite.');
const profile = join(process.cwd(), `.opsdeck-test-${randomUUID()}`);
await mkdir(profile);
try {
  const child = spawn(process.execPath, [join('node_modules', 'electron', 'cli.js'), join('desktop-dist', `${suite}.cjs`)], {
    stdio: 'inherit', env: { ...process.env, OPSDECK_SMOKE_PROFILE: profile },
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) process.exitCode = result.code ?? 1;
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
