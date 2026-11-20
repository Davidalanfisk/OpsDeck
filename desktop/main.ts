import { app, dialog } from 'electron';
import { join } from 'node:path';
import { startDesktop } from './window.ts';

app.setName('OpsDeck');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    const { window } = await startDesktop(join(app.getPath('userData'), 'workspace'), join(app.getAppPath(), 'dist'));
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
