import { BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebPreferences } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { BrowserBounds, BrowserState } from '../shared/desktop.ts';
import { createOpsDeckServer } from '../server/app.ts';
import { browserProfiles } from './browser-profiles.ts';
import { createOllama } from './ollama.ts';
import type { createSourceUpdater } from './source-updater.ts';
import { z } from 'zod';

const secure: WebPreferences = {
  sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
};
const idPattern = /^[\w-]{1,80}$/;
const authHeader = 'x-opsdeck-desktop';

function webUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { return undefined; }
}

function browserBounds(value: unknown, width: number, height: number): BrowserBounds | undefined {
  if (!value || typeof value !== 'object' || !('x' in value) || !('y' in value) ||
      !('width' in value) || !('height' in value)) return;
  const { x, y, width: w, height: h } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number' ||
      ![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < 1 || h < 1 ||
      x + w > width || y + h > height) return;
  return { x, y, width: w, height: h };
}

export async function startDesktop(directory: string, frontend: string, port = 43139, testOllama?: ReturnType<typeof createOllama>,
  updater?: ReturnType<typeof createSourceUpdater>) {
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const token = randomBytes(32).toString('hex');
  const { server, db } = createOpsDeckServer({
    directory, frontend, origin,
    authorize: request => request.headers.host === host && request.headers[authHeader] === token,
  });
  let browserActivity: ReturnType<typeof browserProfiles>;
  try {
    browserActivity = browserProfiles(db);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const workspaceSession = session.fromPartition('persist:opsdeck-workspace');
  workspaceSession.webRequest.onBeforeSendHeaders({
    urls: [`http://${host}/*`, `ws://${host}/*`],
  }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [authHeader]: token } });
  });
  const window = new BrowserWindow({
    width: 1400, height: 900, title: 'OpsDeck',
    webPreferences: { ...secure, session: workspaceSession, preload: join(__dirname, 'preload.cjs') },
  });
  const workspace = window.webContents;
  const ollama = testOllama ?? createOllama(directory);
  let agentRequest: AbortController | undefined;
  let websiteClient: string | null = null;
  const websiteSnapshots = new Map<string, { url: string; controls: string[] }>();
  workspace.on('will-prevent-unload', event => {
    if (dialog.showMessageBoxSync(window, {
      type: 'warning', message: 'Discard unsaved remote file edits?',
      detail: 'Drafts are not saved locally. Transfers already started are not cancelled.',
      buttons: ['Cancel', 'Discard'], defaultId: 0, cancelId: 0, noLink: true,
    }) === 1) event.preventDefault();
  });
  workspace.setWindowOpenHandler(({ url }) => {
    const external = webUrl(url);
    if (external && external.origin !== origin) void shell.openExternal(external.href).catch(() => {
      console.error('Could not open the system browser.');
    });
    return { action: 'deny' };
  });
  const workspacePage = `${origin}/`;
  workspace.on('will-frame-navigate', event => { if (!event.isMainFrame || event.url !== workspacePage) event.preventDefault(); });
  workspace.on('will-redirect', event => event.preventDefault());
  workspace.on('will-attach-webview', event => event.preventDefault());

  type Pane = {
    view: WebContentsView; url: string; clientId: string; popups: Set<BrowserWindow>;
    attached: boolean; notify: () => void;
  };
  const paneLimit = 24;
  const panes = new Map<string, Pane>();
  const pending = new Map<string, symbol>();
  const profiles = new Set<string>();
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === workspace && event.senderFrame === workspace.mainFrame && event.senderFrame.url === workspacePage;
  const requireTrusted = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error('Untrusted agent request.');
  };
  ipcMain.handle('update:status', event => {
    requireTrusted(event);
    return updater?.status() ?? { phase: 'idle', current: '', supported: false, detail: 'Updates are unavailable in this desktop build.' };
  });
  ipcMain.handle('update:check', event => {
    requireTrusted(event);
    if (!updater) throw new Error('Updates are unavailable in this desktop build.');
    return updater.check();
  });
  ipcMain.handle('update:prepare', event => {
    requireTrusted(event);
    if (!updater) throw new Error('Updates are unavailable in this desktop build.');
    return updater.prepare();
  });
  ipcMain.handle('update:restart', event => {
    requireTrusted(event);
    if (!updater) throw new Error('Updates are unavailable in this desktop build.');
    return updater.restart(window);
  });
  ipcMain.handle('agent:status', event => { requireTrusted(event); return ollama.status(); });
  ipcMain.handle('agent:setup', async (event, model: unknown) => { requireTrusted(event); await ollama.setup(model); });
  ipcMain.handle('agent:chat', async (event, messages: unknown, tools: unknown) => {
    requireTrusted(event);
    if (agentRequest) throw new Error('An agent request is already running.');
    const message = z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string().max(100_000),
      tool_name: z.string().max(80).optional(),
      tool_calls: z.array(z.object({ function: z.object({ name: z.string().max(80), arguments: z.record(z.string(), z.unknown()) }) })).max(8).optional(),
    });
    const safeMessages = z.array(message).min(1).max(100).parse(messages);
    const safeTools = z.array(z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string().max(80), description: z.string().max(1000), parameters: z.object({
        type: z.literal('object'), properties: z.record(z.string(), z.object({ type: z.string(), description: z.string() })),
        required: z.array(z.string()),
      }) }),
    })).max(20).parse(tools);
    if (JSON.stringify({ safeMessages, safeTools }).length > 500_000) throw new Error('The agent conversation is too large. Start a new session.');
    const { origin: endpoint, model } = ollama.origin();
    const controller = new AbortController();
    agentRequest = controller;
    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: safeMessages, tools: safeTools, stream: false, think: false,
          truncate: false, shift: false, options: { num_ctx: 16_384 } }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]),
      });
      if (!response.ok) throw new Error(`Local model request failed (HTTP ${response.status}). The conversation may be too long; try New chat or shorter input.`);
      if (!response.body) throw new Error('The local model returned an empty response.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
        size += chunk.length;
        if (size > 512_000) throw new Error('The local model response was too large.');
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('The local model returned invalid JSON.'); }
      const result = z.object({ message }).parse(body).message;
      if (result.role !== 'assistant') throw new Error('The local model returned an invalid response.');
      return result;
    } finally { if (agentRequest === controller) agentRequest = undefined; }
  });
  ipcMain.on('agent:cancel', event => { if (trusted(event)) agentRequest?.abort(); });
  ipcMain.handle('agent:website-access', (event, clientId: unknown) => {
    requireTrusted(event);
    if (clientId !== null && (typeof clientId !== 'string' || !idPattern.test(clientId) ||
      !db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId))) throw new Error('Client not found.');
    websiteClient = clientId;
    websiteSnapshots.clear();
  });
  ipcMain.handle('agent:website', async (event, id: unknown, action: unknown, index: unknown, value: unknown) => {
    requireTrusted(event);
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid website pane.');
    const pane = panes.get(id);
    if (!websiteClient || !pane?.attached || pane.clientId !== websiteClient || !pane.view.getVisible()) {
      throw new Error('Enable website access for this session and show the requested website pane.');
    }
    if (!['inspect', 'click', 'type'].includes(String(action))) throw new Error('Invalid website action.');
    if (action !== 'inspect' && (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > 999)) throw new Error('Invalid control number.');
    if (action === 'type' && (typeof value !== 'string' || value.length > 2000)) throw new Error('Invalid input.');
    const snapshot = websiteSnapshots.get(id);
    if (action !== 'inspect' && (!snapshot || snapshot.url !== pane.view.webContents.getURL() || !snapshot.controls[Number(index)])) {
      throw new Error('Inspect the current website before interacting with it.');
    }
    const script = `(() => {
      const action = ${JSON.stringify(action)}, index = ${JSON.stringify(index)}, value = ${JSON.stringify(value)};
      const expected = ${JSON.stringify(snapshot?.controls[Number(index)])};
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const safe = el => !el.matches('input[type=password],input[type=hidden],input[autocomplete*="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]') &&
        (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ||
          !/password|passcode|otp|verification|secret|token|credit.card/i.test([el.name, el.id, el.placeholder, el.autocomplete, el.getAttribute('aria-label')].join(' ')));
      const controls = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button]')).filter(el => visible(el) && safe(el)).slice(0, 1000);
      const signature = el => JSON.stringify([el.tagName, el.getAttribute('type'), el.getAttribute('id'), el.getAttribute('name'),
        el.getAttribute('role'), el.getAttribute('href'), el.getAttribute('aria-label'), (el.innerText || '').slice(0, 160)]);
      if (action === 'inspect') return JSON.stringify({ origin: location.origin, text: (document.body?.innerText || '').slice(0, 12000),
        controls: controls.map((el, i) => ({ index: i, type: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || '').slice(0, 160), signature: signature(el) })).slice(0, 150) });
      const el = controls[index];
      if (!el || signature(el) !== expected) throw new Error('Control changed. Inspect the page again.');
      if (action === 'click') { el.click(); return 'Clicked control ' + index; }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.disabled || el.readOnly || !safe(el)) throw new Error('This input cannot be edited by the agent.');
      const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Input is unavailable.');
      setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Updated control ' + index;
    })()`;
    const url = pane.view.webContents.getURL();
    let result: string;
    try { result = String(await pane.view.webContents.executeJavaScript(script)); }
    catch { throw new Error('Website action failed. Inspect the page again and check the selected control.'); }
    if (action === 'inspect') {
      if (pane.view.webContents.getURL() !== url || websiteClient !== pane.clientId) throw new Error('Website changed during inspection.');
      const data = z.object({ origin: z.string(), text: z.string(), controls: z.array(z.object({
        index: z.number(), type: z.string(), label: z.string(), signature: z.string(),
      })).max(150) }).parse(JSON.parse(result));
      websiteSnapshots.set(id, { url, controls: data.controls.map(control => control.signature) });
      return JSON.stringify({ ...data, controls: data.controls.map(({ signature: _signature, ...control }) => control) });
    }
    websiteSnapshots.delete(id);
    return result;
  });
  function close(id: string) {
    websiteSnapshots.delete(id);
    const pane = panes.get(id);
    if (!pane) return;
    panes.delete(id);
    for (const popup of pane.popups) if (!popup.isDestroyed()) popup.destroy();
    if (pane.attached && !window.isDestroyed()) window.contentView.removeChildView(pane.view);
    if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close();
  }
  function release(id: string) {
    websiteSnapshots.delete(id);
    pending.delete(id);
    const pane = panes.get(id);
    if (!pane?.attached) return;
    pane.view.setVisible(false);
    window.contentView.removeChildView(pane.view);
    pane.attached = false;
    for (const popup of pane.popups) popup.destroy();
    browserActivity.markUsed(pane.clientId);
    // Evict the least recently released pane first.
    panes.delete(id);
    panes.set(id, pane);
  }
  function closeClientTabs(id: string) {
    for (const [key, pane] of panes) if (pane.clientId === id) close(key);
  }
  function sweep() {
    browserActivity.sweep(new Set([...panes.values()].filter(pane => pane.attached).map(pane => pane.clientId)), closeClientTabs);
  }
  sweep();
  const profileTimer = setInterval(sweep, 60 * 60 * 1000).unref();

  const allowedPage = (value: string) => {
    const url = webUrl(value);
    return url && url.origin !== origin && !(url.hostname === '127.0.0.1' && url.port === String(port));
  };
  function protectSite(contents: WebContents, profile: Electron.Session, popups: Set<BrowserWindow>) {
    const permitted = (url: string) => url === 'about:blank' || allowedPage(url);
    contents.on('will-navigate', event => { if (!permitted(event.url)) event.preventDefault(); });
    contents.on('will-redirect', event => { if (event.isMainFrame && !permitted(event.url)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => permitted(url) && popups.size < 8 &&
      [...panes.values()].some(pane => pane.attached && pane.popups === popups) ? {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: window, width: 900, height: 720, title: 'Website sign-in',
        webPreferences: { ...secure, preload: undefined, session: profile },
      },
    } : { action: 'deny' });
    contents.on('did-create-window', (popup) => {
      popups.add(popup);
      popup.on('closed', () => popups.delete(popup));
      protectSite(popup.webContents, profile, popups);
      const title = () => popup.setTitle(webUrl(popup.webContents.getURL())?.origin ?? 'Website sign-in');
      popup.on('page-title-updated', event => event.preventDefault());
      popup.webContents.on('did-navigate', title);
      title();
    });
  }

  ipcMain.handle('browser:open', async (event, id: unknown, clientId: unknown, value: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || !idPattern.test(id) ||
        typeof clientId !== 'string' || !idPattern.test(clientId) || !webUrl(value) || typeof value !== 'string' ||
        !allowedPage(value) || (!pending.has(id) && pending.size >= paneLimit)) throw new Error('Could not open this website pane.');
    const request = Symbol();
    pending.set(id, request);
    let profile: Electron.Session;
    try {
      if ([...panes.values()].some(pane => pane.attached && pane.clientId === clientId)) browserActivity.markUsed(clientId);
      profile = await browserActivity.open(clientId, closeClientTabs);
      if (pending.get(id) !== request || workspace.isDestroyed() || !trusted(event)) return;
    } finally {
      if (pending.get(id) === request) pending.delete(id);
    }
    const cached = panes.get(id);
    if (cached?.clientId === clientId && cached.url === value && !cached.view.webContents.isDestroyed() &&
        !cached.view.webContents.isCrashed()) {
      if (!cached.attached) window.contentView.addChildView(cached.view);
      cached.attached = true;
      cached.notify();
      return;
    }
    close(id);
    if (panes.size >= paneLimit) {
      const idle = [...panes].find(([, pane]) => !pane.attached);
      if (!idle) throw new Error('Too many website panes are open.');
      close(idle[0]);
    }
    if (!profiles.has(clientId)) {
      profiles.add(clientId);
      profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      profile.setPermissionCheckHandler(() => false);
      profile.webRequest.onBeforeRequest({ urls: [`http://${host}/*`, `ws://${host}/*`] }, (_details, callback) => callback({ cancel: true }));
    }
    const view = new WebContentsView({ webPreferences: { ...secure, session: profile } });
    const contents = view.webContents;
    let failed = false;
    const notify = () => {
      if (!pane.attached || panes.get(id) !== pane || workspace.isDestroyed() || contents.isDestroyed()) return;
      const state: BrowserState = {
        origin: webUrl(contents.getURL())?.origin ?? new URL(value).origin,
        loading: contents.isLoadingMainFrame(), failed,
        canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      };
      workspace.send('browser:state', id, state);
    };
    const pane: Pane = { view, url: value, clientId, popups: new Set(), attached: true, notify };
    panes.set(id, pane);
    view.setVisible(false);
    window.contentView.addChildView(view);
    protectSite(contents, profile, pane.popups);
    contents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) { failed = false; notify(); } });
    contents.on('did-navigate', notify);
    contents.on('did-stop-loading', notify);
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { failed = true; notify(); }
    });
    contents.on('render-process-gone', () => { failed = true; notify(); });
    void contents.loadURL(value).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_ABORTED') { failed = true; notify(); }
    });
    notify();
  });

  ipcMain.on('browser:layout', (event, id: string, value: unknown) => {
    if (!trusted(event)) return;
    const pane = panes.get(id);
    if (!pane?.attached) return;
    const [width, height] = window.getContentSize();
    const zoom = workspace.getZoomFactor();
    const bounds = browserBounds(value, Math.ceil(width / zoom), Math.ceil(height / zoom));
    if (bounds) {
      const x = Math.round(bounds.x * zoom);
      const y = Math.round(bounds.y * zoom);
      pane.view.setBounds({
        x, y, width: Math.min(width - x, Math.round(bounds.width * zoom)),
        height: Math.min(height - y, Math.round(bounds.height * zoom)),
      });
    }
    pane.view.setVisible(Boolean(bounds));
  });
  ipcMain.on('browser:release', (event, id: string) => { if (trusted(event)) release(id); });
  ipcMain.handle('browser:action', async (event, id: string, action: unknown) => {
    const pane = trusted(event) ? panes.get(id) : undefined;
    if (!pane?.attached) throw new Error('Website pane is unavailable.');
    const contents = pane.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') {
      if (contents.getURL()) contents.reload();
      else await contents.loadURL(pane.url);
    }
    // Open the configured URL, not a transient login URL that might contain credentials or tokens.
    if (action === 'external') await shell.openExternal(pane.url);
  });
  workspace.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) {
      websiteClient = null;
      websiteSnapshots.clear();
      pending.clear();
      for (const id of [...panes.keys()]) release(id);
    }
  });
  window.on('closed', () => {
    void updater?.close();
    agentRequest?.abort();
    ollama.close();
    pending.clear();
    for (const [id, pane] of panes) {
      if (pane.attached) browserActivity.markUsed(pane.clientId);
      close(id);
    }
    clearInterval(profileTimer);
    ipcMain.removeHandler('browser:open');
    for (const name of ['status', 'check', 'prepare', 'restart']) ipcMain.removeHandler(`update:${name}`);
    ipcMain.removeHandler('browser:action');
    ipcMain.removeHandler('agent:status');
    ipcMain.removeHandler('agent:setup');
    ipcMain.removeHandler('agent:chat');
    ipcMain.removeHandler('agent:website-access');
    ipcMain.removeHandler('agent:website');
    ipcMain.removeAllListeners('agent:cancel');
    ipcMain.removeAllListeners('browser:layout');
    ipcMain.removeAllListeners('browser:release');
    workspaceSession.webRequest.onBeforeSendHeaders(null);
    server.close(() => { void browserActivity.settle().then(() => db.close()); });
  });
  await window.loadURL(workspacePage);
  await workspace.setVisualZoomLevelLimits(1, 1);
  return { window, origin };
}
