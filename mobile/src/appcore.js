'use strict';
// Núcleo do app Android: faz o papel do processo principal do Electron (main.js + preload.js) dentro do WebView.
// Expõe o MESMO objeto `api` que a interface (renderer.js) usa no computador, então a tela é a mesma.
// Tudo que depende do aparelho entra por `deps` (cofre, arquivos, plugin nativo), o que permite testar fora do celular.
const { normalizeAddress } = require('../../src/main/netutil');

const CALLABLE = new Set([
  'addFolder', 'updateFolder', 'removeFolder', 'moveFolder',
  'addHost', 'updateHost', 'removeHost', 'moveHost', 'duplicateHost',
  'addIdentity', 'updateIdentity', 'removeIdentity',
]);
const NOT_ON_ANDROID = (what) => () => { throw new Error(what + ' não está disponível no Android'); };
const validUser = (u) => typeof u === 'string' && /^[\p{L}\p{N}_.-]{1,40}$/u.test(u);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const fromB64 = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

function adhocHost(a) {
  const protocol = a.protocol || 'ssh';
  return {
    id: null, name: a.address || 'Conexão rápida', protocol, address: a.address, port: Number(a.port) || (protocol === 'telnet' ? 23 : 22),
    serial: null, jumpChain: [], startupCommands: [], forwards: [], telnetEnter: 'crlf',
    identity: a.username ? { username: a.username, password: a.password || '', privateKey: '', passphrase: '', useAgent: false } : null,
  };
}

// Sessão SSH: a conexão em si é do código nativo (JSch); aqui ficam as perguntas ao usuário e a confiança nas chaves.
class AndroidSsh {
  constructor({ host, cols, rows, onData, onClose, onStatus, native, ask, store, sid }) {
    Object.assign(this, { host, cols: cols || 80, rows: rows || 24, onData, onClose, onStatus, native, ask, store, sid });
    this.closed = false;
  }

  async start() {
    const chain = [...(this.host.jumpChain || []), this.host];
    const hops = [];
    for (let i = 0; i < chain.length; i++) {
      const hop = chain[i];
      let id = hop.identity;
      if (!id || !id.username) { // host salvo só com nome + IP: pergunta usuário e senha na hora
        const user = await this.ask(`Conectar em ${hop.name || hop.address}`, 'Usuário', false);
        if (user === null || !String(user).trim()) throw new Error('Conexão cancelada');
        id = { ...(id || {}), username: String(user).trim() };
      }
      let password = id.password || '';
      if (!password) {
        const pw = await this.ask(`Senha de ${id.username}@${hop.address}`, 'Senha', true);
        if (pw === null) throw new Error('Conexão cancelada');
        password = pw;
      }
      hops.push({ name: hop.name || hop.address, host: normalizeAddress(hop.address), port: hop.port || 22, username: id.username, password, legacy: hop.legacyAlgorithms !== false });
    }
    this.onStatus(`Conectando: ${hops[hops.length - 1].host}:${hops[hops.length - 1].port}...`);
    const forwards = (this.host.forwards || []).filter((f) => typeof f === 'string');
    await this.native.sshOpen({ sid: this.sid, hops, cols: this.cols, rows: this.rows, forwards });
    this.onStatus('Conectado');
    (this.host.startupCommands || []).forEach((c, i) => setTimeout(() => this.write(c + '\n'), 250 * (i + 1)));
  }

