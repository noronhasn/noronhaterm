'use strict';
// Servidores TFTP e FTP embutidos, para subir/baixar firmware e configuração de equipamentos de rede.
// Sem dependências externas (só dgram/net/fs). Tudo fica preso à pasta raiz escolhida.
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------- caminho seguro dentro da raiz
// Transforma um caminho pedido pelo cliente em um caminho real DENTRO da raiz, ou devolve null.
function jail(root, requested) {
  const rootReal = fs.realpathSync(root);
  const clean = String(requested || '').replace(/\0/g, '').replace(/\\/g, '/');
  const full = path.resolve(rootReal, '.' + path.posix.normalize('/' + clean));
  const inside = (p) => p === rootReal || p.startsWith(rootReal + path.sep);
  if (!inside(full)) return null;
  // segue links simbólicos: o alvo real (ou o da pasta pai, se o arquivo ainda não existe) tem de continuar dentro da raiz
  let probe = full;
  while (!fs.existsSync(probe) && probe !== rootReal) probe = path.dirname(probe);
  let real;
  try { real = fs.realpathSync(probe); } catch { return null; }
  if (!inside(real)) return null;
  return full;
}

// ---------------------------------------------------------------- TFTP (RFC 1350 + opções 2347/2348/2349)
const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERR: 5, OACK: 6 };

function tftpPacket(op, ...parts) { return Buffer.concat([Buffer.from([0, op]), ...parts]); }
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
const tftpError = (code, msg) => tftpPacket(OP.ERR, u16(code), cstr(msg));

function parseRequest(msg) {
  const parts = msg.subarray(2).toString('utf8').split('\0');
  parts.pop(); // sobra depois do último \0
  if (parts.length < 2) return null;
  const opts = {};
  for (let i = 2; i + 1 < parts.length; i += 2) opts[parts[i].toLowerCase()] = parts[i + 1];
  return { file: parts[0], mode: parts[1].toLowerCase(), opts };
}

