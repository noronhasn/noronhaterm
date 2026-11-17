'use strict';
const { normalizeAddress } = require('./netutil');
// Sessão SSH (ssh2): shell interativo, jump hosts encadeados, túneis (local e SOCKS5), SFTP.
const net = require('net');
require('./dhfix').install(); // antes de qualquer require('ssh2'): ver dhfix.js
const crypto = require('crypto');
const posix = require('path').posix;

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fpOf = (key) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
const algoOf = (key) => key.subarray(4, 4 + key.readUInt32BE(0)).toString();

// Equipamentos antigos (CPEs, switches, roteadores) só falam algoritmos hoje considerados fracos.
// Ficam desligados por padrão e são ACRESCENTADOS (não substituem os modernos) só quando o host pede.
const LEGACY_ALGORITHMS = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha1'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  hmac: ['hmac-sha1', 'hmac-md5'],
};

// Ligado por padrão (como o Termius): os antigos vão no FIM da lista, então servidores modernos
// continuam negociando os algoritmos modernos. Só desliga se o host tiver legacyAlgorithms === false.
function algorithmsFor(hop) {
  if (hop.legacyAlgorithms === false) return undefined;
  const out = {};
  for (const [k, list] of Object.entries(LEGACY_ALGORITHMS)) out[k] = { append: [...list] };
  return out;
}

function explainError(e, hop) {
  const m = String((e && e.message) || e);
  if (/no matching (key exchange|host key|cipher|mac)/i.test(m)) {
    return new Error(hop.legacyAlgorithms === false
      ? `${m}. Edite o host e marque “Permitir algoritmos antigos”.`
      : `${m}. O equipamento exige um algoritmo que o app não suporta.`);
  }
  return e instanceof Error ? e : new Error(m);
}

function agentSocket() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return undefined;
}

// "L:8080:db.interno:5432" (local) ou "D:1080" (SOCKS5). Retorna null se inválido.
function parseForward(line) {
  const p = String(line).trim().split(':');
  const port = (x) => { const n = Number(x); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };
  if (p[0].toUpperCase() === 'L' && p.length === 4 && port(p[1]) && port(p[3]) && p[2]) {
    return { type: 'local', bindPort: port(p[1]), destHost: p[2], destPort: port(p[3]) };
  }
  if (p[0].toUpperCase() === 'D' && p.length === 2 && port(p[1])) return { type: 'dynamic', bindPort: port(p[1]) };
  return null;
}

