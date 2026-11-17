'use strict';
// Cliente FTP simples (modo passivo) para navegar nas pastas de um equipamento ou servidor, como o FileZilla.
// Sem dependências: só net/fs. FTP puro (sem TLS): usuário e senha trafegam sem cifra, use em rede confiável.
const net = require('net');
const fs = require('fs');
const { once } = require('events');
const path = require('path');

const clean = (s) => String(s).replace(/[\r\n]/g, ''); // nunca deixa quebra de linha entrar num comando

function parseList(text) { // saída de LIST: formato Unix ("drwxr-xr-x ... nome") ou DOS ("01-02-24 10:00AM <DIR> nome")
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || /^total\s/i.test(line)) continue;
    let m = /^([\-dlcbps])[rwxsStT\-]{9}[+@.]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+[\d:]{4,5}|\d{4}-\d\d-\d\d\s+\d\d:\d\d)\s+(.+)$/.exec(line);
    if (m) {
      let name = m[4];
      if (m[1] === 'l') name = name.split(' -> ')[0];
      if (name === '.' || name === '..') continue;
      out.push({ name, size: Number(m[2]), isDir: m[1] === 'd' || m[1] === 'l', mtime: Date.parse(m[3]) || 0 });
      continue;
    }
    m = /^(\d\d-\d\d-\d\d\d?\d?)\s+(\d\d:\d\d\s*[AP]M)\s+(<DIR>|\d+)\s+(.+)$/i.exec(line);
    if (m) { out.push({ name: m[4], size: m[3] === '<DIR>' ? 0 : Number(m[3]), isDir: m[3] === '<DIR>', mtime: Date.parse(m[1] + ' ' + m[2]) || 0 }); continue; }
    m = /^(\S+)\s+(\S+)\s*$/.exec(line); // lista só com nomes
    if (m === null && line.length < 256) out.push({ name: line.trim(), size: 0, isDir: false, mtime: 0 });
  }
  return out;
}

function parseMlsd(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(' ');
    if (!line || i < 0) continue;
    const facts = {};
    line.slice(0, i).split(';').forEach((f) => { const k = f.indexOf('='); if (k > 0) facts[f.slice(0, k).toLowerCase()] = f.slice(k + 1); });
    const name = line.slice(i + 1);
    if (!facts.type || /^(cdir|pdir)$/i.test(facts.type) || name === '.' || name === '..') continue;
    const mt = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(facts.modify || '');
    out.push({ name, size: Number(facts.size) || 0, isDir: /^dir$/i.test(facts.type), mtime: mt ? Date.UTC(+mt[1], +mt[2] - 1, +mt[3], +mt[4], +mt[5], +mt[6]) : 0 });
  }
  return out;
}

class FtpClient {
  constructor() { this.buf = ''; this.waiters = []; this.closed = false; }