class TftpServer extends EventEmitter {
  constructor({ root, port = 69, allowWrite = false, host = '0.0.0.0', timeoutMs = 3000, retries = 5 }) {
    super();
    Object.assign(this, { root, port, allowWrite, host, timeoutMs, retries });
    this.sock = null;
    this.transfers = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.once('error', reject);
      s.on('message', (msg, rinfo) => { try { this._onRequest(msg, rinfo); } catch (e) { this.emit('log', 'TFTP erro: ' + e.message); } });
      s.bind(this.port, this.host, () => {
        s.removeListener('error', reject);
        s.on('error', (e) => this.emit('log', 'TFTP erro: ' + e.message));
        this.sock = s;
        this.port = s.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    for (const t of [...this.transfers]) t.abort();
    return new Promise((r) => { if (!this.sock) return r(); const s = this.sock; this.sock = null; s.close(() => r()); });
  }

  _onRequest(msg, rinfo) {
    if (msg.length < 4) return;
    const op = msg.readUInt16BE(0);
    if (op !== OP.RRQ && op !== OP.WRQ) return;
    const req = parseRequest(msg);
    const reply = (code, text) => this.sock && this.sock.send(tftpError(code, text), rinfo.port, rinfo.address);
    if (!req) return reply(4, 'Pedido inválido');
    if (req.mode !== 'octet' && req.mode !== 'netascii') return reply(4, 'Modo não suportado');
    const who = `${rinfo.address}:${rinfo.port}`;
    if (op === OP.WRQ && !this.allowWrite) { this.emit('log', `TFTP ${who} tentou enviar "${req.file}" (gravação desligada)`); return reply(2, 'Gravação não permitida'); }
    const file = jail(this.root, req.file);
    if (!file) { this.emit('log', `TFTP ${who} pediu caminho fora da pasta: ${req.file}`); return reply(2, 'Acesso negado'); }
    if (op === OP.RRQ) {
      let st;
      try { st = fs.statSync(file); } catch { this.emit('log', `TFTP ${who} pediu "${req.file}": não existe`); return reply(1, 'Arquivo não encontrado'); }
      if (!st.isFile()) return reply(1, 'Arquivo não encontrado');
    } else {
      try { if (fs.existsSync(file) && !fs.statSync(file).isFile()) return reply(2, 'Acesso negado'); } catch { return reply(2, 'Acesso negado'); }
      if (!fs.existsSync(path.dirname(file))) return reply(2, 'Pasta de destino não existe');
    }
    const t = new TftpTransfer(this, op === OP.RRQ ? 'read' : 'write', file, req, rinfo);
    this.transfers.add(t);
    t.on('done', () => this.transfers.delete(t));
    t.start();
  }
}

class TftpTransfer extends EventEmitter {
  constructor(server, kind, file, req, rinfo) {
    super();
    Object.assign(this, { server, kind, file, rinfo, name: req.file });
    this.who = `${rinfo.address}:${rinfo.port}`;
    this.blksize = 512;
    this.timeout = server.timeoutMs;
    this.opts = {};
    this.bytes = 0;
    this.block = 0;
    this.lastPacket = null;
    this.tries = 0;
    this.finished = false;
    this.sock = dgram.createSocket('udp4');
    // opções negociadas (blksize / timeout / tsize); o que não entendermos é ignorado
    const bs = parseInt(req.opts.blksize, 10);
    if (bs >= 8 && bs <= 65464) { this.blksize = bs; this.opts.blksize = String(bs); }
    const to = parseInt(req.opts.timeout, 10);
    if (to >= 1 && to <= 255) { this.timeout = to * 1000; this.opts.timeout = String(to); }
    if ('tsize' in req.opts) {
      if (kind === 'read') this.opts.tsize = String(fs.statSync(file).size);
      else if (/^\d+$/.test(req.opts.tsize)) this.opts.tsize = req.opts.tsize;
    }
  }

  start() {
    this.sock.on('message', (m, r) => { if (r.address === this.rinfo.address && r.port === this.rinfo.port) this._onPacket(m); });
    this.sock.on('error', (e) => this._end(false, e.message));
    this.sock.bind(0, () => {
      try {
        if (this.kind === 'read') this.fd = fs.openSync(this.file, 'r'); else { this.fd = fs.openSync(this.file + '.nt-partial', 'w'); }
      } catch (e) { return this._fail(2, 'Não foi possível abrir o arquivo'); }
      const hasOpts = Object.keys(this.opts).length > 0;
      if (hasOpts) {
        const pairs = Object.entries(this.opts).flatMap(([k, v]) => [cstr(k), cstr(v)]);
        this._send(tftpPacket(OP.OACK, ...pairs));
      } else if (this.kind === 'read') this._sendData(1);
      else this._send(tftpPacket(OP.ACK, u16(0)));
      this.awaitingOack = hasOpts;
    });
  }

  _send(buf) {
    this.lastPacket = buf;
    this.tries = 0;
    this._raw(buf);
    this._arm();
  }

  _raw(buf) { try { this.sock.send(buf, this.rinfo.port, this.rinfo.address); } catch { /* socket fechado */ } }

  _arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.finished) return;
      if (++this.tries > this.server.retries) return this._end(false, 'tempo esgotado');
      this._raw(this.lastPacket);
      this._arm();
    }, this.timeout);
    if (this.timer.unref) this.timer.unref();
  }

  _sendData(n) {
    const buf = Buffer.alloc(this.blksize);
    const off = (n - 1) * this.blksize;
    let len;
    try { len = fs.readSync(this.fd, buf, 0, this.blksize, off); } catch { return this._fail(2, 'Erro de leitura'); }
    this.block = n;
    this.lastLen = len;
    this._send(tftpPacket(OP.DATA, u16(n), buf.subarray(0, len)));
  }

  _onPacket(m) {
    if (m.length < 4 || this.finished) return;
    const op = m.readUInt16BE(0);
    if (op === OP.ERR) return this._end(false, 'cliente cancelou: ' + m.subarray(4, m.length - 1).toString());
    const n = m.readUInt16BE(2);
    if (this.kind === 'read') {
      if (op !== OP.ACK) return;
      if (this.awaitingOack) { if (n !== 0) return; this.awaitingOack = false; return this._sendData(1); }
      if (n !== (this.block & 0xffff)) return; // ACK repetido/antigo
      this.bytes += this.lastLen;
      if (this.lastLen < this.blksize) return this._end(true);
      this._sendData(this.block + 1);
    } else {
      if (op !== OP.DATA) return;
      if (this.awaitingOack) this.awaitingOack = false;
      const expected = (this.block + 1) & 0xffff;
      if (n === (this.block & 0xffff) && this.block > 0) return this._raw(tftpPacket(OP.ACK, u16(n))); // DATA repetido
      if (n !== expected) return;
      const data = m.subarray(4);
      try { fs.writeSync(this.fd, data, 0, data.length, this.bytes); } catch { return this._fail(3, 'Disco cheio ou sem permissão'); }
      this.bytes += data.length;
      this.block++;
      this._send(tftpPacket(OP.ACK, u16(n)));
      if (data.length < this.blksize) { clearTimeout(this.timer); this._end(true, null, true); }
    }
  }

  _fail(code, text) { this._raw(tftpError(code, text)); this._end(false, text); }

  abort() { this._end(false, 'servidor parado'); }

  _end(ok, why, lingerAck) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    try { if (this.fd !== undefined) fs.closeSync(this.fd); } catch { /* ignora */ }
    if (this.kind === 'write') {
      const part = this.file + '.nt-partial';
      try { if (ok) fs.renameSync(part, this.file); else fs.rmSync(part, { force: true }); } catch { /* ignora */ }
    }
    const verb = this.kind === 'read' ? 'enviou para' : 'recebeu de';
    this.server.emit('log', ok ? `TFTP ${verb} ${this.who}: "${this.name}" (${this.bytes} bytes) OK` : `TFTP ${this.kind === 'read' ? 'envio para' : 'recebimento de'} ${this.who} "${this.name}" falhou: ${why}`);
    const close = () => { try { this.sock.close(); } catch { /* ignora */ } this.emit('done'); };
    if (lingerAck) setTimeout(close, 200); else close(); // dá tempo do último ACK sair
  }
}

