'use strict';
// O Electron usa BoringSSL, que NÃO traz os grupos Diffie-Hellman Oakley 1 (768 bits) e 2 (1024 bits).
// O ssh2 pede o grupo 'modp2' para o algoritmo diffie-hellman-group1-sha1 (usado por switches/CPEs antigos)
// e falha com "Unknown DH group". Aqui fornecemos os primos oficiais (RFC 2409, seções 6.1 e 6.2)
// quando a biblioteca não os tem. Precisa ser instalado ANTES do primeiro require('ssh2').
const GROUPS = {
  modp1: 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff',
  modp2: 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff',
};

function install(cryptoMod = require('crypto')) {
  if (cryptoMod.__termDhPatched) return;
  const orig = cryptoMod.createDiffieHellmanGroup || cryptoMod.getDiffieHellman;
  const patched = function createDiffieHellmanGroup(name) {
    try {
      return orig.call(cryptoMod, name);
    } catch (e) {
      const hex = GROUPS[name];
      if (!hex) throw e;
      return cryptoMod.createDiffieHellman(Buffer.from(hex, 'hex'), 2);
    }
  };
  cryptoMod.createDiffieHellmanGroup = patched;
  cryptoMod.getDiffieHellman = patched;
  Object.defineProperty(cryptoMod, '__termDhPatched', { value: true });
}

module.exports = { install, GROUPS };
