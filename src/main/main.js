'use strict';
// Aberto pelo menu não há terminal: escrever em stdout/stderr pode dar EPIPE/EIO e derrubar o app. Ignora esses erros.
for (const st of [process.stdout, process.stderr]) { try { st.on('error', () => {}); } catch { /* sem stream */ } }
process.on('uncaughtException', (e) => {
  try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'netdeck-erro.log'), `${new Date().toISOString()} ${e && e.stack || e}\n`); } catch { /* ignora */ }
});
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Vault } = require('../core/vault');
const { Store } = require('../core/store');
const { SshSession, connectOnly } = require('./ssh');
const { TelnetSession } = require('./telnet');
const { SerialSession, listPorts } = require('./serial');
const { BackupScheduler, restoreVault } = require('./backup');
const { Remember } = require('./remember');
const rdp = require('./rdp');
const { ServerManager } = require('./servers');
const { SessionLogger } = require('./sessionlog');

let win = null;
let store = null;
let backup = null;
let servers = null;
let sessionLog = null;
const logs = new Map(); // sessionId -> arquivo de log aberto
const sessions = new Map();
const pendingPrompts = new Map();

const vaultDir = () => path.join(app.getPath('userData'), 'vaults');
const validUser = (u) => typeof u === 'string' && /^[\p{L}\p{N}_.-]{1,40}$/u.test(u);
const vaultFile = (u) => {
  if (!validUser(u)) throw new Error('Nome de usuário inválido (use letras, números, _ . -)');
  return path.join(vaultDir(), u + '.vault');
};
const requireStore = () => { if (!store) throw new Error('Cofre bloqueado'); return store; };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 560, backgroundColor: '#14161b', title: 'NetDeck', icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // diagnóstico: erros da interface aparecem no terminal; F12 abre as ferramentas do desenvolvedor
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message, line, source) => console.log(`[interface:${level}] ${message} (${source}:${line})`));
  wc.on('preload-error', (_e, p, err) => console.error('[preload-error]', p, err));
  wc.on('render-process-gone', (_e, d) => console.error('[render-process-gone]', d));
  wc.on('did-fail-load', (_e, code, desc, url) => console.error('[did-fail-load]', code, desc, url));
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && String(input.key).toLowerCase() === 'i'))) wc.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---- Dados enviados à interface: nunca incluem senhas nem chaves privadas ----
function snapshot() {
  const d = requireStore().data;
  return {
    folders: d.folders,
    hosts: d.hosts,
    identities: d.identities.map(({ password, ...i }) => ({ ...i, hasPassword: !!password })),
    keys: d.keys.map(({ privateKey, passphrase, ...k }) => ({ ...k, hasPassphrase: !!passphrase })),
  };
}

const CALLABLE = new Set([
  'addFolder', 'updateFolder', 'removeFolder', 'moveFolder',
  'addHost', 'updateHost', 'removeHost', 'moveHost', 'duplicateHost',
  'addIdentity', 'updateIdentity', 'removeIdentity',
  'generateKey', 'importKey', 'removeKey',
]);

const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };

function askRenderer(title, label, secret) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingPrompts.set(id, resolve);
    send('prompt:ask', id, title, label, !!secret);
  });
}