// ---------------------------------------------------------------- FTP
const pw = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameStr = (a, b) => crypto.timingSafeEqual(pw(a), pw(b));
const ipOf = (a) => String(a || '').replace(/^::ffff:/, '');

function lsLine(name, st) {
  const d = st.isDirectory();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][st.mtime.getMonth()];
  const day = String(st.mtime.getDate()).padStart(2, ' ');
  const hhmm = `${String(st.mtime.getHours()).padStart(2, '0')}:${String(st.mtime.getMinutes()).padStart(2, '0')}`;
  return `${d ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ftp ftp ${String(d ? 4096 : st.size).padStart(12, ' ')} ${mon} ${day} ${hhmm} ${name}`;
}

class FtpServer extends EventEmitter {
  constructor({ root, port = 21, allowWrite = false, user = '', password = '', anonymous = false, host = '0.0.0.0', pasvMin = 50000, pasvMax = 50100 }) {
    super();
    Object.assign(this, { root, port, allowWrite, user, password, anonymous, host, pasvMin, pasvMax });
    if (!anonymous && (!user || !password)) throw new Error('Defina usuário e senha do FTP (ou ligue o acesso anônimo)');
    this.srv = null;
    this.conns = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      const s = net.createServer((sock) => this._onConn(sock));
      s.once('error', reject);
      s.listen(this.port, this.host, () => { s.removeListener('error', reject); s.on('error', (e) => this.emit('log', 'FTP erro: ' + e.message)); this.srv = s; this.port = s.address().port; resolve(this.port); });
    });
  }

  stop() {
    for (const c of [...this.conns]) c.destroy();
    return new Promise((r) => { if (!this.srv) return r(); const s = this.srv; this.srv = null; s.close(() => r()); });
  }

  _onConn(sock) {
    this.conns.add(sock);
    const peer = ipOf(sock.remoteAddress);
    const local = ipOf(sock.localAddress);
    const st = { user: null, authed: false, cwd: '/', rnfr: null, pasv: null, port: null, fails: 0, rest: 0 };
    let buf = '';
    const reply = (code, text) => { if (!sock.destroyed) sock.write(`${code} ${text}\r\n`); };
    const multi = (code, lines) => { sock.write(`${code}-${lines[0]}\r\n${lines.slice(1).map((l) => ' ' + l + '\r\n').join('')}${code} End\r\n`); };
    sock.setTimeout(5 * 60 * 1000, () => { reply(421, 'Tempo esgotado'); sock.end(); });
    sock.on('close', () => { this.conns.delete(sock); this._closePasv(st); });
    sock.on('error', () => {});
    this.emit('log', `FTP conexão de ${peer}`);
    reply(220, 'NetDeck FTP pronto');

    const virt = (p) => (p ? (p.startsWith('/') ? path.posix.normalize(p) : path.posix.normalize(path.posix.join(st.cwd, p))) : st.cwd);
    const real = (p) => jail(this.root, virt(p));
    const needAuth = () => { if (!st.authed) { reply(530, 'Faça login primeiro'); return true; } return false; };
    const needWrite = () => { if (!this.allowWrite) { reply(550, 'Gravação não permitida'); return true; } return false; };

    const openData = () => new Promise((resolve, reject) => {
      if (st.pasv) {
        const p = st.pasv; st.pasv = null;
        const timer = setTimeout(() => { p.server.close(); reject(new Error('timeout')); }, 30000);
        p.accept = (s) => { clearTimeout(timer); resolve(s); };
        if (p.early) { clearTimeout(timer); resolve(p.early); }
      } else if (st.port) {
        const { host, p } = st.port; st.port = null;
        const s = net.connect(p, host, () => resolve(s));
        s.setTimeout(30000, () => { s.destroy(); reject(new Error('timeout')); });
        s.on('error', reject);
      } else reject(new Error('sem conexão de dados'));
    });

    const transfer = async (fn) => {
      reply(150, 'Abrindo conexão de dados');
      let d;
      try { d = await openData(); } catch { return reply(425, 'Não foi possível abrir a conexão de dados'); }
      d.setTimeout(60000, () => d.destroy());
      try { await fn(d); reply(226, 'Transferência concluída'); } catch (e) { try { d.destroy(); } catch { /* ignora */ } reply(e.ftpCode || 451, e.message || 'Erro na transferência'); }
    };

    const handlers = {
      USER: (a) => {
        st.user = a; st.authed = false;
        if (this.anonymous && /^(anonymous|ftp)$/i.test(a)) return reply(331, 'Informe qualquer e-mail como senha');
        reply(331, 'Senha necessária');
      },
      PASS: (a) => {
        const anon = this.anonymous && st.user && /^(anonymous|ftp)$/i.test(st.user);
        const ok = anon || (st.user && this.user && sameStr(st.user, this.user) && sameStr(a, this.password));
        if (ok) { st.authed = true; this.emit('log', `FTP login de ${peer} como ${st.user}`); return reply(230, 'Login feito'); }
        this.emit('log', `FTP login recusado de ${peer} (usuário ${st.user})`);
        if (++st.fails >= 5) { reply(421, 'Muitas tentativas'); return sock.end(); }
        reply(530, 'Usuário ou senha incorretos');
      },
      SYST: () => reply(215, 'UNIX Type: L8'),
      FEAT: () => multi(211, ['Extensões:', 'PASV', 'EPSV', 'SIZE', 'MDTM', 'UTF8']),
      OPTS: () => reply(200, 'OK'),
      NOOP: () => reply(200, 'OK'),
      TYPE: () => reply(200, 'Tipo alterado'),
      MODE: () => reply(200, 'OK'),
      STRU: () => reply(200, 'OK'),
      QUIT: () => { reply(221, 'Tchau'); sock.end(); },
      PWD: () => { if (!needAuth()) reply(257, `"${st.cwd}" é a pasta atual`); },
      CWD: (a) => {
        if (needAuth()) return;
        const p = real(a); let ok = false;
        try { ok = !!p && fs.statSync(p).isDirectory(); } catch { /* ignora */ }
        if (!ok) return reply(550, 'Pasta não encontrada');
        st.cwd = virt(a); reply(250, 'Pasta alterada');
      },
      CDUP: () => handlers.CWD('..'),
      PASV: () => {
        if (needAuth()) return;
        this._closePasv(st);
        this._listenPasv(peer, st).then((port) => {
          const h = local.split('.').join(',');
          reply(227, `Entrando em modo passivo (${h},${port >> 8},${port & 255})`);
        }, () => reply(425, 'Sem porta passiva livre'));
      },
      EPSV: () => {
        if (needAuth()) return;
        this._closePasv(st);
        this._listenPasv(peer, st).then((port) => reply(229, `Entrando em modo passivo estendido (|||${port}|)`), () => reply(425, 'Sem porta passiva livre'));
      },
      PORT: (a) => {
        if (needAuth()) return;
        const n = String(a).split(',').map((x) => parseInt(x, 10));
        if (n.length !== 6 || n.some((x) => !(x >= 0 && x <= 255))) return reply(501, 'Argumento inválido');
        const host = n.slice(0, 4).join('.');
        if (host !== peer) return reply(500, 'Endereço de dados diferente do cliente'); // evita "FTP bounce"
        this._closePasv(st);
        st.port = { host, p: n[4] * 256 + n[5] };
        reply(200, 'PORT aceito');
      },
      LIST: async (a) => {
        if (needAuth()) return;
        const arg = a && !a.startsWith('-') ? a : '';
        const p = real(arg);
        await transfer(async (d) => {
          if (!p || !fs.existsSync(p)) { const e = new Error('Caminho não encontrado'); e.ftpCode = 550; throw e; }
          const s = fs.statSync(p);
          const rows = s.isDirectory() ? fs.readdirSync(p).map((f) => { try { return lsLine(f, fs.statSync(path.join(p, f))); } catch { return null; } }).filter(Boolean) : [lsLine(path.basename(p), s)];
          await new Promise((r) => d.end(rows.map((x) => x + '\r\n').join(''), r));
        });
      },
      NLST: async (a) => {
        if (needAuth()) return;
        const p = real(a && !a.startsWith('-') ? a : '');
        await transfer(async (d) => {
          if (!p || !fs.existsSync(p)) { const e = new Error('Caminho não encontrado'); e.ftpCode = 550; throw e; }
          const names = fs.statSync(p).isDirectory() ? fs.readdirSync(p) : [path.basename(p)];
          await new Promise((r) => d.end(names.map((x) => x + '\r\n').join(''), r));
        });
      },
      RETR: async (a) => {
        if (needAuth()) return;
        const p = real(a); let ok = false;
        try { ok = !!p && fs.statSync(p).isFile(); } catch { /* ignora */ }
        if (!ok) return reply(550, 'Arquivo não encontrado');
        let bytes = 0;
        await transfer((d) => new Promise((res, rej) => {
          const rs = fs.createReadStream(p);
          rs.on('data', (c) => { bytes += c.length; });
          rs.on('error', rej); d.on('error', rej);
          d.on('close', () => res());
          rs.pipe(d);
        }));
        this.emit('log', `FTP ${peer} baixou ${virt(a)} (${bytes} bytes)`);
      },
      STOR: async (a) => {
        if (needAuth() || needWrite()) return;
        const p = real(a);
        if (!p || !fs.existsSync(path.dirname(p))) return reply(550, 'Destino inválido');
        try { if (fs.existsSync(p) && !fs.statSync(p).isFile()) return reply(550, 'Destino inválido'); } catch { return reply(550, 'Destino inválido'); }
        const part = p + '.nt-partial';
        let bytes = 0;
        await transfer((d) => new Promise((res, rej) => {
          const ws = fs.createWriteStream(part);
          d.on('data', (c) => { bytes += c.length; });
          ws.on('error', (e) => { try { fs.rmSync(part, { force: true }); } catch { /* ignora */ } rej(e); });
          d.on('error', (e) => { ws.destroy(); try { fs.rmSync(part, { force: true }); } catch { /* ignora */ } rej(e); });
          ws.on('finish', () => { try { fs.renameSync(part, p); res(); } catch (e) { rej(e); } });
          d.pipe(ws);
        }));
        this.emit('log', `FTP ${peer} enviou ${virt(a)} (${bytes} bytes)`);
      },
      SIZE: (a) => {
        if (needAuth()) return;
        const p = real(a);
        try { const s = fs.statSync(p); if (s.isFile()) return reply(213, String(s.size)); } catch { /* ignora */ }
        reply(550, 'Arquivo não encontrado');
      },
      MDTM: (a) => {
        if (needAuth()) return;
        const p = real(a);
        try { const s = fs.statSync(p); if (s.isFile()) return reply(213, s.mtime.toISOString().replace(/[-:T]/g, '').slice(0, 14)); } catch { /* ignora */ }
        reply(550, 'Arquivo não encontrado');
      },
      DELE: (a) => {
        if (needAuth() || needWrite()) return;
        const p = real(a);
        try { if (p && fs.statSync(p).isFile()) { fs.unlinkSync(p); this.emit('log', `FTP ${peer} apagou ${virt(a)}`); return reply(250, 'Arquivo apagado'); } } catch { /* ignora */ }
        reply(550, 'Não foi possível apagar');
      },
      MKD: (a) => {
        if (needAuth() || needWrite()) return;
        const p = real(a);
        try { if (p) { fs.mkdirSync(p); return reply(257, `"${virt(a)}" criada`); } } catch { /* ignora */ }
        reply(550, 'Não foi possível criar a pasta');
      },
      RMD: (a) => {
        if (needAuth() || needWrite()) return;
        const p = real(a);
        try { if (p && p !== fs.realpathSync(this.root)) { fs.rmdirSync(p); return reply(250, 'Pasta removida'); } } catch { /* ignora */ }
        reply(550, 'Não foi possível remover a pasta');
      },
      RNFR: (a) => {
        if (needAuth() || needWrite()) return;
        const p = real(a);
        if (!p || !fs.existsSync(p)) return reply(550, 'Não encontrado');
        st.rnfr = p; reply(350, 'Informe o novo nome');
      },
      RNTO: (a) => {
        if (needAuth() || needWrite()) return;
        const from = st.rnfr; st.rnfr = null;
        const to = real(a);
        if (!from || !to) return reply(503, 'Use RNFR antes');
        try { fs.renameSync(from, to); return reply(250, 'Renomeado'); } catch { reply(550, 'Não foi possível renomear'); }
      },
      REST: () => reply(502, 'REST não suportado'),
      ABOR: () => reply(226, 'OK'),
    };
    handlers.XPWD = handlers.PWD; handlers.XCWD = handlers.CWD; handlers.XCUP = handlers.CDUP; handlers.XMKD = handlers.MKD; handlers.XRMD = handlers.RMD;

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 8192) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const m = /^(\S+)(?: (.*))?$/.exec(line);
        if (!m) { reply(500, 'Comando inválido'); continue; }
        const cmd = m[1].toUpperCase(); const arg = m[2] || '';
        const fn = handlers[cmd];
        if (!fn) { reply(502, `${cmd} não implementado`); continue; }
        if (!st.authed && !['USER', 'PASS', 'QUIT', 'SYST', 'FEAT', 'OPTS', 'NOOP', 'TYPE'].includes(cmd)) { reply(530, 'Faça login primeiro'); continue; }
        Promise.resolve().then(() => fn(arg)).catch((e) => reply(451, e.message));
      }
    });
  }

  _closePasv(st) { if (st.pasv) { try { st.pasv.server.close(); } catch { /* ignora */ } st.pasv = null; } st.port = null; }

  _listenPasv(peer, st) {
    return new Promise((resolve, reject) => {
      const tryPort = (p) => {
        if (p > this.pasvMax) return reject(new Error('sem porta'));
        const rec = { server: null, accept: null, early: null };
        const s = net.createServer((d) => {
          if (ipOf(d.remoteAddress) !== peer) { d.destroy(); return; } // só o próprio cliente pode usar
          s.close();
          if (rec.accept) rec.accept(d); else rec.early = d; // o cliente pode conectar antes do comando de transferência chegar
        });
        rec.server = s;
        s.once('error', () => tryPort(p + 1));
        s.listen(p, this.host, () => { s.on('error', () => {}); st.pasv = rec; resolve(s.address().port); });
      };
      tryPort(this.pasvMin);
    });
  }
}