  async connect({ host, port = 21, user = 'anonymous', password = 'anonymous@', timeoutMs = 15000 }) {
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.sock = net.connect({ host, port });
    this.sock.setTimeout(timeoutMs * 4, () => this.sock.destroy(new Error('Tempo esgotado')));
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => { this.buf += d; this._wake(); });
    const end = () => { this.closed = true; this._wake(); };
    this.sock.on('close', end);
    this.sock.on('error', (e) => { this.err = e; end(); });
    const hello = await this._reply();
    if (hello.code !== 220) throw new Error('Servidor FTP recusou: ' + hello.text);
    let r = await this.cmd('USER ' + clean(user));
    if (r.code === 331) r = await this.cmd('PASS ' + clean(password));
    if (r.code !== 230) throw new Error(r.code === 530 ? 'Usuário ou senha incorretos' : 'Login recusado: ' + r.text);
    await this.cmd('TYPE I');
    return this;
  }

  _wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  _take() { // tira uma resposta completa do buffer (aceita respostas de várias linhas "123-...")
    const lines = this.buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const m = /^(\d{3})([ -])/.exec(lines[i]);
      if (m && m[2] === ' ') {
        const text = lines.slice(0, i + 1).join('\n');
        this.buf = lines.slice(i + 1).join('\r\n');
        return { code: Number(m[1]), text: text.replace(/^\d{3}[ -]/gm, '') };
      }
    }
    return null;
  }

  async _reply() {
    const timer = setTimeout(() => this.sock.destroy(new Error('O servidor FTP não respondeu a tempo')), this.timeoutMs * 4);
    try {
      for (;;) {
        const r = this._take();
        if (r) return r;
        if (this.closed) throw this.err || new Error('Conexão FTP encerrada');
        await new Promise((res) => { this.waiters.push(res); });
      }
    } finally { clearTimeout(timer); }
  }

  async cmd(c) { this.sock.write(c + '\r\n'); return this._reply(); }

  async _pasv() {
    let r = await this.cmd('EPSV');
    if (r.code === 229) {
      const m = /\|\|\|(\d+)\|/.exec(r.text);
      if (m) return Number(m[1]);
    }
    r = await this.cmd('PASV');
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
    if (r.code !== 227 || !m) throw new Error('O servidor não aceitou o modo passivo: ' + r.text);
    return Number(m[5]) * 256 + Number(m[6]); // sempre volta ao mesmo endereço da conexão (ignora IP interno informado)
  }

  // abre o canal de dados, manda o comando e entrega o socket de dados a `use`
  async _transfer(command, use) {
    const port = await this._pasv();
    const d = net.connect({ host: this.host, port });
    d.setTimeout(this.timeoutMs * 4, () => d.destroy(new Error('Tempo esgotado na transferência')));
    d.on('error', () => {});
    await once(d, 'connect');
    let r;
    try {
      r = await this.cmd(command);
      if (r.code >= 400) throw new Error(r.text || 'Erro do servidor FTP');
      await use(d);
    } catch (e) { d.destroy(); throw e; }
    const end = await this._reply();
    if (end.code >= 400) throw new Error(end.text || 'Transferência falhou');
  }

  async pwd() {
    const r = await this.cmd('PWD');
    const m = /"(.*)"/.exec(r.text);
    return m ? m[1].replace(/""/g, '"') : '/';
  }

  async list(dir) {
    if (dir && dir !== '.') {
      const r = await this.cmd('CWD ' + clean(dir));
      if (r.code >= 400) throw new Error(r.text || 'Pasta não encontrada');
    }
    const abs = await this.pwd();
    const grab = (d) => new Promise((res, rej) => { const c = []; d.on('data', (x) => c.push(x)); d.on('end', () => res(Buffer.concat(c).toString('utf8'))); d.on('error', rej); });
    let text = ''; let mlsd = true;
    try { await this._transfer('MLSD', async (d) => { text = await grab(d); }); } catch { mlsd = false; }
    if (!mlsd) await this._transfer('LIST', async (d) => { text = await grab(d); });
    const items = (mlsd ? parseMlsd(text) : parseList(text)).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { path: abs, items };
  }

  async download(remote, local) {
    const out = fs.createWriteStream(local);
    try {
      await this._transfer('RETR ' + clean(remote), (d) => new Promise((res, rej) => { d.pipe(out); out.on('finish', res); out.on('error', rej); d.on('error', rej); }));
    } finally { out.destroy(); }
  }

  async upload(local, remoteDir) {
    const dest = (remoteDir === '/' ? '' : remoteDir) + '/' + path.basename(local);
    await this._transfer('STOR ' + clean(dest), (d) => new Promise((res, rej) => {
      const src = fs.createReadStream(local);
      src.on('error', rej); d.on('error', rej); d.on('close', res);
      src.pipe(d);
    }));
    return dest;
  }

  close() { try { this.sock.write('QUIT\r\n'); } catch { /* ignora */ } try { this.sock.destroy(); } catch { /* ignora */ } }
}

module.exports = { FtpClient, parseList, parseMlsd };
