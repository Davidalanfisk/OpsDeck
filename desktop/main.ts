import { app, dialog, shell } from 'electron';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { startDesktop } from './window.ts';
import { createSourceUpdater } from './source-updater.ts';
import { createPortableUpdater } from './portable-updater.ts';

app.setName('OpsDeck');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    const source = app.getAppPath();
    const portablePlatform = process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64'
      : process.platform === 'win32' && process.arch === 'x64' ? 'win-x64' : undefined;
    const updater = app.isPackaged && portablePlatform
      ? createPortableUpdater(join(app.getPath('userData'), 'portable-updates'), app.getVersion(), portablePlatform, path => shell.showItemInFolder(path))
      : createSourceUpdater(join(app.getPath('userData'), 'source-updates'), source, app.getVersion(),
        !app.isPackaged && process.platform === 'darwin' && process.arch === 'arm64');
    await updater.initialize().catch(error => dialog.showErrorBox('OpsDeck updater setup failed',
      `${error instanceof Error ? error.message : 'Unknown error'}\nOpsDeck will still open; automatic updates may not work.`));
    const { window } = await startDesktop(join(app.getPath('userData'), 'workspace'), join(source, 'dist'), 43139, undefined, updater);
    if (process.env.OPSDECK_UPDATE_READY) await writeFile(process.env.OPSDECK_UPDATE_READY, 'ready', { flag: 'wx', mode: 0o600 });
    const updateError = join(app.getPath('userData'), 'source-updates', 'last-error.txt');
    try {
      const message = await readFile(updateError, 'utf8');
      dialog.showErrorBox('OpsDeck update failed', message);
      await rm(updateError);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    app.on('second-instance', () => {
      if (window.isMinimized()) window.restore();
      window.focus();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    dialog.showErrorBox('OpsDeck could not start', error.code === 'EADDRINUSE'
      ? 'Local port 43139 is in use. Close the other process using it and reopen OpsDeck.'
      : 'The desktop workspace could not be opened. Check your user data directory and try again.');
    console.error(error);
    app.exit(1);
  });
}