// ---------------------------------------------------------------- gerenciador (config + liga/desliga)
const DEFAULT_CFG = {
  root: '',
  tftp: { enabled: false, port: 69, allowWrite: true },
  ftp: { enabled: false, port: 21, allowWrite: true, user: 'admin', password: '', anonymous: false },
};

function sanitizeServers(c = {}) {
  const port = (v, d) => { const n = Math.floor(Number(v)); return n >= 1 && n <= 65535 ? n : d; };
  const t = c.tftp || {}; const f = c.ftp || {};
  return {
    root: typeof c.root === 'string' ? c.root.trim() : '',
    tftp: { enabled: !!t.enabled, port: port(t.port, 69), allowWrite: t.allowWrite !== false },
    ftp: {
      enabled: !!f.enabled, port: port(f.port, 21), allowWrite: f.allowWrite !== false,
      user: typeof f.user === 'string' ? f.user.trim().slice(0, 40) : 'admin',
      password: typeof f.password === 'string' ? f.password.slice(0, 100) : '',
      anonymous: !!f.anonymous,
    },
  };
}

const explainListenError = (e, port) => {
  if (e.code === 'EADDRINUSE') return `A porta ${port} já está em uso por outro programa`;
  if (e.code === 'EACCES') return `Sem permissão para usar a porta ${port}. No Linux, portas abaixo de 1024 exigem root: use uma porta maior (ex.: 2121 / 6969)`;
  return e.message;
};

