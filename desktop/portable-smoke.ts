import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, type BrowserWindow } from 'electron';
import { createPortableUpdater } from './portable-updater.ts';
import { startDesktop } from './window.ts';

const temporary = process.env.OPSDECK_SMOKE_PROFILE ?? join(process.cwd(), `.opsdeck-portable-smoke-${randomUUID()}`);
mkdirSync(temporary, { recursive: true });
app.setPath('userData', temporary);
const deadline = setTimeout(() => { console.error('Portable updater smoke test timed out'); app.exit(1); }, 40_000);
const originalFetch = globalThis.fetch;
const bytes = Buffer.from('portable update fixture');
const platform = process.platform === 'darwin' ? 'mac-arm64' : 'win-x64';
const asset = `https://github.com/Davidalanfisk/OpsDeck/releases/download/v0.7.0/OpsDeck-0.7.0-${platform}.zip`;
let corrupt = true;
let revealed: string | undefined;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/latest.json') {
    return new Response(JSON.stringify({ version: '0.7.0', portable: { [platform]: {
      url: asset, sha256: createHash('sha256').update(bytes).digest('hex'),
    } } }));
  }
  if (url === asset) return new Response(corrupt ? Buffer.from('corrupt') : bytes);
  return originalFetch(input, init);
};

async function until<T>(check: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error('Portable updater UI condition did not become ready');
}

void app.whenReady().then(async () => {
  const updater = createPortableUpdater(join(temporary, 'portable-updates'), '0.6.2', platform, path => { revealed = path; });
  let window: BrowserWindow | undefined;
  try {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const desktop = await startDesktop(join(temporary, 'workspace'), resolve('dist'), port, undefined, updater);
    window = desktop.window;
    const workspace = window.webContents;
    const button = (text: string) => `Array.from(document.querySelectorAll('.update-popover button')).find(b => b.textContent === ${JSON.stringify(text)})`;
    await until(() => workspace.executeJavaScript(`Boolean(${button('Download verified update')} && document.querySelector('.update-popover[open]'))`));
    assert.equal((await workspace.executeJavaScript('window.opsDeckDesktop.updateStatus()')).mode, 'portable');
    await workspace.executeJavaScript(`${button('Download verified update')}.click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.update-popover [role="alert"]')?.textContent.includes('checksum mismatch')`));
    assert.equal((await workspace.executeJavaScript('window.opsDeckDesktop.updateStatus()')).phase, 'error');
    corrupt = false;
    await until(() => workspace.executeJavaScript(`${button('Check for updates')} && !${button('Check for updates')}.disabled`));
    await workspace.executeJavaScript(`${button('Check for updates')}.click()`);
    await until(() => workspace.executeJavaScript(`Boolean(${button('Download verified update')})`));
    await workspace.executeJavaScript(`${button('Download verified update')}.click()`);
    await until(() => workspace.executeJavaScript(`Boolean(${button('Show downloaded ZIP')})`));
    await workspace.executeJavaScript(`${button('Show downloaded ZIP')}.click()`);
    await until(() => revealed);
    assert.deepEqual(await readFile(revealed!), bytes);
    assert.equal(window.isDestroyed(), false);
    console.log('Desktop: portable updater UI, trusted IPC bridge, checksum failure and verified download passed');
  } finally {
    window?.destroy();
    await updater.close();
    globalThis.fetch = originalFetch;
  }
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });

app.on('quit', () => {
  clearTimeout(deadline);
  if (process.env.OPSDECK_SMOKE_PROFILE) return;
  try { rmSync(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
  catch { console.warn('Could not remove the temporary portable updater profile.'); }
});