const hostKeys = {
  check: (hp, fp) => requireStore().checkHostKey(hp, fp),
  trust: (hp, algo, fp) => requireStore().trustHostKey(hp, algo, fp),
  async confirm({ hostport, algo, fingerprint, changed }) {
    const r = await dialog.showMessageBox(win, {
      type: changed ? 'warning' : 'question',
      title: changed ? 'ALERTA: a chave do servidor mudou' : 'Servidor desconhecido',
      message: changed
        ? `A chave de ${hostport} é diferente da registrada.\nIsso pode indicar um ataque (man-in-the-middle) ou reinstalação do servidor.`
        : `Primeira conexão com ${hostport}.`,
      detail: `${algo}\n${fingerprint}\n\nConfirme o fingerprint por um canal confiável antes de continuar.`,
      buttons: changed ? ['Cancelar', 'Aceitar nova chave'] : ['Cancelar', 'Confiar e conectar'],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    return r.response === 1;
  },
};

function adhocHost(a) {
  const protocol = a.protocol || 'ssh';
  return {
    id: null, name: a.address || a.serial?.port || 'Conexão rápida', protocol, address: a.address, port: Number(a.port) || (protocol === 'telnet' ? 23 : 22),
    serial: a.serial || null, jumpChain: [], startupCommands: [], forwards: [], telnetEnter: 'crlf',
    // sem senha informada, a conexão rápida pergunta a senha (não é salva em lugar nenhum)
    identity: a.username ? { username: a.username, password: a.password || '', privateKey: '', passphrase: '', useAgent: false } : null,
  };
}

function buildSession(resolved, cols, rows, id) {
  const common = {
    host: resolved, cols, rows,
    onData: (d) => { const l = logs.get(id); if (l) l.write(d); send('session:data', id, d); },
    onClose: (reason) => { closeLog(id, reason); sessions.delete(id); send('session:close', id, reason); },
    onStatus: (msg) => { const l = logs.get(id); if (l) l.write('[' + msg + ']\r\n'); send('session:status', id, msg); },
  };
  if (sessionLog) {
    const l = sessionLog.open({ name: resolved.name, address: resolved.address || (resolved.serial && resolved.serial.port), protocol: resolved.protocol });
    if (l) { logs.set(id, l); send('session:status', id, 'Gravando log em ' + l.file); }
  }
  if (resolved.protocol === 'telnet') return new TelnetSession(common);
  if (resolved.protocol === 'serial') return new SerialSession(common);
  return new SshSession({ ...common, hostKeys, prompt: askRenderer });
}

function closeLog(id, reason) { const l = logs.get(id); if (l) { logs.delete(id); l.close(reason); } }

const getSession = (id) => { const s = sessions.get(id); if (!s) throw new Error('Sessão não encontrada'); return s; };
const getSsh = (id) => { const s = getSession(id); if (!(s instanceof SshSession)) throw new Error('Disponível só para sessões SSH'); return s; };

function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('users:list', () => {
    fs.mkdirSync(vaultDir(), { recursive: true });
    return fs.readdirSync(vaultDir()).filter((f) => f.endsWith('.vault')).map((f) => f.slice(0, -6)).sort();
  });

  ipcMain.handle('vault:create', (_e, user, password) => {
    const v = Vault.create(vaultFile(user), password, {});
    store = new Store(v);
    return snapshot();
  });

  ipcMain.handle('vault:unlock', (_e, user, password) => {
    const f = vaultFile(user);
    if (!Vault.exists(f)) throw new Error('Usuário não encontrado');
    store = new Store(Vault.open(f, password));
    return snapshot();
  });

  const remember = () => new Remember({
    file: path.join(app.getPath('userData'), 'remember.json'),
    enc: (t) => safeStorage.encryptString(t), dec: (b) => safeStorage.decryptString(b),
  });
  const canRemember = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return !(safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === 'basic_text'); // Linux sem chaveiro = sem proteção real
    } catch { return false; }
  };
  ipcMain.handle('remember:can', () => canRemember());
  ipcMain.handle('remember:has', (_e, user) => remember().has(user));
  ipcMain.handle('remember:set', (_e, user, password, on) => {
    if (!on) { remember().forget(user); return false; }
    if (!canRemember()) throw new Error('Este computador não tem como guardar a senha com segurança (falta o chaveiro do sistema).');
    remember().set(user, password);
    return true;
  });
  ipcMain.handle('remember:auto', () => { // abre direto o último usuário lembrado, só ao iniciar o app
    const r = remember();
    const l = r.last();
    if (!l) return null;
    try {
      store = new Store(Vault.open(vaultFile(l.user), l.password));
      return { user: l.user, snapshot: snapshot() };
    } catch { r.forget(l.user); return null; }
  });
  ipcMain.handle('vault:lock', () => { if (store) { store.vault.lock(); store = null; } });
  ipcMain.handle('vault:changePassword', (_e, pw) => {
    requireStore().vault.changePassword(pw);
    const user = path.basename(store.vault.file, '.vault');
    const r = remember();
    if (r.has(user)) { try { r.set(user, pw); } catch { r.forget(user); } } // mantém a senha lembrada em dia
  });
  ipcMain.handle('store:snapshot', () => snapshot());

  ipcMain.handle('store:call', (_e, method, args) => {
    if (!CALLABLE.has(method)) throw new Error('Operação não permitida');
    const r = requireStore()[method](...(Array.isArray(args) ? args : []));
    return { result: r && r.id ? { id: r.id } : null, snapshot: snapshot() };
  });

  ipcMain.handle('keys:publicKey', (_e, id) => requireStore()._need(requireStore()._key(id), 'Chave').publicKey);

  ipcMain.handle('rdp:open', (_e, hostId) => rdp.launch(requireStore().resolveHost(hostId)));
  ipcMain.handle('session:open', async (_e, { id, hostId, adhoc, cols, rows }) => {
    const st = requireStore();
    // o id vem da interface (a aba já existe e recebe os eventos desde o primeiro byte)
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || sessions.has(id)) throw new Error('Identificador de sessão inválido');
    const resolved = hostId ? st.resolveHost(hostId) : adhocHost(adhoc || {});
    const s = buildSession(resolved, cols, rows, id);
    sessions.set(id, s);
    try {
      await s.start();
    } catch (e) {
      sessions.delete(id); closeLog(id, 'falha ao conectar');
      try { s.close(); } catch { /* ignora */ }
      throw new Error(e.message || String(e));
    }
    if (hostId) st.touch(hostId);
    return { id, name: resolved.name, protocol: resolved.protocol, snapshot: hostId ? snapshot() : null };
  });

  ipcMain.on('session:input', (_e, id, data) => { const s = sessions.get(id); if (s && typeof data === 'string') s.write(data); });
  ipcMain.on('session:resize', (_e, id, cols, rows) => { const s = sessions.get(id); if (s && cols > 0 && rows > 0) s.resize(cols, rows); });
  ipcMain.on('session:close', (_e, id) => { const s = sessions.get(id); if (s) s.close(); sessions.delete(id); closeLog(id, 'fechada pelo usuário'); });
  ipcMain.on('prompt:answer', (_e, id, value) => { const r = pendingPrompts.get(id); if (r) { pendingPrompts.delete(id); r(value); } });

  ipcMain.handle('serial:list', () => listPorts());

  ipcMain.handle('sftp:list', (_e, id, dir) => getSsh(id).sftpList(dir));
  ipcMain.handle('sftp:download', async (_e, id, remote) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remote)) });
    if (r.canceled) return null;
    await getSsh(id).sftpDownload(remote, r.filePath);
    return r.filePath;
  });
  ipcMain.handle('sftp:upload', async (_e, id, remoteDir) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) out.push(await getSsh(id).sftpUpload(f, remoteDir));
    return out;
  });

  // ssh-copy-id: conecta ao host (com a identidade dele) e instala a chave pública escolhida
  ipcMain.handle('keys:copyId', async (_e, hostId, keyId) => {
    const st = requireStore();
    const key = st._need(st._key(keyId), 'Chave');
    const s = await connectOnly({ host: st.resolveHost(hostId), hostKeys, prompt: askRenderer });
    try { await s.installPublicKey(key.publicKey); } finally { s.close(); }
  });

  ipcMain.handle('data:export', async (_e, includeSecrets) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'netdeck-export.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(requireStore().exportData({ includeSecrets: !!includeSecrets }), null, 2), { mode: 0o600 });
    return r.filePath;
  });
  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    const n = requireStore().importData(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    return { added: n, snapshot: snapshot() };
  });
  // ---- backup automático (copia os cofres já criptografados para uma pasta, ex.: a do Google Drive)
  ipcMain.handle('backup:get', () => backup.get());
  ipcMain.handle('backup:set', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    return backup.set({ enabled: p.enabled, folder: p.folder, intervalMinutes: p.intervalMinutes, keep: p.keep });
  });
  ipcMain.handle('backup:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Pasta de destino do backup' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('backup:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Escolha o arquivo de backup (.vault)', filters: [{ name: 'Cofre NetDeck', extensions: ['vault'] }, { name: 'Todos', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  // restaura um backup no lugar do cofre do usuário atual; exige a senha mestra DAQUELE backup
  ipcMain.handle('backup:restore', (_e, file, password) => {
    const cur = requireStore().vault.file;
    const saved = restoreVault({ src: file, dest: cur, password });
    store.vault.lock();
    store = new Store(Vault.open(cur, password));
    return { snapshot: snapshot(), saved: saved ? path.basename(saved) : null };
  });
  ipcMain.handle('logs:get', () => sessionLog.get());
  ipcMain.handle('logs:set', (_e, p) => { const q = p && typeof p === 'object' ? p : {}; return sessionLog.set({ enabled: q.enabled, folder: q.folder, timestamps: q.timestamps }); });
  ipcMain.handle('logs:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Pasta dos logs de sessão' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('logs:openFolder', async () => {
    const dir = sessionLog.folder(); fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir); if (err) throw new Error(err);
  });
  ipcMain.handle('backup:now', () => { const r = backup.runNow(); return { files: r.files.length, state: backup.get() }; });

  // ---- servidores TFTP / FTP
  ipcMain.handle('servers:status', () => servers.status());
  ipcMain.handle('servers:apply', async (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    return servers.apply({ root: p.root, tftp: p.tftp, ftp: p.ftp });
  });
  ipcMain.handle('servers:pickRoot', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Pasta raiz dos servidores TFTP/FTP' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('servers:addresses', () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address));

  ipcMain.handle('data:importSshConfig', async () => {
    const def = path.join(os.homedir(), '.ssh');
    const r = await dialog.showOpenDialog(win, { defaultPath: path.join(def, 'config'), properties: ['openFile', 'showHiddenFiles'] });
    if (r.canceled) return null;
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    const readKey = (p) => {
      try { return fs.readFileSync(p.replace(/^~(?=$|[\\/])/, os.homedir()), 'utf8'); } catch { return null; }
    };
    const res = requireStore().importSshConfig(text, readKey);
    return { hosts: res.hosts, snapshot: snapshot() };
  });
}

// Versões antigas (TermVault) guardavam o cofre em %APPDATA%/termvault: continua usando essa pasta
// para o usuário não perder hosts, chaves e senhas ao trocar de nome.
const legacyData = path.join(app.getPath('appData'), 'termvault');
if (fs.existsSync(legacyData)) app.setPath('userData', legacyData);

// uma só instância: clicar de novo no ícone traz a janela existente para frente
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else if (app.isReady()) createWindow();
});

app.whenReady().then(() => {
  backup = new BackupScheduler({ configFile: path.join(app.getPath('userData'), 'backup.json'), vaultDir: vaultDir() });
  backup.start();
  sessionLog = new SessionLogger({ configFile: path.join(app.getPath('userData'), 'sessionlog.json'), defaultFolder: path.join(app.getPath('documents'), 'NetDeck', 'logs') });
  servers = new ServerManager({ configFile: path.join(app.getPath('userData'), 'servers.json') });
  servers.restart().catch((e) => console.error('servidores', e)); // religa o que estava ligado da última vez
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { if (servers) servers.stopAll().catch(() => {}); });

app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.close(); } catch { /* ignora */ } }
  for (const id of [...logs.keys()]) closeLog(id, 'aplicativo fechado');
  if (store) store.vault.lock();
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