class ServerManager extends EventEmitter {
  constructor({ configFile }) {
    super();
    this.configFile = configFile;
    this.cfg = sanitizeServers(DEFAULT_CFG);
    try { this.cfg = sanitizeServers(JSON.parse(fs.readFileSync(configFile, 'utf8'))); } catch { /* primeira vez */ }
    this.tftp = null; this.ftp = null;
    this.errors = { tftp: null, ftp: null };
    this.logs = [];
  }

  _log(line) {
    const t = new Date();
    const hh = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    this.logs.push(`${hh}  ${line}`);
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    this.emit('log');
  }

  status() {
    const { password, ...ftp } = this.cfg.ftp;
    return {
      config: { ...this.cfg, ftp: { ...ftp, hasPassword: !!password } },
      running: { tftp: !!this.tftp, ftp: !!this.ftp },
      errors: { ...this.errors },
      logs: [...this.logs],
    };
  }

  async apply(patch) {
    const cur = this.cfg;
    const merged = {
      ...cur, ...patch,
      tftp: { ...cur.tftp, ...(patch.tftp || {}) },
      // senha vazia vinda da tela = manter a atual
      ftp: { ...cur.ftp, ...(patch.ftp || {}), password: patch.ftp && patch.ftp.password ? patch.ftp.password : cur.ftp.password },
    };
    this.cfg = sanitizeServers(merged);
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    await this.restart();
    return this.status();
  }

