'use strict';
// "Lembrar neste computador": guarda a senha do cofre cifrada pelo sistema (Windows DPAPI / chaveiro do Linux)
// para o app abrir direto. A cifra é injetada (safeStorage do Electron) para poder testar.
const fs = require('fs');

class Remember {
  constructor({ file, enc, dec }) { this.file = file; this.enc = enc; this.dec = dec; }

  _read() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { last: typeof o.last === 'string' ? o.last : null, users: o.users && typeof o.users === 'object' ? o.users : {} };
    } catch { return { last: null, users: {} }; }
  }

  _write(o) { fs.writeFileSync(this.file, JSON.stringify(o), { mode: 0o600 }); }

  has(user) { return !!this._read().users[user]; }

  set(user, password) {
    const o = this._read();
    o.users[user] = this.enc(String(password)).toString('base64');
    o.last = user;
    this._write(o);
  }

  forget(user) {
    const o = this._read();
    delete o.users[user];
    if (o.last === user) o.last = null;
    this._write(o);
  }

  // usuário lembrado por último e a senha dele, ou null
  last() {
    const o = this._read();
    const u = o.last;
    if (!u || !o.users[u]) return null;
    try { return { user: u, password: this.dec(Buffer.from(o.users[u], 'base64')) }; } catch { return null; }
  }

  // nunca abre sozinho depois de bloqueio manual: só quando o app inicia
  clearLast() { const o = this._read(); if (o.last) { o.last = null; this._write(o); } }
}
module.exports = { Remember };
