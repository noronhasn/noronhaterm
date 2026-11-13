'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const EVENTS = new Set(['session:data', 'session:close', 'session:status', 'prompt:ask']);

contextBridge.exposeInMainWorld('api', {
  users: () => inv('users:list'),
  createVault: (u, p) => inv('vault:create', u, p),
  unlock: (u, p) => inv('vault:unlock', u, p),
  lock: () => inv('vault:lock'),
  changePassword: (p) => inv('vault:changePassword', p),
  snapshot: () => inv('store:snapshot'),
  call: (method, ...args) => inv('store:call', method, args),
  publicKey: (id) => inv('keys:publicKey', id),
  copyId: (hostId, keyId) => inv('keys:copyId', hostId, keyId),

  open: (opts) => inv('session:open', opts),
  input: (id, d) => ipcRenderer.send('session:input', id, d),
  resize: (id, c, r) => ipcRenderer.send('session:resize', id, c, r),
  close: (id) => ipcRenderer.send('session:close', id),
  answerPrompt: (id, v) => ipcRenderer.send('prompt:answer', id, v),

  serialList: () => inv('serial:list'),
  sftpList: (id, dir) => inv('sftp:list', id, dir),
  sftpDownload: (id, remote) => inv('sftp:download', id, remote),
  sftpUpload: (id, dir) => inv('sftp:upload', id, dir),

  exportData: (withSecrets) => inv('data:export', withSecrets),
  importData: () => inv('data:import'),
  importSshConfig: () => inv('data:importSshConfig'),

  backupGet: () => inv('backup:get'),
  backupSet: (p) => inv('backup:set', p),
  backupPickFolder: () => inv('backup:pickFolder'),
  backupNow: () => inv('backup:now'),

  serversStatus: () => inv('servers:status'),
  serversApply: (p) => inv('servers:apply', p),
  serversPickRoot: () => inv('servers:pickRoot'),
  serversAddresses: () => inv('servers:addresses'),

  on: (ch, cb) => { if (EVENTS.has(ch)) ipcRenderer.on(ch, (_e, ...a) => cb(...a)); },
});