  async stopAll() {
    if (this.tftp) { await this.tftp.stop(); this.tftp = null; this._log('TFTP parado'); }
    if (this.ftp) { await this.ftp.stop(); this.ftp = null; this._log('FTP parado'); }
  }

  async restart() {
    await this.stopAll();
    this.errors = { tftp: null, ftp: null };
    const { root, tftp, ftp } = this.cfg;
    if (!tftp.enabled && !ftp.enabled) return;
    try {
      if (!root) throw new Error('Escolha a pasta raiz dos servidores');
      if (!fs.statSync(root).isDirectory()) throw new Error('A pasta raiz não é uma pasta');
    } catch (e) {
      const msg = e.code === 'ENOENT' ? 'A pasta raiz não existe: ' + root : e.message;
      if (tftp.enabled) this.errors.tftp = msg;
      if (ftp.enabled) this.errors.ftp = msg;
      return;
    }
    if (tftp.enabled) {
      const s = new TftpServer({ root, port: tftp.port, allowWrite: tftp.allowWrite });
      s.on('log', (l) => this._log(l));
      try { await s.start(); this.tftp = s; this._log(`TFTP ligado na porta ${tftp.port} (${tftp.allowWrite ? 'leitura e gravação' : 'somente leitura'})`); } catch (e) { this.errors.tftp = explainListenError(e, tftp.port); }
    }
    if (ftp.enabled) {
      try {
        const s = new FtpServer({ root, port: ftp.port, allowWrite: ftp.allowWrite, user: ftp.user, password: ftp.password, anonymous: ftp.anonymous });
        s.on('log', (l) => this._log(l));
        await s.start(); this.ftp = s; this._log(`FTP ligado na porta ${ftp.port} (${ftp.allowWrite ? 'leitura e gravação' : 'somente leitura'})`);
      } catch (e) { this.errors.ftp = explainListenError(e, ftp.port); }
    }
  }
}

module.exports = { TftpServer, FtpServer, ServerManager, jail, sanitizeServers };
