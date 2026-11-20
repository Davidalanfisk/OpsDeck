import { BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebPreferences } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserBounds, BrowserState } from '../shared/desktop.ts';
import { createOpsDeckServer } from '../server/app.ts';

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
  try {
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

  type Pane = { view: WebContentsView; url: string; popups: Set<BrowserWindow> };
  const panes = new Map<string, Pane>();
  const profiles = new Set<string>();
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === workspace && event.senderFrame === workspace.mainFrame && event.senderFrame.url === workspacePage;
  function close(id: string) {
    const pane = panes.get(id);
    if (!pane) return;
    panes.delete(id);
    for (const popup of pane.popups) popup.destroy();
    window.contentView.removeChildView(pane.view);
    pane.view.webContents.close();
  }

  const allowedPage = (value: string) => {
    const url = webUrl(value);
    return url && url.origin !== origin && !(url.hostname === '127.0.0.1' && url.port === String(port));
  };
  function protectSite(contents: WebContents, profile: Electron.Session, popups: Set<BrowserWindow>) {
    const permitted = (url: string) => url === 'about:blank' || allowedPage(url);
    contents.on('will-navigate', event => { if (!permitted(event.url)) event.preventDefault(); });
    contents.on('will-redirect', event => { if (event.isMainFrame && !permitted(event.url)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => permitted(url) && popups.size < 8 ? {
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

  ipcMain.handle('browser:open', (event, id: unknown, clientId: unknown, value: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || !idPattern.test(id) ||
        typeof clientId !== 'string' || !idPattern.test(clientId) || !webUrl(value) || typeof value !== 'string' ||
        !allowedPage(value) || panes.size >= 24) throw new Error('Could not open this website pane.');
    close(id);
    const profile = session.fromPartition(`persist:opsdeck-sites-${clientId}`);
    if (!profiles.has(clientId)) {
      profiles.add(clientId);
      profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      profile.setPermissionCheckHandler(() => false);
      profile.webRequest.onBeforeRequest({ urls: [`http://${host}/*`, `ws://${host}/*`] }, (_details, callback) => callback({ cancel: true }));
    }
    const view = new WebContentsView({ webPreferences: { ...secure, session: profile } });
    const pane: Pane = { view, url: value, popups: new Set() };
    const contents = view.webContents;
    panes.set(id, pane);
    view.setVisible(false);
    window.contentView.addChildView(view);
    protectSite(contents, profile, pane.popups);
    let failed = false;
    const notify = () => {
      if (panes.get(id) !== pane || workspace.isDestroyed() || contents.isDestroyed()) return;
      const state: BrowserState = {
        origin: webUrl(contents.getURL())?.origin ?? new URL(value).origin,
        loading: contents.isLoadingMainFrame(), failed,
        canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      };
      workspace.send('browser:state', id, state);
    };
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
    if (!pane) return;
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
  ipcMain.on('browser:close', (event, id: string) => { if (trusted(event)) close(id); });
  ipcMain.handle('browser:action', async (event, id: string, action: unknown) => {
    const pane = trusted(event) ? panes.get(id) : undefined;
    if (!pane) throw new Error('Website pane is unavailable.');
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
    if (event.isMainFrame && !event.isSameDocument) for (const id of panes.keys()) close(id);
  });
  window.on('close', () => { for (const id of panes.keys()) close(id); });
  window.on('closed', () => {
    ipcMain.removeHandler('browser:open');
    ipcMain.removeHandler('browser:action');
    ipcMain.removeAllListeners('browser:layout');
    ipcMain.removeAllListeners('browser:close');
    workspaceSession.webRequest.onBeforeSendHeaders(null);
    server.close(() => db.close());
  });
  await window.loadURL(workspacePage);
  await workspace.setVisualZoomLevelLimits(1, 1);
  return { window, origin };
}
