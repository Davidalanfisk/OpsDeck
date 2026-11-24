import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/desktop.ts';

const bridge: DesktopBridge = {
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updatePrepare: () => ipcRenderer.invoke('update:prepare'),
  updateRestart: () => ipcRenderer.invoke('update:restart'),
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
  ollamaStatus: () => ipcRenderer.invoke('agent:status'),
  ollamaSetup: model => ipcRenderer.invoke('agent:setup', model),
  agentChat: (messages, tools, contextSize) => ipcRenderer.invoke('agent:chat', messages, tools, contextSize),
  agentCancel: () => ipcRenderer.send('agent:cancel'),
  agentWebsiteAccess: clientId => ipcRenderer.invoke('agent:website-access', clientId),
  agentWebsite: (id, action, index, value) => ipcRenderer.invoke('agent:website', id, action, index, value),
};
contextBridge.exposeInMainWorld('opsDeckDesktop', bridge);
