import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow } from 'electron';
import { startDesktop } from './window.ts';

const temporary = mkdtempSync(join(tmpdir(), 'opsdeck-desktop-'));
app.setPath('userData', temporary);
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 40_000);

async function until<T>(check: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error('Desktop condition did not become ready');
}

void app.whenReady().then(async () => {
  const site = createServer((request, response) => {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    if (request.url === '/') {
      response.setHeader('Set-Cookie', 'logged-in=yes; Path=/; HttpOnly; SameSite=Lax');
      response.writeHead(302, { Location: '/login' }).end();
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>${request.headers.cookie?.includes('logged-in=yes') ? 'Logged in' : 'Missing cookie'}</title>`);
    }
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const directory = join(temporary, 'workspace');
  let window: BrowserWindow | undefined;
  try {
    const desktop = await startDesktop(directory, resolve('dist'));
    window = desktop.window;
    const workspace = window.webContents;
    assert.equal((await fetch(`${desktop.origin}/api/clients`)).status, 403);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('main'))`));
    const result = await workspace.executeJavaScript(`(async () => {
      const call = (path, body) => fetch('/api' + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(res => res.json());
      const client = await call('/clients', { name: 'Desktop fixture', description: '', colour: '#9876ff' });
      const ssh = await call('/clients/' + client.id + '/connections', {
        name: 'Fixture SSH', type: 'SSH', host: '127.0.0.1', port: 22, username: 'operator',
        fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
      const socketOpened = await new Promise(resolve => {
        const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ssh/' + client.id + '/' + ssh.id);
        ws.onopen = () => { ws.close(); resolve(true); };
        ws.onerror = () => resolve(false);
      });
      const website = await call('/clients/' + client.id + '/connections', { name: 'Fixture website', type: 'Website',
        url: ${JSON.stringify(siteUrl)} });
      return { id: client.id, website: website.id, socketOpened };
    })()`);
    assert.equal(result.socketOpened, true);
    await workspace.executeJavaScript(`localStorage.setItem('opsdeck:location', JSON.stringify({ clientId: ${JSON.stringify(result.id)} })); location.reload()`);
    const content = window.contentView;
    await until(() => workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Fixture website')?.click() ?? Boolean(document.querySelector('.desktop-browser-slot'))`));
    const pane = await until(() => content.children.find(view => 'webContents' in view && view.webContents !== workspace));
    assert.ok('webContents' in pane);
    const browser = pane.webContents as Electron.WebContents;
    await until(() => browser.getTitle() === 'Logged in' && pane.getVisible() && pane.getBounds().width > 0);
    assert.equal(browser.getURL(), `${siteUrl}/login`);
    assert.equal(await browser.executeJavaScript('self === top && typeof require === "undefined" && !window.opsDeckDesktop'), true);
    assert.equal(await browser.executeJavaScript(`fetch(${JSON.stringify(`${desktop.origin}/api/clients`)}).then(() => false, () => true)`), true);

    await workspace.executeJavaScript(`document.querySelector('[aria-label="Edit Fixture website"]').click()`);
    await until(() => !pane.getVisible());
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Close dialog"]').click()`);
    await until(() => pane.getVisible());

    await browser.executeJavaScript(`window.open('/popup'); void 0`);
    const popup = await until(() => BrowserWindow.getAllWindows().find(child => child !== window));
    await until(() => popup.webContents.getTitle() === 'Logged in');
    assert.equal(await popup.webContents.executeJavaScript('Boolean(window.opener) && !window.opsDeckDesktop'), true);
    popup.close();

    await browser.executeJavaScript(`sessionStorage.setItem('tab-state', 'retained');
      localStorage.setItem('profile-state', 'retained'); history.pushState(null, '', '/account');`);
    const profile = browser.session;
    await profile.cookies.set({ url: siteUrl, name: 'remembered', value: 'yes', expirationDate: Date.now() / 1000 + 3600 });
    const inactivity = 30 * 24 * 60 * 60 * 1000;
    async function leaveWorkspace(age: number) {
      await workspace.executeJavaScript(`document.querySelector('.workspace-bar button').click()`);
      await until(() => !content.children.includes(pane));
      const db = new DatabaseSync(join(directory, 'opsdeck.sqlite'));
      try {
        assert.equal(db.prepare('UPDATE desktop_browser_activity SET last_used = ? WHERE client_id = ?')
          .run(Date.now() - age, result.id).changes, 1);
      } finally { db.close(); }
    }
    async function reopenWorkspace() {
      await until(() => workspace.executeJavaScript(`(() => {
        const button = document.querySelector('.open-workspace');
        if (!button) return false;
        button.click();
        return true;
      })()`));
      return until(() => content.children.find(view => 'webContents' in view && view.webContents !== workspace));
    }
    await leaveWorkspace(inactivity - 60 * 60 * 1000);
    assert.equal(await reopenWorkspace(), pane);
    assert.equal(browser.getURL(), `${siteUrl}/account`);
    assert.equal(await browser.executeJavaScript(`sessionStorage.getItem('tab-state')`), 'retained');
    assert.equal((await profile.cookies.get({ name: 'remembered' })).length, 1);

    await leaveWorkspace(inactivity);
    const freshPane = await reopenWorkspace();
    assert.notEqual(freshPane, pane);
    assert.ok('webContents' in freshPane);
    const freshBrowser = freshPane.webContents as Electron.WebContents;
    await until(() => freshBrowser.getURL() === `${siteUrl}/login` && freshBrowser.getTitle() === 'Logged in');
    assert.equal((await profile.cookies.get({ name: 'remembered' })).length, 0);
    assert.equal(await freshBrowser.executeJavaScript(`localStorage.getItem('profile-state')`), null);
    assert.equal(await freshBrowser.executeJavaScript(`sessionStorage.getItem('tab-state')`), null);
    console.log('Desktop: workspace tab resume, 30-day profile expiry, protected API and SSH, top-level page and popup verified');
  } finally {
    window?.close();
    site.close();
  }
}).then(() => app.quit(), error => {
  console.error(error);
  app.exit(1);
});

app.on('quit', () => {
  clearTimeout(deadline);
  try { rmSync(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
  catch { console.warn('Could not remove the temporary desktop profile.'); }
});
