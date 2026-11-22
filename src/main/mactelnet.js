'use strict';
// MAC-Telnet (MikroTik): terminal de um equipamento pelo endereço MAC, sem precisar de IP.
// Protocolo próprio sobre UDP 20561 em broadcast na rede local. EXPERIMENTAL: autenticação por senha (MD5).
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = 20561;
const HDR = 22;
const MAGIC = Buffer.from([0x56, 0x34, 0x12, 0xff]);
const PT = { START: 0, DATA: 1, ACK: 2, DISCOVERY: 4, END: 255 };
const CP = { BEGINAUTH: 0, KEY: 1, PASSWORD: 2, USERNAME: 3, TERM: 4, WIDTH: 5, HEIGHT: 6, ENDAUTH: 9 };

const macBytes = (s) => Buffer.from(String(s).split(/[:-]/).map((x) => parseInt(x, 16)));
const validMac = (s) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(String(s || ''));

function header(ptype, src, dst, key, counter) {
  const b = Buffer.alloc(HDR);
  b[0] = 1; b[1] = ptype; src.copy(b, 2); dst.copy(b, 8);
  b.writeUInt16BE(key, 14); b[16] = 0x00; b[17] = 0x15; b.writeUInt32BE(counter >>> 0, 18);
  return b;
}
function control(type, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  const h = Buffer.alloc(9); MAGIC.copy(h, 0); h[4] = type; h.writeUInt32BE(d.length, 5);
  return Buffer.concat([h, d]);
}
function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HDR || buf[0] !== 1) return null;
  const p = { ptype: buf[1], src: buf.subarray(2, 8), dst: buf.subarray(8, 14), key: buf.readUInt16BE(14), counter: buf.readUInt32BE(18), payload: buf.subarray(HDR) };
  p.controls = [];
  if (p.ptype === PT.DATA && p.payload.length >= 9 && p.payload.subarray(0, 4).equals(MAGIC)) {
    let o = 0;
    while (o + 9 <= p.payload.length && p.payload.subarray(o, o + 4).equals(MAGIC)) {
      const t = p.payload[o + 4]; const l = p.payload.readUInt32BE(o + 5);
      if (o + 9 + l > p.payload.length) break;
      p.controls.push({ type: t, data: p.payload.subarray(o + 9, o + 9 + l) }); o += 9 + l;
    }
  }
  return p;
}
const passwordHash = (pass, key) => Buffer.concat([Buffer.from([0]), crypto.createHash('md5').update(Buffer.concat([Buffer.from([0]), Buffer.from(String(pass).slice(0, 82)), key])).digest()]);

function interfaces() { // placas IPv4 com MAC e endereço de broadcast
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask || !a.mac || a.mac === '00:00:00:00:00:00') continue;
      const ip = a.address.split('.').map(Number); const m = a.netmask.split('.').map(Number);
      out.push({ name, address: a.address, mac: a.mac, broadcast: ip.map((x, i) => (x | (~m[i] & 255)) & 255).join('.') });
    }
  }
  return out;
}

class MacTelnetSession {
  constructor({ host, cols, rows, onData, onClose, onStatus, prompt, createSocket, ifaces, timing }) {
    this.host = host; this.cols = cols || 80; this.rows = rows || 24;
    this.onData = onData; this.onClose = onClose; this.onStatus = onStatus; this.prompt = prompt;
    this.createSocket = createSocket || ((o) => dgram.createSocket(o));
    this.ifaces = ifaces || interfaces;
    this.t = { startTimeout: 4000, resend: 700, resendMax: 8, keepalive: 10000, ...(timing || {}) };
    this.dec = new TextDecoder('utf-8');
    this.out = 0; this.in = 0; this.queue = []; this.closed = false;
  }

