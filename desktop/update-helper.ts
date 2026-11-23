import { spawn } from 'node:child_process';
import { access, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

type Plan = { root: string; version: string; previous?: string; source: string; parent: number; marker: string };

async function launch(directory: string, marker?: string) {
  const require = createRequire(join(directory, 'package.json'));
  const child = spawn(require('electron') as string, [directory], { detached: true, stdio: 'ignore',
    env: { ...process.env, OPSDECK_UPDATE_READY: marker ?? '' } });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

async function run() {
  const planPath = process.argv[2];
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { process.kill(plan.parent, 0); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break;
      throw error;
    }
    if (attempt === 119) throw new Error('OpsDeck did not close. No update was applied.');
    await delay(500);
  }
  const pointer = join(plan.root, 'current.json');
  await writeFile(`${pointer}.tmp`, JSON.stringify({ version: plan.version }), { mode: 0o600 });
  await rename(`${pointer}.tmp`, pointer);
  try {
    const child = await launch(join(plan.root, 'versions', plan.version), plan.marker);
    for (let attempt = 0; attempt < 120; attempt++) {
      try { await access(plan.marker); await rm(plan.marker); await rm(planPath); return; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(500);
    }
    child.kill();
    for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
    throw new Error('Updated OpsDeck did not start within 60 seconds.');
  } catch (error) {
    if (plan.previous) {
      await writeFile(`${pointer}.tmp`, JSON.stringify({ version: plan.previous }), { mode: 0o600 });
      await rename(`${pointer}.tmp`, pointer);
    } else { await rm(pointer, { force: true }); }
    await writeFile(join(plan.root, 'last-error.txt'), `Update rolled back: ${error instanceof Error ? error.message : 'Unknown error'}`, { mode: 0o600 });
    await launch(plan.previous ? join(plan.root, 'versions', plan.previous) : plan.source);
  }
}

void run().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  try {
    const plan = JSON.parse(await readFile(process.argv[2], 'utf8')) as Plan;
    await writeFile(join(plan.root, 'last-error.txt'), `Update restart failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { mode: 0o600 });
  } catch (recordError) { console.error('Could not record the update restart error:', recordError); }
});
