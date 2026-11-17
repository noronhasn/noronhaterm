'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const EVENTS = new Set(['session:data', 'session:close', 'session:status', 'prompt:ask', 'update:progress', 'update:ready', 'update:error']);

contextBridge.exposeInMainWorld('api', {
  version: () => inv('app:version'),
  localShells: () => inv('local:shells'),
  changelog: () => inv('app:changelog'),
  updateCheck: () => inv('update:check'),
  updateDownload: () => inv('update:download'),
  updateInstall: () => inv('update:install'),
  openExternal: (url) => inv('app:openExternal', url),
  users: () => inv('users:list'),
  createVault: (u, p) => inv('vault:create', u, p),
  unlock: (u, p) => inv('vault:unlock', u, p),
  rememberCan: () => inv('remember:can'),
  rememberHas: (u) => inv('remember:has', u),
  rememberSet: (u, p, on) => inv('remember:set', u, p, on),
  rememberAuto: () => inv('remember:auto'),
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
  rdpOpen: (hostId) => inv('rdp:open', hostId),
  sftpList: (id, dir) => inv('sftp:list', id, dir),
  sftpDownload: (id, remote) => inv('sftp:download', id, remote),
  sftpUpload: (id, dir) => inv('sftp:upload', id, dir),
  ftpOpen: (hostId, creds) => inv('ftpc:open', hostId, creds),
  ftpList: (id, dir) => inv('ftpc:list', id, dir),
  ftpDownload: (id, remote) => inv('ftpc:download', id, remote),
  ftpUpload: (id, dir) => inv('ftpc:upload', id, dir),
  ftpClose: (id) => inv('ftpc:close', id),
  scpDownload: (id, remote) => inv('scp:download', id, remote),
  scpUpload: (id, remote) => inv('scp:upload', id, remote),

  exportData: (withSecrets) => inv('data:export', withSecrets),
  importData: () => inv('data:import'),
  importSshConfig: () => inv('data:importSshConfig'),

  backupGet: () => inv('backup:get'),
  backupSet: (p) => inv('backup:set', p),
  backupPickFolder: () => inv('backup:pickFolder'),
  logsGet: () => inv('logs:get'),
  logsSet: (p) => inv('logs:set', p),
  logsPickFolder: () => inv('logs:pickFolder'),
  logsOpenFolder: () => inv('logs:openFolder'),
  backupPickFile: () => inv('backup:pickFile'),
  backupRestore: (file, pw) => inv('backup:restore', file, pw),
  backupNow: () => inv('backup:now'),

  serversStatus: () => inv('servers:status'),
  serversApply: (p) => inv('servers:apply', p),
  serversPickRoot: () => inv('servers:pickRoot'),
  serversAddresses: () => inv('servers:addresses'),

  on: (ch, cb) => { if (EVENTS.has(ch)) ipcRenderer.on(ch, (_e, ...a) => cb(...a)); },
});