  async start() {
    if (!validMac(this.host.address)) throw new Error('Endereço MAC inválido: ' + this.host.address);
    this.dst = macBytes(this.host.address);
    let user = this.host.identity && this.host.identity.username;
    let pass = this.host.identity && this.host.identity.password;
    if (!user && this.prompt) user = await this.prompt('MAC-Telnet', 'Usuário em ' + this.host.address, false);
    if (!user) throw new Error('Conexão cancelada');
    if (!pass && this.prompt) pass = await this.prompt('MAC-Telnet', 'Senha de ' + user, true);
    if (pass == null) throw new Error('Conexão cancelada');
    this.user = String(user); this.pass = String(pass);
    const list = this.ifaces();
    if (!list.length) throw new Error('Nenhuma placa de rede IPv4 encontrada');
    this.key = crypto.randomBytes(2).readUInt16BE(0);
    this.onStatus('Procurando ' + this.host.address + ' pela rede local…');
    // um único socket em 0.0.0.0: só assim o sistema entrega os broadcasts de resposta do equipamento
    this.recs = list.map((itf) => ({ itf, src: macBytes(itf.mac) }));
    await new Promise((resolve, reject) => {
      this.fail = reject; this.ready = resolve;
      let sock;
      try { sock = this.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { reject(e); return; }
      this.sock = sock;
      sock.on('error', (e) => {
        if (!this.chosen) reject(new Error('Não consegui usar a porta ' + PORT + ' (feche o WinBox ou libere no firewall): ' + (e.message || e)));
        else this._end('Erro de rede: ' + e.message);
      });
      sock.on('message', (m) => this._onPacket(m));
      sock.bind({ port: PORT, address: '0.0.0.0', exclusive: false }, () => {
        try { sock.setBroadcast(true); } catch { /* ignora */ }
        const ask = () => { if (!this.chosen) this.recs.forEach((r) => this._sendRaw(r, header(PT.START, r.src, this.dst, this.key, 0))); };
        ask(); this.askTimer = setInterval(ask, 1000); if (this.askTimer.unref) this.askTimer.unref();
      });
      this.startTimer = setTimeout(() => { if (!this.chosen) reject(new Error('Equipamento não respondeu. Ele precisa estar na mesma rede local e com MAC-Telnet ativo (Tools > MAC Server), e o Firewall do Windows precisa liberar o NetDeck em redes privadas. Placas usadas: ' + this.recs.map((r) => r.itf.name + ' ' + r.itf.address).join(', ') + '.')); }, this.t.startTimeout);
    }).catch((e) => { this._cleanup(); throw e; });
    clearTimeout(this.startTimer);
  }

  _sendRaw(rec, buf) { // broadcast da placa e broadcast geral (o cliente original usa o geral)
    const dests = [rec.itf.broadcast]; if (rec.itf.broadcast !== '255.255.255.255') dests.push('255.255.255.255');
    for (const d of dests) { try { this.sock.send(buf, PORT, d); } catch { /* ignora */ } }
  }

  _onPacket(msg) {
    const p = parse(msg);
    if (!p || this.closed) return;
    if (!p.src.equals(this.dst) || p.key !== this.key) return;
    const rec = this.recs.find((r) => r.src.equals(p.dst)); // a resposta vem endereçada ao MAC da placa que usamos
    if (!rec) return;
    if (!this.chosen) {
      if (p.ptype !== PT.ACK && p.ptype !== PT.DATA) return;
      this.chosen = rec; clearTimeout(this.startTimer); clearInterval(this.askTimer);
      this.onStatus('Equipamento encontrado pela placa ' + rec.itf.name + '. Autenticando…');
      this._enqueue(control(CP.BEGINAUTH));
      this.ka = setInterval(() => this._sendRaw(this.chosen, header(PT.ACK, this.chosen.src, this.dst, this.key, this.in)), this.t.keepalive);
      if (this.ka.unref) this.ka.unref();
    }
    if (rec !== this.chosen) return;
    if (p.ptype === PT.ACK) { this._acked(p.counter); return; }
    if (p.ptype === PT.END) { this._sendAck(p); this._end('Sessão encerrada pelo equipamento'); return; }
    if (p.ptype !== PT.DATA) return;
    this._sendAck(p);
    const len = p.payload.length;
    if (p.counter + len <= this.in) return; // repetido
    if (p.counter > this.in) return; // faltou um pedaço: espera reenvio
    const fresh = p.payload.subarray(this.in - p.counter);
    this.in = p.counter + len;
    if (p.controls.length) { for (const c of p.controls) this._onControl(c); return; }
    if (fresh.length) this.onData(this.dec.decode(fresh, { stream: true }));
  }

  _sendAck(p) { this._sendRaw(this.chosen, header(PT.ACK, this.chosen.src, this.dst, this.key, p.counter + p.payload.length)); }

  _onControl(c) {
    if (c.type === CP.KEY) {
      if (c.data.length !== 16) { this._failStart(new Error('Este equipamento exige outro tipo de autenticação (EC-SRP), ainda não suportado. Use a conexão pelo roteador vizinho.')); return; }
      this._enqueue(Buffer.concat([
        control(CP.PASSWORD, passwordHash(this.pass, c.data)), control(CP.USERNAME, this.user), control(CP.TERM, 'xterm-256color'),
        control(CP.WIDTH, Buffer.from([this.cols & 255, this.cols >> 8])), control(CP.HEIGHT, Buffer.from([this.rows & 255, this.rows >> 8])),
      ]));
      this.pass = null;
      if (this.ready) { const r = this.ready; this.ready = null; this.fail = null; r(); }
    }
  }
  _failStart(e) { if (this.fail) { const f = this.fail; this.fail = null; this.ready = null; f(e); } else this._end(e.message); }

  // envio um pacote por vez, esperando a confirmação (como o cliente original)
  _enqueue(payload) { this.queue.push({ payload, tries: 0 }); this._pump(); }
  _pump() {
    if (this.inflight || !this.queue.length || !this.chosen) return;
    const it = this.queue.shift(); this.inflight = it; it.counter = this.out; this._transmit(it);
  }
  _transmit(it) {
    this._sendRaw(this.chosen, Buffer.concat([header(PT.DATA, this.chosen.src, this.dst, this.key, it.counter), it.payload]));
    clearTimeout(this.rt);
    this.rt = setTimeout(() => {
      if (this.closed || this.inflight !== it) return;
      if (++it.tries > this.t.resendMax) { this._end('Sem resposta do equipamento'); return; }
      this._transmit(it);
    }, this.t.resend);
  }
  _acked(counter) {
    const it = this.inflight;
    if (!it || counter < it.counter + it.payload.length) return;
    clearTimeout(this.rt); this.out = it.counter + it.payload.length; this.inflight = null; this._pump();
  }

  write(data) {
    if (this.closed || !this.chosen) return;
    const b = Buffer.from(String(data), 'utf8');
    for (let o = 0; o < b.length; o += 1000) this._enqueue(b.subarray(o, o + 1000));
  }
  resize() { /* o protocolo só informa o tamanho no início */ }

  _end(reason) { if (this.closed) return; this._cleanup(); this.onClose(reason || 'Encerrado'); }
  _cleanup() {
    const was = this.closed; this.closed = true;
    clearTimeout(this.rt); clearTimeout(this.startTimer); clearInterval(this.ka); clearInterval(this.askTimer);
    if (this.chosen && !was) this._sendRaw(this.chosen, header(PT.END, this.chosen.src, this.dst, this.key, this.out));
    if (this.sock) { try { this.sock.close(); } catch { /* ignora */ } this.sock = null; }
  }
  close() { this._cleanup(); }
}

module.exports = { MacTelnetSession, parse, header, control, passwordHash, validMac, interfaces, PT, CP, PORT };
