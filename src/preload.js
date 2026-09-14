'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sub2api', {
  getState: () => ipcRenderer.invoke('get-state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  saveConfig: (values) => ipcRenderer.invoke('save-config', values),
  login: (values) => ipcRenderer.invoke('login', values),
  completeLogin: (values) => ipcRenderer.invoke('complete-login', values),
  setApiKey: (value) => ipcRenderer.invoke('set-api-key', value),
  logout: () => ipcRenderer.invoke('logout'),
  getStats: (accountId) => ipcRenderer.invoke('get-stats', accountId),
  resizeFloat: (width) => ipcRenderer.send('resize-float', width),
  moveFloat: (delta) => ipcRenderer.send('move-float', delta),
  openPanel: () => ipcRenderer.send('open-panel'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onNavigate: (callback) => ipcRenderer.on('navigate', (_event, payload) => callback(payload)),
  close: () => ipcRenderer.send('close-panel')
});
