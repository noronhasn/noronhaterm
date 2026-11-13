'use strict';
// Cofre criptografado: senha mestra -> scrypt -> AES-256-GCM.
// O arquivo em disco contém apenas o blob cifrado + parâmetros públicos do KDF.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT = 'termvault/1';
const KDF_DEFAULT = { N: 1 << 15, r: 8, p: 1 };
const KDF_MAX_N = 1 << 20; // evita DoS por arquivo malicioso

class VaultError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function deriveKey(password, salt, kdf) {
  return crypto.scryptSync(String(password).normalize('NFKC'), salt, 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024,
  });
}

function aadFor(kdf, salt) {
  return Buffer.from(JSON.stringify({ f: FORMAT, kdf: [kdf.N, kdf.r, kdf.p], salt: salt.toString('hex') }));
}

class Vault {
  constructor(file, key, salt, kdf, data) {
    this.file = file;
    this._key = key;
    this._salt = salt;
    this._kdf = kdf;
    this.data = data;
  }

  static exists(file) { return fs.existsSync(file); }

  static create(file, password, data = {}, kdf = KDF_DEFAULT) {
    if (!password || String(password).length < 8) {
      throw new VaultError('A senha mestra precisa ter pelo menos 8 caracteres', 'WEAK_PASSWORD');
    }
    if (fs.existsSync(file)) throw new VaultError('Já existe um cofre com esse nome', 'EXISTS');
    const salt = crypto.randomBytes(16);
    const key = deriveKey(password, salt, kdf);
    const v = new Vault(file, key, salt, { ...kdf }, data);
    v.save();
    return v;
  }

  static open(file, password) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new VaultError('Arquivo de cofre ilegível', 'CORRUPT'); }
    if (doc.format !== FORMAT) throw new VaultError('Formato de cofre desconhecido', 'CORRUPT');
    const kdf = doc.kdf;
    if (!kdf || !Number.isInteger(kdf.N) || kdf.N < 1024 || kdf.N > KDF_MAX_N || (kdf.N & (kdf.N - 1))) {
      throw new VaultError('Parâmetros do cofre inválidos', 'CORRUPT');
    }
    const salt = Buffer.from(doc.salt, 'base64');
    const key = deriveKey(password, salt, kdf);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
      d.setAAD(aadFor(kdf, salt));
      d.setAuthTag(Buffer.from(doc.tag, 'base64'));
      const pt = Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]);
      return new Vault(file, key, salt, kdf, JSON.parse(pt.toString('utf8')));
    } catch {
      key.fill(0);
      throw new VaultError('Senha mestra incorreta ou cofre corrompido', 'BAD_PASSWORD');
    }
  }

  get locked() { return !this._key; }

  save() {
    if (this.locked) throw new VaultError('Cofre bloqueado', 'LOCKED');
    const iv = crypto.randomBytes(12); // IV novo a cada gravação
    const c = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    c.setAAD(aadFor(this._kdf, this._salt));
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(this.data), 'utf8')), c.final()]);
    const doc = {
      format: FORMAT,
      kdf: this._kdf,
      salt: this._salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: ct.toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // gravação atômica
  }

  changePassword(newPassword) {
    if (!newPassword || String(newPassword).length < 8) {
      throw new VaultError('A senha mestra precisa ter pelo menos 8 caracteres', 'WEAK_PASSWORD');
    }
    const salt = crypto.randomBytes(16);
    const key = deriveKey(newPassword, salt, this._kdf);
    this._key.fill(0);
    this._key = key;
    this._salt = salt;
    this.save();
  }

  lock() {
    if (this._key) this._key.fill(0);
    this._key = null;
    this.data = null;
  }
}

module.exports = { Vault, VaultError, KDF_DEFAULT };
