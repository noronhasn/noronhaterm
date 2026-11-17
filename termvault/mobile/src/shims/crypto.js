'use strict';
// Substitui o módulo "crypto" do Node dentro do app Android (WebView). Implementa só o que o cofre usa:
// randomBytes, randomUUID, scryptSync e AES-256-GCM (createCipheriv/createDecipheriv) com a MESMA semântica do Node,
// para que o arquivo do cofre seja idêntico ao do computador. As primitivas (scrypt, AES-GCM) vêm de fora:
// no app são as bibliotecas @noble; nos testes é o crypto do próprio Node.
//
// prims: { randomBytes(n) -> Uint8Array,
//          scrypt(passwordBytes, salt, {N, r, p, dkLen}) -> Uint8Array,
//          gcmEncrypt(key, iv, aad, plaintext) -> Uint8Array  (texto cifrado + 16 bytes de tag no fim),
//          gcmDecrypt(key, iv, aad, cipherAndTag) -> Uint8Array (lança erro se a tag não conferir) }
function createCryptoShim(prims, B = Buffer) {
  const buf = (u) => B.from(u.buffer, u.byteOffset, u.byteLength);
  const concat = (parts) => B.concat(parts.map((x) => B.from(x)));

  class Cipher {
    constructor(key, iv) { this.key = B.from(key); this.iv = B.from(iv); this.aad = B.alloc(0); this.parts = []; this.tag = null; }
    setAAD(a) { this.aad = B.from(a); return this; }
    update(d) { this.parts.push(B.from(d)); return B.alloc(0); }
    final() {
      const out = prims.gcmEncrypt(this.key, this.iv, this.aad, concat(this.parts));
      const all = buf(out);
      this.tag = all.subarray(all.length - 16);
      return all.subarray(0, all.length - 16);
    }
    getAuthTag() { return this.tag; }
  }

  class Decipher {
    constructor(key, iv) { this.key = B.from(key); this.iv = B.from(iv); this.aad = B.alloc(0); this.parts = []; this.tag = null; }
    setAAD(a) { this.aad = B.from(a); return this; }
    setAuthTag(t) { this.tag = B.from(t); return this; }
    update(d) { this.parts.push(B.from(d)); return B.alloc(0); }
    final() {
      if (!this.tag || this.tag.length !== 16) throw new Error('Tag de autenticação inválida');
      return buf(prims.gcmDecrypt(this.key, this.iv, this.aad, concat([...this.parts, this.tag])));
    }
  }

  const checkAlg = (alg) => { if (alg !== 'aes-256-gcm') throw new Error('Algoritmo não suportado: ' + alg); };
  return {
    randomBytes: (n) => B.from(prims.randomBytes(n)),
    randomUUID() {
      const b = B.from(prims.randomBytes(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.toString('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    scryptSync(password, salt, keylen, opts = {}) {
      return B.from(prims.scrypt(B.from(String(password), 'utf8'), B.from(salt), { N: opts.N || opts.cost || 16384, r: opts.r || opts.blockSize || 8, p: opts.p || opts.parallelization || 1, dkLen: keylen }));
    },
    createCipheriv(alg, key, iv) { checkAlg(alg); return new Cipher(key, iv); },
    createDecipheriv(alg, key, iv) { checkAlg(alg); return new Decipher(key, iv); },
  };
}

module.exports = { createCryptoShim };
