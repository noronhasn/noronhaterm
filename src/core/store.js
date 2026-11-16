'use strict';
// Modelo de dados do usuário: pastas (árvore), hosts, identidades, chaves, known hosts.
// Tudo vive dentro do cofre criptografado (vault.data).
const crypto = require('crypto');
const keys = require('./keys');

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const FOLDER_FIELDS = ['name', 'parentId', 'color', 'icon', 'defaultIdentityId', 'defaultJumpHostId', 'startupCommands', 'order'];
const HOST_FIELDS = [
  'name', 'folderId', 'protocol', 'address', 'port', 'identityId', 'jumpHostId', 'tags', 'notes',
  'serial', 'startupCommands', 'forwards', 'favorite', 'telnetEnter', 'legacyAlgorithms', 'order',
];
const IDENTITY_FIELDS = ['name', 'username', 'password', 'keyId', 'useAgent', 'ownerHostId'];

const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
};

class Store {
  constructor(vault) {
    this.vault = vault;
    const d = vault.data;
    d.version ||= 1;
    d.folders ||= [];
    d.hosts ||= [];
    d.identities ||= [];
    d.keys ||= [];
    d.knownHosts ||= {};
    d.settings ||= {};
    this.data = d;
  }

  _save() { this.vault.save(); }
  _folder(id) { return this.data.folders.find((f) => f.id === id); }
  _host(id) { return this.data.hosts.find((h) => h.id === id); }
  _identity(id) { return this.data.identities.find((i) => i.id === id); }
  _key(id) { return this.data.keys.find((k) => k.id === id); }
  _need(x, what) { if (!x) throw new Error(`${what} não encontrado(a)`); return x; }
  _nextOrder(list, pred) { return list.filter(pred).reduce((m, x) => Math.max(m, x.order ?? 0), 0) + 1; }

  // ---------- Pastas ----------
  addFolder(p = {}) {
    if (!p.name) throw new Error('Informe o nome da pasta');
    const parentId = p.parentId ?? null;
    if (parentId) this._need(this._folder(parentId), 'Pasta pai');
    const f = {
      id: uid(), parentId, color: null, icon: null, defaultIdentityId: null, defaultJumpHostId: null,
      startupCommands: [], ...pick(p, FOLDER_FIELDS),
      order: this._nextOrder(this.data.folders, (x) => x.parentId === parentId),
    };
    f.parentId = parentId;
    this.data.folders.push(f);
    this._save();
    return f;
  }

  _isDescendant(folderId, ancestorId) {
    for (let f = this._folder(folderId); f; f = this._folder(f.parentId)) {
      if (f.id === ancestorId) return true;
    }
    return false;
  }

  updateFolder(id, patch) {
    const f = this._need(this._folder(id), 'Pasta');
    const p = pick(patch, FOLDER_FIELDS);
    if (p.parentId !== undefined && p.parentId !== f.parentId) {
      if (p.parentId !== null) {
        this._need(this._folder(p.parentId), 'Pasta destino');
        if (this._isDescendant(p.parentId, id)) throw new Error('Não é possível mover uma pasta para dentro dela mesma');
      }
    }
    Object.assign(f, p);
    this._save();
    return f;
  }

  moveFolder(id, parentId) { return this.updateFolder(id, { parentId: parentId ?? null }); }

  descendantFolderIds(id) {
    const out = [];
    const walk = (pid) => this.data.folders.filter((f) => f.parentId === pid).forEach((f) => { out.push(f.id); walk(f.id); });
    walk(id);
    return out;
  }

