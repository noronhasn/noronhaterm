'use strict';
const { normalizeAddress } = require('./netutil');
// Cliente Telnet com negociação IAC (ECHO, SGA, TTYPE, NAWS). Sem dependências.
const net = require('net');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;

// Interpreta o fluxo recebido, separando dados de comandos. Mantém estado entre pedaços.
class TelnetParser {
  constructor({ onData, onReply, onSubnegotiation }) {
    this.onData = onData;
    this.onReply = onReply;
    this.onSub = onSubnegotiation;
    this.state = 'data';
    this.cmd = 0;
    this.sub = [];
    this.out = [];
    this.weWill = new Set();
    this.theyWill = new Set();
  }

  _flush() {
    if (this.out.length) { this.onData(Buffer.from(this.out)); this.out = []; }
  }

  feed(buf) {
    for (const b of buf) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac'; else this.out.push(b);
          break;
        case 'iac':
          if (b === IAC) { this.out.push(255); this.state = 'data'; }
          else if (b === DO || b === DONT || b === WILL || b === WONT) { this.cmd = b; this.state = 'opt'; }
          else if (b === SB) { this.sub = []; this.state = 'sb'; }
          else this.state = 'data';
          break;
        case 'opt':
          this._negotiate(this.cmd, b);
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb-iac'; else this.sub.push(b);
          break;
        case 'sb-iac':
          if (b === SE) { this.onSub(this.sub); this.state = 'data'; }
          else { this.sub.push(b); this.state = 'sb'; }
          break;
        default:
      }
    }
    this._flush();
  }

  _negotiate(cmd, opt) {
    const reply = (c) => this.onReply(Buffer.from([IAC, c, opt]));
    if (cmd === DO) {
      if (opt === OPT_TTYPE || opt === OPT_NAWS || opt === OPT_SGA) {
        if (!this.weWill.has(opt)) { this.weWill.add(opt); reply(WILL); }
        if (opt === OPT_NAWS && this.onNaws) this.onNaws();
      } else reply(WONT);
    } else if (cmd === WILL) {
      if (opt === OPT_ECHO || opt === OPT_SGA) {
        if (!this.theyWill.has(opt)) { this.theyWill.add(opt); reply(DO); }
      } else reply(DONT);
    } else if (cmd === DONT) {
      if (this.weWill.delete(opt)) reply(WONT);
    } else if (cmd === WONT) {
      if (this.theyWill.delete(opt)) reply(DONT);
    }
  }
}

const escapeIac = (buf) => {
  if (!buf.includes(255)) return buf;
  const out = [];
  for (const b of buf) { out.push(b); if (b === 255) out.push(255); }
  return Buffer.from(out);
};

class TelnetSession {
  constructor({ host, cols, rows, onData, onClose, onStatus }) {
    this.host = host;
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.onData = onData;
    this.onClose = onClose;
    this.onStatus = onStatus;
    this.enter = host.telnetEnter === 'crnul' ? '\r\0' : '\r\n';
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: normalizeAddress(this.host.address), port: this.host.port || 23 });
      this.sock = sock;
      sock.setKeepAlive(true, 15000);
      sock.setTimeout(20000);
      this.parser = new TelnetParser({
        onData: (d) => this.onData(d),
        onReply: (b) => sock.write(b),
        onSubnegotiation: (sub) => {
          if (sub[0] === OPT_TTYPE && sub[1] === 1) {
            sock.write(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, 0]), Buffer.from('xterm-256color'), Buffer.from([IAC, SE])]));
          }
        },
      });
      this.parser.onNaws = () => this._sendNaws();
      sock.once('connect', () => {
        sock.setTimeout(0);
        this.onStatus(`Telnet conectado a ${this.host.address}:${this.host.port || 23}`);
        resolve();
        (this.host.startupCommands || []).forEach((c, i) => setTimeout(() => this.write(c + '\r'), 300 * (i + 1)));
      });
      sock.on('data', (d) => this.parser.feed(d));
      sock.on('timeout', () => { sock.destroy(new Error('Tempo esgotado ao conectar')); });
      sock.on('error', (e) => { if (!this.closed) reject(e); else this.onStatus(e.message); });
      sock.on('close', () => { if (!this.closed) { this.closed = true; this.onClose('Conexão encerrada'); } });
    });
  }

  _sendNaws() {
    const b = Buffer.from([IAC, SB, OPT_NAWS, this.cols >> 8, this.cols & 255, this.rows >> 8, this.rows & 255, IAC, SE]);
    this.sock.write(b);
  }

  write(data) {
    if (!this.sock || this.sock.destroyed) return;
    const s = String(data).replace(/\r/g, this.enter);
    this.sock.write(escapeIac(Buffer.from(s, 'utf8')));
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    if (this.parser && this.parser.weWill.has(OPT_NAWS)) this._sendNaws();
  }

  close() { this.closed = true; this.sock && this.sock.destroy(); }
}

module.exports = { TelnetSession, TelnetParser, escapeIac };
