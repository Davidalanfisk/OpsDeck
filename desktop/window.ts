import { BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebPreferences } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserBounds, BrowserState } from '../shared/desktop.ts';
import { createOpsDeckServer } from '../server/app.ts';
import { browserProfiles } from './browser-profiles.ts';

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

export async function startDesktop(directory: string, frontend: string, port = 43139) {
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
  function close(id: string) {
    const pane = panes.get(id);
    if (!pane) return;
    panes.delete(id);
    for (const popup of pane.popups) popup.destroy();
    if (pane.attached) window.contentView.removeChildView(pane.view);
    if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close();
  }
  function release(id: string) {
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
      pending.clear();
      for (const id of [...panes.keys()]) release(id);
    }
  });
  window.on('close', () => {
    pending.clear();
    for (const [id, pane] of panes) {
      if (pane.attached) browserActivity.markUsed(pane.clientId);
      close(id);
    }
  });
  window.on('closed', () => {
    clearInterval(profileTimer);
    ipcMain.removeHandler('browser:open');
    ipcMain.removeHandler('browser:action');
    ipcMain.removeAllListeners('browser:layout');
    ipcMain.removeAllListeners('browser:release');
    workspaceSession.webRequest.onBeforeSendHeaders(null);
    server.close(() => { void browserActivity.settle().then(() => db.close()); });
  });
  await window.loadURL(workspacePage);
  await workspace.setVisualZoomLevelLimits(1, 1);
  return { window, origin };
}
