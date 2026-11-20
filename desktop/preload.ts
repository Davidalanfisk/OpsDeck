import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/desktop.ts';

const bridge: DesktopBridge = {
  open: (id, clientId, url) => ipcRenderer.invoke('browser:open', id, clientId, url),
  release: id => ipcRenderer.send('browser:release', id),
  layout: (id, bounds) => ipcRenderer.send('browser:layout', id, bounds),
  action: (id, action) => ipcRenderer.invoke('browser:action', id, action),
  onState: (id, notify) => {
    const listener = (_event: unknown, key: string, state: Parameters<typeof notify>[0]) => {
      if (key === id) notify(state);
    };
    ipcRenderer.on('browser:state', listener);
    return () => { ipcRenderer.removeListener('browser:state', listener); };
  },
};
contextBridge.exposeInMainWorld('opsDeckDesktop', bridge);
