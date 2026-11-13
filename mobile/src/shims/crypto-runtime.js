'use strict';
// "crypto" no app: scrypt e AES-GCM em JavaScript puro (@noble), sorteio pelo WebCrypto do próprio WebView.
const { scrypt } = require('@noble/hashes/scrypt');
const { gcm } = require('@noble/ciphers/aes');
const { createCryptoShim } = require('./crypto');

module.exports = createCryptoShim({
  randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  scrypt: (pw, salt, { N, r, p, dkLen }) => scrypt(pw, salt, { N, r, p, dkLen, maxmem: 1 << 30 }),
  gcmEncrypt: (key, iv, aad, pt) => gcm(key, iv, aad).encrypt(pt),
  gcmDecrypt: (key, iv, aad, ct) => gcm(key, iv, aad).decrypt(ct),
});