  write(data) { if (!this.closed) this.native.sshWrite({ sid: this.sid, data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8') }).catch(() => {}); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; if (!this.closed) this.native.sshResize({ sid: this.sid, cols, rows }).catch(() => {}); }
  close() { if (this.closed) return; this.closed = true; this.native.sshClose({ sid: this.sid }).catch(() => {}); }
}

function createApp(deps) {
  const { Vault, Store, fs, native, TelnetSession, files, version = '0', vaultDir = '/vaults' } = deps;
  const listeners = {};
  const emit = (ch, ...a) => (listeners[ch] || []).forEach((cb) => { try { cb(...a); } catch (e) { console.error(e); } });
  let store = null;
  let currentFile = null;
  let pendingRestore = null;
  const pendingPrompts = new Map();
  const sessions = new Map();
  const bySid = new Map(); // sid -> manipuladores de eventos do código nativo
  let nativeWired = false;

  const vaultFile = (u) => {
    if (!validUser(u)) throw new Error('Nome de usuário inválido (use letras, números, _ . -)');
    return `${vaultDir}/${u}.vault`;
  };
  // a derivação da senha (scrypt) é pesada no celular: dá tempo da tela mostrar "Desbloqueando…" antes de travar
  const tick = deps.tick || (() => new Promise((r) => setTimeout(r, 25)));
  const requireStore = () => { if (!store) throw new Error('Cofre bloqueado'); return store; };

  function snapshot() {
    const d = requireStore().data;
    return {
      folders: d.folders,
      hosts: d.hosts,
      identities: d.identities.map(({ password, ...i }) => ({ ...i, hasPassword: !!password })),
      keys: d.keys.map(({ privateKey, passphrase, ...k }) => ({ ...k, hasPassphrase: !!passphrase })),
    };
  }

  function ask(title, label, secret) {
    return new Promise((resolve) => {
      const id = deps.uuid();
      pendingPrompts.set(id, resolve);
      emit('prompt:ask', id, title, label, !!secret);
    });
  }

  // confirmação sim/não (chave de servidor desconhecida ou alterada)
  function confirm(info) {
    return new Promise((resolve) => {
      const id = deps.uuid();
      pendingPrompts.set(id, resolve);
      emit('confirm:ask', id, info);
    });
  }

  function wireNative() {
    if (nativeWired || !native || !native.on) return;
    nativeWired = true;
    native.on('data', (e) => { const h = bySid.get(e.sid); if (h) h.onData(fromB64(e.b64)); });
    native.on('closed', (e) => { const h = bySid.get(e.sid); if (h) h.onClose(e.reason || 'Conexão encerrada'); });
    native.on('status', (e) => { const h = bySid.get(e.sid); if (h) h.onStatus(e.msg); });
    native.on('hostkey', async (e) => {
      let ok = false;
      try {
        const st = requireStore().checkHostKey(e.hostport, e.fp);
        if (st === 'match') ok = true;
        else {
          ok = await confirm({
            changed: st === 'mismatch', hostport: e.hostport, algo: e.algo, fingerprint: e.fp,
          });
          if (ok) requireStore().trustHostKey(e.hostport, e.algo, e.fp);
        }
      } catch { ok = false; }
      native.hostKeyAnswer({ sid: e.sid, hop: e.hop, ok }).catch(() => {});
    });
  }

  const api = {
    mobile: true,
    version: async () => version,
    users: async () => fs.readdirSync(vaultDir).filter((f) => f.endsWith('.vault')).map((f) => f.slice(0, -6)).sort(),

    async createVault(u, p) {
      const f = vaultFile(u);
      await tick();
      store = new Store(Vault.create(f, p, {}));
      currentFile = f;
      return snapshot();
    },
    async unlock(u, p) {
      const f = vaultFile(u);
      await tick();
      if (!Vault.exists(f)) throw new Error('Usuário não encontrado');
      store = new Store(Vault.open(f, p));
      currentFile = f;
      return snapshot();
    },
    async lock() { if (store) { store.vault.lock(); store = null; currentFile = null; } },
    async changePassword(pw) { requireStore(); await tick(); store.vault.changePassword(pw); },
    async snapshot() { return snapshot(); },
    async call(method, ...args) {
      if (!CALLABLE.has(method)) throw new Error('Operação não permitida');
      const r = requireStore()[method](...args);
      return { result: r && r.id ? { id: r.id } : null, snapshot: snapshot() };
    },
    publicKey: NOT_ON_ANDROID('Chave SSH'),
    copyId: NOT_ON_ANDROID('Chave SSH'),

    async open({ id, hostId, adhoc, cols, rows }) {
      const st = requireStore();
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || sessions.has(id)) throw new Error('Identificador de sessão inválido');
      const resolved = hostId ? st.resolveHost(hostId) : adhocHost(adhoc || {});
      if (resolved.protocol === 'serial') throw new Error('Porta serial não está disponível no Android');
      wireNative();
      const common = {
        host: resolved, cols, rows, sid: id,
        onData: (d) => emit('session:data', id, d),
        onClose: (reason) => { bySid.delete(id); sessions.delete(id); emit('session:close', id, reason); },
        onStatus: (msg) => emit('session:status', id, msg),
      };
      const s = resolved.protocol === 'telnet' ? new TelnetSession(common) : new AndroidSsh({ ...common, native, ask, store: st });
      sessions.set(id, s);
      bySid.set(id, common);
      try {
        await s.start();
      } catch (e) {
        sessions.delete(id); bySid.delete(id);
        try { s.close(); } catch { /* ignora */ }
        throw new Error(e.message || String(e));
      }
      if (hostId) st.touch(hostId);
      return { id, name: resolved.name, protocol: resolved.protocol, snapshot: hostId ? snapshot() : null };
    },
    input(id, data) { const s = sessions.get(id); if (s && typeof data === 'string') s.write(deps.transformInput ? deps.transformInput(data) : data); },
    resize(id, cols, rows) { const s = sessions.get(id); if (s && cols > 0 && rows > 0) s.resize(cols, rows); },
    close(id) { const s = sessions.get(id); if (s) s.close(); sessions.delete(id); bySid.delete(id); },
    answerPrompt(id, value) { const r = pendingPrompts.get(id); if (r) { pendingPrompts.delete(id); r(value); } },

    serialList: async () => [],
    sftpList: NOT_ON_ANDROID('SFTP'),
    rdpOpen: NOT_ON_ANDROID('RDP'),
    sftpDownload: NOT_ON_ANDROID('SFTP'),
    sftpUpload: NOT_ON_ANDROID('SFTP'),
    ftpOpen: NOT_ON_ANDROID('FTP'),
    scpDownload: NOT_ON_ANDROID('SCP'),
    scpUpload: NOT_ON_ANDROID('SCP'),
    importSshConfig: NOT_ON_ANDROID('Importar ~/.ssh/config'),

    // ---- arquivos: exportar (compartilhar) e importar (escolher no aparelho)
    async exportData(withSecrets) {
      const json = JSON.stringify(requireStore().exportData({ includeSecrets: !!withSecrets }), null, 2);
      const name = `netdeck-hosts-${stamp(new Date())}.json`;
      await files.save(name, json);
      return name;
    },
    async importData() {
      const f = await files.pick();
      if (!f) return null;
      let obj;
      try { obj = JSON.parse(f.text); } catch { throw new Error('O arquivo não é um JSON válido'); }
      const added = requireStore().importData(obj);
      return { snapshot: snapshot(), added };
    },

    // ---- backup do cofre: o arquivo já é criptografado; compartilha para Drive/WhatsApp/e-mail etc.
    async backupExport() {
      requireStore();
      const name = currentFile.split('/').pop().replace(/\.vault$/, '') + '-' + stamp(new Date()) + '.vault';
      await files.save(name, fs.readFileSync(currentFile));
      return name;
    },
    async backupPickFile() {
      const f = await files.pick();
      if (!f) return null;
      pendingRestore = f;
      return f.name;
    },
    async backupRestore(name, password) {
      requireStore();
      if (!pendingRestore || pendingRestore.name !== name) throw new Error('Escolha o arquivo de backup novamente');
      const dest = currentFile;
      await tick();
      const tmp = dest + '.restaurando';
      fs.writeFileSync(tmp, pendingRestore.text);
      try { Vault.open(tmp, password).lock(); } catch (e) { fs.rmSync(tmp); throw e; }
      const saved = `${dest}.antes-${stamp(new Date())}`;
      store.vault.lock();
      fs.renameSync(dest, saved);
      fs.renameSync(tmp, dest);
      store = new Store(Vault.open(dest, password));
      pendingRestore = null;
      return { snapshot: snapshot(), saved: saved.split('/').pop() };
    },

    // recursos só de computador: respostas neutras (a interface do celular não mostra essas telas)
    backupGet: async () => ({ enabled: false, running: false }),
    backupSet: NOT_ON_ANDROID('Backup automático'),
    backupPickFolder: async () => null,
    backupNow: NOT_ON_ANDROID('Backup automático'),
    logsGet: async () => ({ enabled: false, folder: '', timestamps: false, effectiveFolder: '' }),
    logsSet: NOT_ON_ANDROID('Log de sessão'),
    logsPickFolder: async () => null,
    logsOpenFolder: NOT_ON_ANDROID('Log de sessão'),
    serversStatus: NOT_ON_ANDROID('Servidor TFTP/FTP'),
    serversApply: NOT_ON_ANDROID('Servidor TFTP/FTP'),
    serversPickRoot: async () => null,
    serversAddresses: async () => [],

    on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); },
  };
  return api;
}

module.exports = { createApp, AndroidSsh, adhocHost };