function socks5(sock, conn) {
  sock.on('error', () => {});
  sock.once('data', (g) => {
    if (g[0] !== 5) return sock.destroy();
    sock.write(Buffer.from([5, 0]));
    sock.once('data', (r) => {
      const fail = (c) => sock.end(Buffer.from([5, c, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (r[0] !== 5 || r[1] !== 1) return fail(7);
      let host, off;
      if (r[3] === 1) { host = [...r.subarray(4, 8)].join('.'); off = 8; }
      else if (r[3] === 3) { host = r.subarray(5, 5 + r[4]).toString(); off = 5 + r[4]; }
      else if (r[3] === 4) { const g6 = []; for (let i = 0; i < 16; i += 2) g6.push(r.readUInt16BE(4 + i).toString(16)); host = g6.join(':'); off = 20; }
      else return fail(8);
      const port = r.readUInt16BE(off);
      conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, host, port, (err, stream) => {
        if (err) return fail(5);
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        sock.pipe(stream).pipe(sock);
        stream.on('error', () => sock.destroy());
      });
    });
  });
}

class SshSession {
  // hostKeys: { check(hostport, fp) -> 'new'|'match'|'mismatch', confirm(info) -> Promise<bool>, trust(hostport, algo, fp) }
  // prompt(title, label, secret) -> Promise<string|null>
  constructor({ host, cols, rows, onData, onClose, onStatus, hostKeys, prompt }) {
    this.host = host;
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.onData = onData;
    this.onClose = onClose;
    this.onStatus = onStatus;
    this.hostKeys = hostKeys;
    this.prompt = prompt;
    this.clients = [];
    this.servers = [];
    this.closed = false;
  }

  async start() {
    const { Client } = require('ssh2');
    this.Client = Client;
    const chain = [...(this.host.jumpChain || []), this.host];
    let sock;
    for (let i = 0; i < chain.length; i++) {
      const hop = chain[i];
      this.onStatus(`${i < chain.length - 1 ? 'Jump host' : 'Conectando'}: ${hop.address}:${hop.port || 22}...`);
      const client = new Client();
      this.clients.push(client);
      await this._connect(client, hop, sock);
      client.on('error', (e) => this.onStatus('Erro: ' + e.message));
      client.on('close', () => this._finish('Conexão encerrada'));
      if (i < chain.length - 1) {
        const next = chain[i + 1];
        sock = await new Promise((res, rej) => client.forwardOut('127.0.0.1', 0, normalizeAddress(next.address), next.port || 22, (e, s) => (e ? rej(e) : res(s))));
      }
    }
    this.conn = this.clients[this.clients.length - 1];
    this._startForwards();
    await this._openShell();
  }

  async _connect(client, hop, sock) {
    let id = hop.identity;
    if (!id || !id.username) { // host salvo só com nome + IP: pergunta usuário e senha na hora de conectar
      const user = await this.prompt(`Conectar em ${hop.name || hop.address}`, 'Usuário', false);
      if (user === null || !String(user).trim()) throw new Error('Conexão cancelada');
      id = { ...(id || {}), username: String(user).trim(), useAgent: false };
    }
    const cfg = {
      host: normalizeAddress(hop.address), port: hop.port || 22, username: id.username, sock,
      readyTimeout: 25000, keepaliveInterval: 15000, tryKeyboard: true,
      hostVerifier: (key, cb) => this._verifyHostKey(hop, key).then(cb, () => cb(false)),
    };
    if (id.privateKey) { cfg.privateKey = id.privateKey; if (id.passphrase) cfg.passphrase = id.passphrase; }
    if (id.password) cfg.password = id.password;
    const algs = algorithmsFor(hop);
    if (algs) cfg.algorithms = algs;
    if (id.useAgent && agentSocket()) cfg.agent = agentSocket();
    if (!cfg.privateKey && !cfg.password && !cfg.agent) {
      const pw = await this.prompt(`Senha de ${id.username}@${hop.address}`, 'Senha', true);
      if (pw === null) throw new Error('Conexão cancelada');
      cfg.password = pw;
    }
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', (e) => reject(explainError(e, hop)));
      client.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => cfg.password || ''));
      });
      client.connect(cfg);
    });
  }

  async _verifyHostKey(hop, key) {
    const hp = `${hop.address}:${hop.port || 22}`;
    const fp = fpOf(key);
    const algo = algoOf(key);
    const st = this.hostKeys.check(hp, fp);
    if (st === 'match') return true;
    const ok = await this.hostKeys.confirm({ hostport: hp, algo, fingerprint: fp, changed: st === 'mismatch' });
    if (ok) this.hostKeys.trust(hp, algo, fp);
    return ok;
  }

  _startForwards() {
    for (const line of this.host.forwards || []) {
      const f = typeof line === 'string' ? parseForward(line) : line;
      if (!f) { this.onStatus(`Túnel ignorado (formato inválido): ${line}`); continue; }
      const srv = net.createServer((s) => {
        if (f.type === 'dynamic') return socks5(s, this.conn);
        this.conn.forwardOut(s.remoteAddress || '127.0.0.1', s.remotePort || 0, f.destHost, f.destPort, (err, stream) => {
          if (err) return s.destroy();
          s.pipe(stream).pipe(s);
          stream.on('error', () => s.destroy());
          s.on('error', () => stream.destroy());
        });
      });
      srv.on('error', (e) => this.onStatus(`Túnel porta ${f.bindPort}: ${e.message}`));
      srv.listen(f.bindPort, '127.0.0.1', () => this.onStatus(
        f.type === 'dynamic' ? `SOCKS5 em 127.0.0.1:${f.bindPort}` : `Túnel 127.0.0.1:${f.bindPort} -> ${f.destHost}:${f.destPort}`));
      this.servers.push(srv);
    }
  }

  _openShell() {
    return new Promise((resolve, reject) => {
      this.conn.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows }, (err, stream) => {
        if (err) return reject(err);
        this.stream = stream;
        stream.on('data', (d) => this.onData(d));
        stream.stderr.on('data', (d) => this.onData(d));
        stream.on('close', () => this._finish('Sessão encerrada'));
        this.onStatus('Conectado');
        (this.host.startupCommands || []).forEach((c, i) => setTimeout(() => this.write(c + '\n'), 250 * (i + 1)));
        resolve();
      });
    });
  }

  write(data) { if (this.stream && !this.closed) this.stream.write(data); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; if (this.stream) this.stream.setWindow(rows, cols, 0, 0); }

  // ---- SFTP (reaproveita a conexão da sessão) ----
  _sftp() {
    if (!this._sftpP) {
      this._sftpP = new Promise((res, rej) => this.conn.sftp((e, s) => (e ? rej(e) : res(s))));
      this._sftpP.catch(() => { this._sftpP = null; });
    }
    return this._sftpP;
  }

  async sftpList(dir) {
    const sftp = await this._sftp();
    const abs = await new Promise((res, rej) => sftp.realpath(dir || '.', (e, p) => (e ? rej(e) : res(p))));
    const list = await new Promise((res, rej) => sftp.readdir(abs, (e, l) => (e ? rej(e) : res(l))));
    const items = list.map((i) => ({
      name: i.filename, size: i.attrs.size, mtime: i.attrs.mtime * 1000,
      isDir: (i.attrs.mode & 0o170000) === 0o040000,
    })).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { path: abs, items };
  }

  async sftpDownload(remote, local) {
    const sftp = await this._sftp();
    await new Promise((res, rej) => sftp.fastGet(remote, local, (e) => (e ? rej(e) : res())));
  }

  async sftpUpload(local, remoteDir) {
    const sftp = await this._sftp();
    const dest = posix.join(remoteDir, require('path').basename(local));
    await new Promise((res, rej) => sftp.fastPut(local, dest, (e) => (e ? rej(e) : res())));
    return dest;
  }

  // ---- SCP (para equipamentos sem SFTP) ----
  _exec(cmd) { return new Promise((res, rej) => this.conn.exec(cmd, (e, st) => (e ? rej(e) : res(st)))); }

  async scpDownload(remote, local) {
    const scp = require('./scp');
    return scp.download(await this._exec(`scp -f ${scp.shq(remote)}`), local);
  }

  async scpUpload(local, remote) {
    const scp = require('./scp');
    await scp.upload(await this._exec(`scp -t ${scp.shq(remote)}`), local);
    return remote;
  }

  // ssh-copy-id embutido: instala a chave pública em ~/.ssh/authorized_keys
  async installPublicKey(publicKey) {
    const line = String(publicKey).trim();
    if (!/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [A-Za-z0-9@._+-]*)?$/.test(line)) throw new Error('Chave pública inválida');
    const cmd = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF ${quote(line)} ~/.ssh/authorized_keys || echo ${quote(line)} >> ~/.ssh/authorized_keys`;
    return new Promise((res, rej) => this.conn.exec(cmd, (e, st) => {
      if (e) return rej(e);
      let err = '';
      st.stderr.on('data', (d) => { err += d; });
      st.on('close', (code) => (code === 0 ? res() : rej(new Error(err || `código ${code}`))));
      st.resume();
    }));
  }

  _finish(reason) {
    if (this.closed) return;
    this.closed = true;
    this.servers.forEach((s) => s.close());
    this.clients.forEach((c) => { try { c.end(); } catch { /* ignora */ } });
    this.onClose(reason);
  }

  close() { this._finish('Sessão fechada'); }
}

// Conexão curta (sem shell) apenas para instalar a chave: reaproveita o mesmo caminho de autenticação.
async function connectOnly(opts) {
  const s = new SshSession({ ...opts, onData() {}, onClose() {}, onStatus() {} });
  const { Client } = require('ssh2');
  s.Client = Client;
  const chain = [...(opts.host.jumpChain || []), opts.host];
  let sock;
  for (let i = 0; i < chain.length; i++) {
    const c = new Client();
    s.clients.push(c);
    await s._connect(c, chain[i], sock);
    if (i < chain.length - 1) {
      const n = chain[i + 1];
      sock = await new Promise((res, rej) => c.forwardOut('127.0.0.1', 0, normalizeAddress(n.address), n.port || 22, (e, st) => (e ? rej(e) : res(st))));
    }
  }
  s.conn = s.clients[s.clients.length - 1];
  return s;
}

module.exports = { SshSession, connectOnly, parseForward, quote, fpOf, algorithmsFor, explainError };
