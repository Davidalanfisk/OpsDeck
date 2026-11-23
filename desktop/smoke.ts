import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, dialog } from 'electron';
import { startDesktop } from './window.ts';
import { ftpFixture, sftpFixture, text } from '../test/fixtures/remote.mjs';

const temporary = process.env.OPSDECK_SMOKE_PROFILE ?? join(process.cwd(), `.opsdeck-desktop-${randomUUID()}`);
mkdirSync(temporary, { recursive: true });
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
  const cleanups: Array<() => Promise<void>> = [];
  const ftp = await ftpFixture({ after: cleanup => cleanups.push(cleanup) });
  const sshFixture = await sftpFixture({ after: cleanup => cleanups.push(cleanup) });
  ftp.directories.add('/public');
  let websiteId = '';
  let ftpId = '';
  let noteId = '';
  const toolResults: string[] = [];
  let latestPrompt: Array<{ role: string; content: string }> = [];
  const modelServer = createServer(async (request, response) => {
    if (request.url === '/api/ps') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'qwen3:8b', context_length: 16384 }] }));
      return;
    }
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input) as { messages: Array<{ role: string; content: string; tool_name?: string }>;
      tools: Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>;
      truncate: boolean; shift: boolean; options: { num_ctx: number } };
    assert.equal(body.truncate, false);
    assert.equal(body.shift, false);
    assert.equal(body.options.num_ctx, 16_384);
    if (body.tools.length === 0) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ message: { role: 'assistant', content: 'Fixture summary of prior turns.' } }));
      return;
    }
    latestPrompt = body.messages;
    const createNote = body.tools.find(tool => tool.function.name === 'create_note');
    assert.ok(createNote);
    assert.deepEqual(Object.keys(createNote.function.parameters.properties).sort(), ['content', 'title']);
    assert.ok(body.tools.find(tool => tool.function.name === 'create_website'));
    const last = body.messages.at(-1);
    const instruction = body.messages.findLast(message => message.role === 'user')?.content;
    response.setHeader('Content-Type', 'application/json');
    if (last?.role === 'tool') {
      toolResults.push(last.content);
      if (last.tool_name === 'create_website') {
        const created = JSON.parse(last.content) as { id: string };
        response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [
          { function: { name: 'open_pane', arguments: { id: created.id, kind: 'connection' } } },
        ] } }));
        return;
      }
      if (last.tool_name === 'create_note' && instruction === 'Create note') {
        const note = JSON.parse(last.content) as { id: string };
        response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [
          { function: { name: 'read_note', arguments: { id: note.id } } },
        ] } }));
        return;
      }
      if (last.tool_name === 'read_note' && instruction === 'Edit open note') {
        const note = JSON.parse(last.content) as { content: string; updated_at: string };
        response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [
          { function: { name: 'write_note', arguments: { id: noteId, content: `${note.content}\nAgent note edit`, revision: note.updated_at } } },
        ] } }));
        return;
      }
      if (last.tool_name === 'read_file' && ['Edit remote file', 'Conflict remote file', 'Edit open file'].includes(instruction ?? '')) {
        const file = JSON.parse(last.content) as { content: string; revision: string };
        if (instruction === 'Conflict remote file') ftp.files.set('/agent.txt', Buffer.from('external edit'));
        response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [
          { function: { name: 'write_file', arguments: { id: ftpId, path: '/agent.txt', content: instruction === 'Edit open file' ? `${file.content}\nagent draft` : 'agent edit', revision: file.revision } } },
        ] } }));
        return;
      }
      response.end(JSON.stringify({ message: { role: 'assistant', content: 'Fixture response complete.' }, prompt_eval_count: 123, eval_count: 12 }));
    } else {
      if (last?.content === 'List\nworkspace') await delay(350);
      const name = last?.content === 'Inspect website' ? 'inspect_website'
        : ['Edit remote file', 'Conflict remote file', 'Edit open file'].includes(last?.content ?? '') ? 'read_file'
        : last?.content === 'Edit open note' ? 'read_note'
        : last?.content === 'Create note' ? 'create_note'
        : last?.content === 'Create BBC website' ? 'create_website'
        : last?.content === 'Missing note' ? 'write_note' : 'workspace';
      response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [
        { function: { name, arguments: name === 'workspace' ? {} : name === 'inspect_website'
          ? { id: websiteId } : name === 'create_note' ? { title: 'Agent fixture note', content: 'Created by fixture' }
          : name === 'create_website' ? { name: 'Fixture website agent', url: `${siteUrl}/agent` }
          : name === 'write_note' ? { id: 'invented-note', content: 'test', revision: 'invented' }
          : name === 'read_note' ? { id: noteId }
          : { id: ftpId, path: '/agent.txt' } } },
      ] } }));
    }
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const modelOrigin = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;
  const fakeOllama = {
    status: () => ({ phase: 'ready' as const, detail: 'Fixture model ready', memoryBytes: 16 * 1024 ** 3,
      recommended: 'qwen3:8b' as const, model: 'qwen3:8b' as const }),
    setup: async (_model: unknown) => {},
    origin: () => ({ origin: modelOrigin, model: 'qwen3:8b' as const }),
    close: () => {},
  };
  let updateState: import('../shared/update.ts').UpdateStatus = {
    phase: 'idle', current: '0.5.2', supported: false, detail: 'Fixture updater idle',
  };
  let preparedUpdates = 0;
  const fakeUpdater = {
    status: () => updateState,
    initialize: async () => {},
    check: async () => { updateState = { ...updateState, phase: 'available', latest: '0.6.0', detail: 'Fixture update available' }; },
    prepare: async () => { preparedUpdates++; updateState = { ...updateState, phase: 'ready', detail: 'Fixture update ready' }; },
    restart: async (_window: BrowserWindow) => {},
    close: async () => {},
  };
  const site = createServer((request, response) => {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    if (request.url === '/') {
      response.setHeader('Set-Cookie', 'logged-in=yes; Path=/; HttpOnly; SameSite=Lax');
      response.writeHead(302, { Location: '/login' }).end();
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>${request.headers.cookie?.includes('logged-in=yes') ? 'Logged in' : 'Missing cookie'}</title>
        <h1>Local website fixture</h1><input type="password" aria-label="Private password"><input aria-label="Search">
        <button onclick="this.textContent='Clicked fixture'">Fixture button</button>`);
    }
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const directory = join(temporary, 'workspace');
  let window: BrowserWindow | undefined;
  try {
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = (portProbe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    const desktop = await startDesktop(directory, resolve('dist'), port, fakeOllama, fakeUpdater);
    window = desktop.window;
    const workspace = window.webContents;
    const rendererErrors: string[] = [];
    workspace.on('console-message', details => {
      if (/Uncaught|Could not create web worker/.test(details.message)) rendererErrors.push(details.message);
    });
    assert.equal((await fetch(`${desktop.origin}/api/clients`)).status, 403);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('main'))`));
    const result = await workspace.executeJavaScript(`(async () => {
      const call = (path, body) => fetch('/api' + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(res => res.json());
      const client = await call('/clients', { name: 'Desktop fixture', description: '', colour: '#9876ff' });
      const ssh = await call('/clients/' + client.id + '/connections', {
        ...${JSON.stringify(sshFixture.connection)}, name: 'Fixture SSH', type: 'SSH',
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
    websiteId = result.website;
    await workspace.executeJavaScript(`localStorage.setItem('opsdeck:location', JSON.stringify({ clientId: ${JSON.stringify(result.id)} })); location.reload()`);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('[aria-label="Edit Fixture SSH"]'))`));
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Edit Fixture SSH"]').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('dialog[open] input[name="fingerprint"]'))`));
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('dialog[open] button')).find(button => button.textContent === 'Check server key').click()`);
    try {
      await until(() => workspace.executeJavaScript(`document.querySelector('dialog[open]')?.textContent.includes(${JSON.stringify(sshFixture.connection.fingerprint)}) &&
        document.querySelector('dialog[open]')?.textContent.includes('This key is not verified')`));
    } catch (error) {
      throw new Error(`Host key lookup did not complete: ${await workspace.executeJavaScript(`document.querySelector('dialog[open]')?.textContent`)}`, { cause: error });
    }
    assert.deepEqual(sshFixture.authAttempts, []);
    assert.equal(await workspace.executeJavaScript(`document.querySelector('dialog[open] input[name="fingerprint"]').value`),
      'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('dialog[open] button')).find(button => button.textContent.includes('I verified it')).click()`);
    assert.equal(await workspace.executeJavaScript(`document.querySelector('dialog[open] input[name="fingerprint"]').value`), sshFixture.connection.fingerprint);
    await workspace.executeJavaScript(`document.querySelector('dialog[open] input[name="host"]').focus()`);
    await workspace.insertText('x');
    assert.equal(await workspace.executeJavaScript(`document.querySelector('dialog[open] input[name="fingerprint"]').value`), '');
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Close dialog"]').click()`);
    const content = window.contentView;
    await until(() => workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Fixture website')?.click() ?? Boolean(document.querySelector('.desktop-browser-slot'))`));
    const pane = await until(() => content.children.find(view => 'webContents' in view && view.webContents !== workspace));
    assert.ok('webContents' in pane);
    const browser = pane.webContents as Electron.WebContents;
    try {
      await until(() => browser.getTitle() === 'Logged in' && pane.getVisible() && pane.getBounds().width > 0);
    } catch (error) {
      const frames = await workspace.executeJavaScript(`Promise.race([
        new Promise(resolve => requestAnimationFrame(() => resolve(true))),
        new Promise(resolve => setTimeout(() => resolve(false), 500))
      ])`);
      if (!frames) throw new Error('Desktop smoke requires a working graphical display: renderer animation frames stopped.');
      throw error;
    }
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

    ftpId = await workspace.executeJavaScript(`fetch('/api/clients/' + ${JSON.stringify(result.id)} + '/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(ftp.connection)})
    }).then(response => response.json()).then(connection => connection.id)`);
    await workspace.executeJavaScript('location.reload()');
    await until(() => workspace.executeJavaScript(`(() => {
      const button = document.querySelector('button[title="Local fixture"]');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`));
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('.file-login'))`));
    await workspace.executeJavaScript(`document.querySelector('[aria-label="File connection password"]').focus()`);
    await workspace.insertText('fixture-password');
    await workspace.executeJavaScript(`document.querySelector('[name="allowInsecure"]').checked = true;
      document.querySelector('.file-login').requestSubmit();`);
    await until(() => workspace.executeJavaScript(`(() => {
      const button = document.querySelector('.remote-entry button[title="fixture.php"]');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`));
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('.monaco-editor'))`));
    assert.equal(await workspace.executeJavaScript(`Boolean(document.querySelector('.remote-entry-name.file svg'))`), true);
    assert.equal(await workspace.executeJavaScript(`Boolean(document.querySelector('.remote-entry-name.directory[title="public"] svg'))`), true);
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Maximize pane"]').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('[aria-label="Restore pane"]'))`));
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Restore pane"]').click()`);
    const point = await workspace.executeJavaScript(`(() => {
      const box = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect();
      return { x: Math.round(box.x + 20), y: Math.round(box.y + 10) };
    })()`);
    workspace.sendInputEvent({ type: 'mouseDown', button: 'left', ...point, clickCount: 1 });
    workspace.sendInputEvent({ type: 'mouseUp', button: 'left', ...point, clickCount: 1 });
    workspace.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    workspace.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await workspace.insertText('\r\n// desktop editor fixture');
    await until(() => workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Save to server' && !button.disabled)`));
    assert.deepEqual(ftp.files.get('/fixture.php'), text);
    ftp.files.set('/fixture.json', Buffer.from('{"message": "hello"}\r\n'));
    await workspace.executeJavaScript(`(() => { const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Go / Refresh'); button.focus(); button.click(); })()`);
    await until(() => workspace.executeJavaScript(`(() => {
      const button = document.querySelector('.remote-entry button[title="fixture.json"]');
      if (!button || button.disabled) return false;
      button.focus(); button.click(); return true;
    })()`));
    await until(() => workspace.executeJavaScript(`document.querySelector('.remote-editor .panel-toolbar .truncate')?.textContent === '/fixture.json'`));
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.includes('message')`));
    const jsonPoint = await workspace.executeJavaScript(`(() => {
      const box = document.querySelector('.file-editor-host:not([hidden]) .monaco-editor .view-lines').getBoundingClientRect();
      return { x: Math.round(box.x + 20), y: Math.round(box.y + 10) };
    })()`);
    workspace.sendInputEvent({ type: 'mouseDown', button: 'left', ...jsonPoint, clickCount: 1 });
    workspace.sendInputEvent({ type: 'mouseUp', button: 'left', ...jsonPoint, clickCount: 1 });
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.contains(document.activeElement)`));
    workspace.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    workspace.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await workspace.insertText('\r\n// reconnect draft');
    await until(() => workspace.executeJavaScript(`document.querySelector('.remote-editor .panel-toolbar .truncate')?.textContent.includes('Unsaved')`));
    assert.equal(await workspace.executeJavaScript(`document.querySelectorAll('.file-tabs [aria-label="Unsaved"]').length`), 2);
    await workspace.executeJavaScript(`window.confirm = () => false; document.querySelector('[title="/fixture.php"][role="tab"]').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.replace(/\\u00a0/g, ' ').includes('desktop editor fixture')`));
    assert.doesNotMatch(await workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor').textContent`), /reconnect/);
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Close /fixture.json"]').click(); document.querySelector('[aria-label="Close Local fixture"]').click(); document.querySelector('.workspace-bar button').click()`);
    assert.equal(await workspace.executeJavaScript(`document.querySelectorAll('.file-tabs [role="tab"]').length`), 2);
    assert.equal(await workspace.executeJavaScript(`Boolean(document.querySelector('.files-panel'))`), true);
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Save to server').click()`);
    await until(() => ftp.files.get('/fixture.php')?.includes(Buffer.from('// desktop editor fixture')));
    const savedFile = ftp.files.get('/fixture.php');
    assert.ok(savedFile);
    assert.equal(savedFile.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.ok(savedFile.includes(Buffer.from('\r\n')));
    await until(() => workspace.executeJavaScript(`document.querySelectorAll('.file-tabs [aria-label="Unsaved"]').length === 1`));
    await workspace.executeJavaScript(`document.querySelector('[title="/fixture.json"][role="tab"]').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.replace(/\\u00a0/g, ' ').includes('reconnect draft')`));
    const restoredPoint = await workspace.executeJavaScript(`(() => {
      const box = document.querySelector('.file-editor-host:not([hidden]) .monaco-editor .view-lines').getBoundingClientRect();
      return { x: Math.round(box.x + 20), y: Math.round(box.y + 10) };
    })()`);
    workspace.sendInputEvent({ type: 'mouseDown', button: 'left', ...restoredPoint, clickCount: 1 });
    workspace.sendInputEvent({ type: 'mouseUp', button: 'left', ...restoredPoint, clickCount: 1 });
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.contains(document.activeElement)`));
    const restoredText = await workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor').textContent`);
    workspace.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    workspace.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor').textContent !== ${JSON.stringify(restoredText)}`));
    workspace.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] });
    workspace.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] });
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.replace(/\\u00a0/g, ' ').includes('reconnect draft')`));
    ftp.files.set('/fixture.json', Buffer.from('{"changed": true}'));
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Save to server').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-message.error')?.textContent.includes('changed')`));
    assert.equal(ftp.files.get('/fixture.json')?.toString(), '{"changed": true}');
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Reconnect').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('.file-login'))`));
    await workspace.executeJavaScript(`document.querySelector('[aria-label="File connection password"]').focus()`);
    await workspace.insertText('fixture-password');
    await workspace.executeJavaScript(`document.querySelector('[name="allowInsecure"]').checked = true;
      document.querySelector('.file-login').requestSubmit();`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.replace(/\\u00a0/g, ' ').includes('reconnect draft')`));
    assert.equal(ftp.files.get('/fixture.json')?.toString(), '{"changed": true}');
    const prompt = dialog.showMessageBoxSync;
    const views = [...window.contentView.children];
    dialog.showMessageBoxSync = () => 0;
    try {
      const prevented = once(workspace, 'will-prevent-unload', { signal: AbortSignal.timeout(5000) });
      window.close();
      await prevented;
      assert.equal(window.isDestroyed(), false);
      assert.deepEqual(window.contentView.children, views);
    } finally { dialog.showMessageBoxSync = prompt; }
    assert.deepEqual(rendererErrors, []);
    await until(() => workspace.executeJavaScript(`!document.querySelector('[aria-label="Close /fixture.json"]').disabled`));
    await workspace.executeJavaScript(`window.confirm = () => true; document.querySelector('[aria-label="Close /fixture.json"]').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelectorAll('.file-tabs [role="tab"]').length === 1`));
    ftp.files.set('/agent.txt', Buffer.from('original fixture'));
    await workspace.executeJavaScript(`document.querySelector('button[title="Fixture website"]').click()`);
    await until(() => freshPane.getVisible());
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Local agent').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.agent-setup [role="status"]')?.textContent === 'Fixture model ready'`));
    await workspace.executeJavaScript(`(() => { const select = document.querySelector('.agent-setup select'); select.value = 'qwen3:30b-a3b'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.agent-setup')?.textContent.includes('may approach or exceed 24 GB')`));
    await workspace.executeJavaScript(`(() => { const select = document.querySelector('.agent-setup select'); select.value = 'qwen3:8b'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => workspace.executeJavaScript(`!document.querySelector('.agent-setup')?.textContent.includes('Load the selected model before sending')`));
    await until(() => workspace.executeJavaScript(`!document.querySelector('[aria-label="Client project memory"]').disabled`));
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Client project memory"]').focus()`);
    await workspace.insertText('Fixture project fact');
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('.agent-panel button')).find(button => button.textContent === 'Save client memory').click()`);
    await until(() => workspace.executeJavaScript(`fetch('/api/clients/${result.id}/agent-memory').then(response => response.json()).then(data => data.content === 'Fixture project fact')`));
    assert.equal(await workspace.executeJavaScript(`document.querySelector('.agent-input button').disabled`), true);
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('.agent-panel button')).find(button => button.textContent === 'I understand, start chatting').click()`);
    assert.equal(await workspace.executeJavaScript(`!document.querySelector('.agent-warning') && !document.querySelector('.agent-setup')`), true);
    const blocked = await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'inspect').then(() => false, () => true)`);
    assert.equal(blocked, true);
    async function askAgent(prompt: string) {
      await until(() => workspace.executeJavaScript(`!document.querySelector('.agent-thinking')`));
      const previous = await workspace.executeJavaScript(`document.querySelectorAll('.agent-message.assistant').length`);
      await workspace.executeJavaScript(`document.querySelector('[aria-label="Agent instruction"]').focus()`);
      await workspace.insertText(prompt);
      await workspace.executeJavaScript(`document.querySelector('.agent-input').requestSubmit()`);
      await until(() => workspace.executeJavaScript(`document.querySelectorAll('.agent-message.assistant').length >= ${previous + 1}`));
      await until(() => workspace.executeJavaScript(`!document.querySelector('.agent-thinking')`));
    }
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Agent instruction"]').focus()`);
    await workspace.insertText('List');
    workspace.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
    workspace.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    workspace.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
    await until(() => workspace.executeJavaScript(`document.querySelector('[aria-label="Agent instruction"]').value === 'List\\n'`));
    await workspace.insertText('workspace');
    assert.equal(await workspace.executeJavaScript(`document.querySelector('[aria-label="Agent instruction"]').value`), 'List\nworkspace');
    workspace.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    workspace.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(() => workspace.executeJavaScript(`document.querySelector('.agent-thinking')?.textContent.includes('Working')`));
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('.agent-message.assistant'))`));
    assert.equal(await workspace.executeJavaScript(`document.querySelector('.agent-message.user strong').textContent`), 'You');
    assert.equal(await workspace.executeJavaScript(`document.querySelector('.agent-message.assistant strong').textContent`), 'AI');
    assert.match(toolResults.at(-1) ?? '', /Fixture website/);
    await askAgent('Create note');
    assert.match(latestPrompt[0].content, /Fixture project fact/);
    await until(() => workspace.executeJavaScript(`document.querySelector('.agent-panel').textContent.includes('123 prompt tokens')`));
    assert.match(await workspace.executeJavaScript(`document.querySelector('.agent-panel').textContent`), /loaded context: 16,384/);
    const created = JSON.parse(toolResults.at(-2) ?? '{}') as { id: string; title: string };
    noteId = created.id;
    assert.match(created.id, /^[\da-f-]{36}$/);
    assert.match(toolResults.at(-1) ?? '', /Created by fixture/);
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('.agent-panel button')).find(button => button.textContent === 'Compact conversation').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.agent-panel').textContent.includes('Conversation compacted')`));
    await askAgent('Check compacted context');
    assert.match(latestPrompt[0].content, /Fixture summary of prior turns/);
    assert.ok(latestPrompt.some(message => message.content === 'Create note'));
    const notes = await workspace.executeJavaScript(`fetch('/api/clients/${result.id}').then(response => response.json()).then(deck => deck.notes)`) as Array<{ id: string; title: string; content: string }>;
    assert.ok(notes.some(note => note.id === created.id && note.title === 'Agent fixture note' && note.content === 'Created by fixture'));
    await workspace.executeJavaScript(`document.querySelector('button[title="Agent fixture note"]').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('[aria-label="Markdown note content"]'))`));
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Markdown note content"]').focus()`);
    await workspace.insertText('user draft ');
    await until(() => workspace.executeJavaScript(`fetch('/api/clients/${result.id}').then(response => response.json()).then(deck => deck.notes.find(note => note.id === ${JSON.stringify(created.id)})?.content.includes('user draft'))`));
    await askAgent('Edit open note');
    await until(() => workspace.executeJavaScript(`document.querySelector('[aria-label="Markdown note content"]')?.value.includes('Agent note edit')`));
    assert.match(await workspace.executeJavaScript(`document.querySelector('[aria-label="Markdown note content"]').value`), /user draft/);
    await askAgent('Missing note');
    assert.match(toolResults.at(-1) ?? '', /Note not found.*create_note/);
    await askAgent('Create BBC website');
    assert.match(toolResults.at(-2) ?? '', /Fixture website agent/);
    assert.match(toolResults.at(-1) ?? '', /Pane opened/);
    const agentWebsite = await workspace.executeJavaScript(`fetch('/api/clients/${result.id}').then(response => response.json()).then(deck => deck.connections.find(connection => connection.name === 'Fixture website agent'))`) as { id: string; url: string };
    assert.equal(agentWebsite.url, `${siteUrl}/agent`);
    await workspace.executeJavaScript(`document.querySelector('button[title="Fixture website"]').click()`);
    await until(() => freshPane.getVisible());
    await askAgent('Edit remote file');
    assert.equal(ftp.files.get('/agent.txt')?.toString(), 'agent edit');
    await askAgent('Conflict remote file');
    assert.equal(ftp.files.get('/agent.txt')?.toString(), 'external edit');
    assert.match(toolResults.at(-1) ?? '', /remote file changed/i);
    await workspace.executeJavaScript(`document.querySelector('button[title="Local fixture"]').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.files-panel')?.getBoundingClientRect().width > 0`));
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Go / Refresh').click()`);
    await until(() => workspace.executeJavaScript(`(() => { const button = document.querySelector('.remote-entry button[title="agent.txt"]'); if (!button || button.disabled) return false; button.click(); return true; })()`));
    await until(() => workspace.executeJavaScript(`document.querySelector('.remote-editor .panel-toolbar .truncate')?.textContent === '/agent.txt'`));
    const agentPoint = await workspace.executeJavaScript(`(() => { const box = document.querySelector('.file-editor-host:not([hidden]) .monaco-editor .view-lines').getBoundingClientRect(); return { x: Math.round(box.x + 20), y: Math.round(box.y + 10) }; })()`);
    workspace.sendInputEvent({ type: 'mouseDown', button: 'left', ...agentPoint, clickCount: 1 });
    workspace.sendInputEvent({ type: 'mouseUp', button: 'left', ...agentPoint, clickCount: 1 });
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.contains(document.activeElement)`));
    await workspace.insertText('user draft ');
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.replace(/\\u00a0/g, ' ').includes('user draft')`));
    await askAgent('Edit open file');
    await until(() => workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor')?.textContent.replace(/\\u00a0/g, ' ').includes('agent draft')`));
    assert.match(await workspace.executeJavaScript(`document.querySelector('.file-editor-host:not([hidden]) .monaco-editor').textContent.replace(/\\u00a0/g, ' ')`), /user draft/);
    assert.equal(ftp.files.get('/agent.txt')?.toString(), 'external edit');
    await workspace.executeJavaScript(`document.querySelector('button[title="Fixture website"]').click()`);
    await until(() => freshPane.getVisible());
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Agent settings"]').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(document.querySelector('.agent-consent input'))`));
    await workspace.executeJavaScript(`document.querySelector('.agent-consent input').click()`);
    await until(() => workspace.executeJavaScript(`document.querySelector('.agent-consent input').checked`));
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('.agent-panel button')).find(button => button.textContent === 'Done').click()`);
    assert.match(await workspace.executeJavaScript(`document.querySelector('.agent-summary').textContent`), /Website access on/);
    await askAgent('Inspect website');
    assert.match(toolResults.at(-1) ?? '', /Local website fixture/);
    assert.doesNotMatch(toolResults.at(-1) ?? '', /Private password/);
    const inspected = JSON.parse(await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'inspect')`)) as {
      controls: Array<{ index: number; label: string }>;
    };
    const search = inspected.controls.find(control => control.label === 'Search');
    assert.ok(search);
    await freshBrowser.executeJavaScript(`document.querySelector('[aria-label="Search"]').setAttribute('name', 'changed')`);
    assert.equal(await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'type', ${search.index}, 'should not type').then(() => false, () => true)`), true);
    await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'inspect')`);
    await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'type', ${search.index}, 'fixture query')`);
    assert.equal(await freshBrowser.executeJavaScript(`document.querySelector('[aria-label="Search"]').value`), 'fixture query');
    const afterType = JSON.parse(await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'inspect')`)) as typeof inspected;
    const button = afterType.controls.find(control => control.label === 'Fixture button');
    assert.ok(button);
    await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'click', ${button.index})`);
    assert.equal(await freshBrowser.executeJavaScript(`document.querySelector('button').textContent`), 'Clicked fixture');
    await askAgent(`Long request A ${'a'.repeat(8000)}`);
    await askAgent(`Long request B ${'b'.repeat(8000)}`);
    await askAgent(`Long request C ${'c'.repeat(8000)}`);
    assert.equal(await workspace.executeJavaScript(`document.querySelector('.agent-panel').textContent.includes('Earlier complete turns were summarized')`), true);
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Close agent"]').click()`);
    await until(() => workspace.executeJavaScript(`!document.querySelector('.agent-panel')`));
    assert.equal(await workspace.executeJavaScript(`window.opsDeckDesktop.agentWebsite(${JSON.stringify(result.website)}, 'inspect').then(() => false, () => true)`), true);
    updateState = { ...updateState, supported: true };
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Updates').click()`);
    await until(() => workspace.executeJavaScript(`Array.from(document.querySelectorAll('.update-popover button')).some(button => button.textContent === 'Check for updates' && !button.disabled)`));
    await until(() => !freshPane.getVisible());
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('.update-popover button')).find(button => button.textContent === 'Check for updates').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(Array.from(document.querySelectorAll('.update-popover button')).find(button => button.textContent === 'Download and build update'))`));
    assert.equal(preparedUpdates, 0);
    await workspace.executeJavaScript(`Array.from(document.querySelectorAll('.update-popover button')).find(button => button.textContent === 'Download and build update').click()`);
    await until(() => workspace.executeJavaScript(`Boolean(Array.from(document.querySelectorAll('.update-popover button')).find(button => button.textContent === 'Restart and install'))`));
    assert.equal(preparedUpdates, 1);
    await workspace.executeJavaScript(`document.querySelector('[aria-label="Close update settings"]').click()`);
    await until(() => freshPane.getVisible());
    console.log('Desktop: local agent, website opt-in, remote edits, draft safety and browser retention verified');
  } finally {
    window?.destroy();
    site.close();
    modelServer.close();
    for (const cleanup of cleanups) await cleanup();
  }
}).then(() => app.quit(), error => {
  console.error(error);
  app.exit(1);
});

app.on('quit', () => {
  clearTimeout(deadline);
  if (process.env.OPSDECK_SMOKE_PROFILE) return;
  try { rmSync(temporary, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
  catch { console.warn('Could not remove the temporary desktop profile.'); }
});