  // cascade=true apaga subpastas e hosts; false move o conteúdo para a pasta pai.
  removeFolder(id, { cascade = false } = {}) {
    const f = this._need(this._folder(id), 'Pasta');
    if (cascade) {
      const ids = new Set([id, ...this.descendantFolderIds(id)]);
      const removedHosts = new Set(this.data.hosts.filter((h) => ids.has(h.folderId)).map((h) => h.id));
      this.data.folders = this.data.folders.filter((x) => !ids.has(x.id));
      this.data.hosts = this.data.hosts.filter((h) => !removedHosts.has(h.id));
      this.data.hosts.forEach((h) => { if (removedHosts.has(h.jumpHostId)) h.jumpHostId = null; });
      this.data.folders.forEach((x) => { if (removedHosts.has(x.defaultJumpHostId)) x.defaultJumpHostId = null; });
    } else {
      this.data.folders.forEach((x) => { if (x.parentId === id) x.parentId = f.parentId; });
      this.data.hosts.forEach((h) => { if (h.folderId === id) h.folderId = f.parentId; });
      this.data.folders = this.data.folders.filter((x) => x.id !== id);
    }
    this._save();
  }

  // ---------- Hosts ----------
  addHost(p = {}) {
    if (!p.name) throw new Error('Informe o nome do host');
    const protocol = p.protocol || 'ssh';
    if (!['ssh', 'telnet', 'serial', 'rdp', 'ftp'].includes(protocol)) throw new Error('Protocolo inválido');
    if (protocol !== 'serial' && !p.address) throw new Error('Informe o endereço');
    const folderId = p.folderId ?? null;
    if (folderId) this._need(this._folder(folderId), 'Pasta');
    const h = {
      id: uid(), folderId, protocol, address: '', port: protocol === 'ssh' ? 22 : protocol === 'telnet' ? 23 : protocol === 'rdp' ? 3389 : protocol === 'ftp' ? 21 : null,
      identityId: null, jumpHostId: null, tags: [], notes: '', serial: null, startupCommands: [], forwards: [],
      favorite: false, telnetEnter: 'crlf', legacyAlgorithms: true, lastConnectedAt: null, createdAt: now(),
      ...pick(p, HOST_FIELDS),
      order: this._nextOrder(this.data.hosts, (x) => x.folderId === folderId),
    };
    h.folderId = folderId;
    if (protocol === 'serial') {
      h.serial = { port: '', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', ...(p.serial || {}) };
    }
    this.data.hosts.push(h);
    this._save();
    return h;
  }

  updateHost(id, patch) {
    const h = this._need(this._host(id), 'Host');
    const p = pick(patch, HOST_FIELDS);
    if (p.folderId) this._need(this._folder(p.folderId), 'Pasta');
    if (p.jumpHostId === id) throw new Error('Um host não pode ser jump host de si mesmo');
    Object.assign(h, p);
    this._save();
    return h;
  }

  moveHost(id, folderId) { return this.updateHost(id, { folderId: folderId ?? null }); }

  duplicateHost(id) {
    const h = this._need(this._host(id), 'Host');
    const copy = JSON.parse(JSON.stringify(h));
    delete copy.id; delete copy.lastConnectedAt; delete copy.createdAt; delete copy.order;
    copy.name = h.name + ' (cópia)';
    return this.addHost(copy);
  }

  removeHost(id) {
    this._need(this._host(id), 'Host');
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    this.data.identities = this.data.identities.filter((i) => i.ownerHostId !== id); // usuário/senha salvos só para este host
    this.data.hosts.forEach((h) => { if (h.jumpHostId === id) h.jumpHostId = null; });
    this.data.folders.forEach((f) => { if (f.defaultJumpHostId === id) f.defaultJumpHostId = null; });
    this._save();
  }

  touch(id) {
    const h = this._host(id);
    if (h) { h.lastConnectedAt = now(); this._save(); }
  }

  // ---------- Identidades ----------
  addIdentity(p = {}) {
    if (!p.name) throw new Error('Informe o nome da identidade');
    if (p.keyId) this._need(this._key(p.keyId), 'Chave');
    const i = { id: uid(), username: '', password: '', keyId: null, useAgent: false, ...pick(p, IDENTITY_FIELDS) };
    this.data.identities.push(i);
    this._save();
    return i;
  }

  updateIdentity(id, patch) {
    const i = this._need(this._identity(id), 'Identidade');
    const p = pick(patch, IDENTITY_FIELDS);
    if (p.keyId) this._need(this._key(p.keyId), 'Chave');
    Object.assign(i, p);
    this._save();
    return i;
  }

  removeIdentity(id) {
    this._need(this._identity(id), 'Identidade');
    this.data.identities = this.data.identities.filter((i) => i.id !== id);
    this.data.hosts.forEach((h) => { if (h.identityId === id) h.identityId = null; });
    this.data.folders.forEach((f) => { if (f.defaultIdentityId === id) f.defaultIdentityId = null; });
    this._save();
  }

  // ---------- Chaves ----------
  generateKey({ name, type = 'ed25519', bits = 4096, comment = '' } = {}) {
    if (!name) throw new Error('Informe o nome da chave');
    const g = keys.generateKey({ type, bits, comment });
    const k = { id: uid(), name, comment, passphrase: '', createdAt: now(), ...g, source: 'generated' };
    this.data.keys.push(k);
    this._save();
    return k;
  }

  importKey({ name, privateKey, passphrase = '', comment = '' }) {
    if (!name) throw new Error('Informe o nome da chave');
    if (!privateKey) throw new Error('Cole o conteúdo da chave privada');
    const d = keys.describePrivateKey(privateKey, passphrase);
    const k = {
      id: uid(), name, comment, passphrase, createdAt: now(), type: d.type, privateKey,
      publicKey: keys.publicLine(d.type, d.blob, comment), fingerprint: keys.fingerprint(d.blob),
      encrypted: d.encrypted, source: 'imported',
    };
    this.data.keys.push(k);
    this._save();
    return k;
  }

  removeKey(id) {
    this._need(this._key(id), 'Chave');
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    this.data.identities.forEach((i) => { if (i.keyId === id) i.keyId = null; });
    this._save();
  }

  // ---------- Resolução (herança) ----------
  folderChain(folderId) { // da pasta mais próxima até a raiz
    const out = [];
    for (let f = this._folder(folderId); f && out.length < 64; f = this._folder(f.parentId)) out.push(f);
    return out;
  }

  _credentials(identityId) {
    const i = identityId && this._identity(identityId);
    if (!i) return null;
    const k = i.keyId && this._key(i.keyId);
    return {
      id: i.id, name: i.name, username: i.username, password: i.password || '', useAgent: !!i.useAgent,
      privateKey: k ? k.privateKey : '', passphrase: k ? k.passphrase || '' : '',
    };
  }

  // Resolve o host aplicando herança das pastas. Contém segredos: usar só no processo principal.
  resolveHost(id, _seen = new Set()) {
    const h = this._need(this._host(id), 'Host');
    if (_seen.has(id)) throw new Error('Ciclo de jump hosts detectado');
    _seen.add(id);
    const chain = this.folderChain(h.folderId);
    const inherit = (field) => (h[field] ?? chain.find((f) => f[field])?.[field] ?? null);
    const identityId = inherit('identityId') || (chain.find((f) => f.defaultIdentityId)?.defaultIdentityId ?? null);
    const jumpId = h.jumpHostId || chain.find((f) => f.defaultJumpHostId)?.defaultJumpHostId || null;
    let jumpChain = [];
    if (jumpId && jumpId !== id) {
      const j = this.resolveHost(jumpId, _seen);
      jumpChain = [...j.jumpChain, j];
    }
    const folderCmds = chain.slice().reverse().flatMap((f) => f.startupCommands || []);
    return {
      ...h,
      identity: this._credentials(identityId),
      identityId,
      jumpChain,
      startupCommands: [...folderCmds, ...(h.startupCommands || [])],
    };
  }

  resolveIdentityId(hostId) { return this.resolveHost(hostId).identityId; }

  // ---------- Known hosts ----------
  checkHostKey(hostport, fp) {
    const k = this.data.knownHosts[hostport];
    if (!k) return 'new';
    return k.fingerprint === fp ? 'match' : 'mismatch';
  }

  trustHostKey(hostport, algo, fp) {
    this.data.knownHosts[hostport] = { algo, fingerprint: fp, addedAt: now() };
    this._save();
  }

  // ---------- Busca / árvore ----------
  search(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [];
    return this.data.hosts.filter((h) =>
      [h.name, h.address, h.notes, ...(h.tags || [])].some((x) => x && String(x).toLowerCase().includes(s)));
  }

  tree() {
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
    const build = (pid) => this.data.folders.filter((f) => f.parentId === pid).sort(byOrder).map((f) => ({
      ...f, children: build(f.id), hosts: this.data.hosts.filter((h) => h.folderId === f.id).sort(byOrder),
    }));
    return { folders: build(null), rootHosts: this.data.hosts.filter((h) => !h.folderId).sort(byOrder) };
  }

  // ---------- Importar / exportar ----------
  exportData({ includeSecrets = false } = {}) {
    const d = JSON.parse(JSON.stringify(this.data));
    delete d.knownHosts;
    if (!includeSecrets) {
      d.identities.forEach((i) => { i.password = ''; });
      d.keys.forEach((k) => { k.privateKey = ''; k.passphrase = ''; });
    }
    return d;
  }

  importData(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('Arquivo inválido');
    let added = 0;
    for (const coll of ['keys', 'identities', 'folders', 'hosts']) {
      for (const item of obj[coll] || []) {
        if (!item.id || this.data[coll].some((x) => x.id === item.id)) continue;
        this.data[coll].push(item);
        added++;
      }
    }
    this._save();
    return added;
  }

  // Importa hosts de um ~/.ssh/config. readFile(path) -> string|null (para IdentityFile).
  importSshConfig(text, readFile = () => null) {
    const blocks = parseSshConfig(text);
    const folder = this.addFolder({ name: 'Importado (ssh_config)' });
    const idCache = new Map();
    const created = [];
    for (const b of blocks) {
      for (const pat of b.patterns) {
        if (/[*?!]/.test(pat)) continue;
        const o = b.opts;
        let identityId = null;
        if (o.user || o.identityfile) {
          const ck = `${o.user || ''}|${o.identityfile || ''}`;
          if (!idCache.has(ck)) {
            let keyId = null;
            if (o.identityfile) {
              const pem = readFile(o.identityfile);
              if (pem) {
                try { keyId = this.importKey({ name: `ssh_config: ${o.identityfile.split(/[\\/]/).pop()}`, privateKey: pem }).id; } catch { /* ignora */ }
              }
            }
            idCache.set(ck, this.addIdentity({ name: `${o.user || 'user'}${o.identityfile ? ' (' + o.identityfile.split(/[\\/]/).pop() + ')' : ''}`, username: o.user || '', keyId, useAgent: !o.identityfile }).id);
          }
          identityId = idCache.get(ck);
        }
        const h = this.addHost({
          name: pat, folderId: folder.id, protocol: 'ssh', address: o.hostname || pat,
          port: o.port ? Number(o.port) : 22, identityId,
        });
        h._proxyJump = o.proxyjump;
        created.push(h);
      }
    }
    for (const h of created) {
      if (h._proxyJump) {
        const jn = h._proxyJump.split(',')[0].trim().replace(/^.*@/, '').replace(/:\d+$/, '');
        const jh = created.find((x) => x.name === jn);
        if (jh) h.jumpHostId = jh.id;
      }
      delete h._proxyJump;
    }
    this._save();
    return { folder, hosts: created.length };
  }
}

function parseSshConfig(text) {
  const blocks = [];
  let cur = null;
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') { cur = { patterns: val.split(/\s+/), opts: {} }; blocks.push(cur); }
    else if (key === 'match') { cur = null; }
    else if (cur && !(key in cur.opts)) cur.opts[key] = val; // no OpenSSH o primeiro valor vence
  }
  return blocks;
}

module.exports = { Store, parseSshConfig };
