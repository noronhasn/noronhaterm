'use strict';
// Substitui o módulo "net" do Node no Android: as conexões TCP são abertas pelo código nativo (plugin NetDeckNet).
// Só o necessário para o cliente Telnet: connect, write, destroy, eventos connect/data/close/error/timeout.
let native = null;
const sockets = new Map(); // sid -> Socket
let seq = 0;
let wired = false;

function setNative(n) {
  native = n;
  if (wired || !n || !n.on) return;
  wired = true;
  n.on('tcpdata', (e) => { const s = sockets.get(e.sid); if (s) s._data(e.b64); });
  n.on('tcpclosed', (e) => { const s = sockets.get(e.sid); if (s) s._closed(e.error); });
}

const fromB64 = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const toB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };

class Socket {
  constructor() { this.handlers = {}; this.destroyed = false; this.timer = null; this.timeoutMs = 0; this.sid = 'tcp-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8); }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  off(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((x) => x !== fn); return this; }
  emit(ev, ...a) { for (const fn of [...(this.handlers[ev] || [])]) fn(...a); }
  setKeepAlive() { return this; }
  setTimeout(ms) {
    this.timeoutMs = ms;
    clearTimeout(this.timer);
    if (ms > 0) this.timer = setTimeout(() => this.emit('timeout'), ms);
    return this;
  }
  connect(host, port) {
    sockets.set(this.sid, this);
    Promise.resolve()
      .then(() => native.tcpOpen({ sid: this.sid, host, port, timeout: this.timeoutMs || 20000 }))
      .then(() => { if (this.destroyed) return; clearTimeout(this.timer); this.emit('connect'); },
        (e) => { if (!this.destroyed) this._fail(e); });
    return this;
  }
  _data(b64) { if (!this.destroyed) this.emit('data', Buffer.from(fromB64(b64))); }
  _closed(error) {
    if (this.destroyed) return;
    if (error) this.emit('error', new Error(error));
    this.destroyed = true; sockets.delete(this.sid); clearTimeout(this.timer);
    this.emit('close');
  }
  _fail(e) {
    this.emit('error', e instanceof Error ? e : new Error((e && e.message) || String(e)));
    this.destroy();
  }
  write(data) {
    if (this.destroyed) return false;
    const u = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    Promise.resolve().then(() => native.tcpWrite({ sid: this.sid, b64: toB64(u) })).catch((e) => this._fail(e));
    return true;
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true; sockets.delete(this.sid); clearTimeout(this.timer);
    if (err) this.emit('error', err);
    Promise.resolve().then(() => native.tcpClose({ sid: this.sid })).catch(() => {});
    this.emit('close');
    return this;
  }
  end() { return this.destroy(); }
}

function connect(opts) { const s = new Socket(); s.connect(opts.host, opts.port); return s; }

module.exports = { connect, setNative, Socket };
