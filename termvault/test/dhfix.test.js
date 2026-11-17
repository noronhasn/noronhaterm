'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { install, GROUPS } = require('../src/main/dhfix');

// Simula o Electron/BoringSSL: copia do crypto, mas os grupos Oakley antigos não existem.
function electronLikeCrypto() {
  const fake = Object.create(crypto);
  const native = crypto.createDiffieHellmanGroup.bind(crypto);
  fake.createDiffieHellmanGroup = (n) => { if (n === 'modp1' || n === 'modp2') throw new Error('Unknown DH group'); return native(n); };
  fake.getDiffieHellman = fake.createDiffieHellmanGroup;
  return fake;
}

test('dhfix: os primos embutidos são exatamente os grupos Oakley nativos do Node', () => {
  assert.equal(GROUPS.modp1, crypto.getDiffieHellman('modp1').getPrime('hex'));
  assert.equal(GROUPS.modp2, crypto.getDiffieHellman('modp2').getPrime('hex'));
  assert.equal(GROUPS.modp2.length * 4, 1024);
});

test('dhfix: os primos são primos seguros (p e (p-1)/2 primos)', () => {
  for (const hex of Object.values(GROUPS)) {
    const p = BigInt('0x' + hex);
    assert.ok(crypto.checkPrimeSync(p));
    assert.ok(crypto.checkPrimeSync((p - 1n) / 2n));
  }
});

test('dhfix: sem o patch o ambiente "Electron" falha; com o patch o modp2 funciona', () => {
  const fake = electronLikeCrypto();
  assert.throws(() => fake.createDiffieHellmanGroup('modp2'), /Unknown DH group/);
  install(fake);
  assert.doesNotThrow(() => fake.createDiffieHellmanGroup('modp2'));
  assert.doesNotThrow(() => fake.getDiffieHellman('modp2'));
});

test('dhfix: troca de chaves DH group1 entre dois lados chega ao mesmo segredo', () => {
  const fake = electronLikeCrypto();
  install(fake);
  const a = fake.createDiffieHellmanGroup('modp2');
  const b = fake.createDiffieHellmanGroup('modp2');
  const pa = a.generateKeys();
  const pb = b.generateKeys();
  assert.deepEqual(a.computeSecret(pb), b.computeSecret(pa));
  assert.equal(a.getPrime('hex'), GROUPS.modp2);
});

test('dhfix: grupos que a biblioteca já tem seguem intactos e nomes desconhecidos ainda dão erro', () => {
  const fake = electronLikeCrypto();
  install(fake);
  assert.equal(fake.createDiffieHellmanGroup('modp14').getPrime('hex').length * 4, 2048);
  assert.throws(() => fake.createDiffieHellmanGroup('naoexiste'));
  install(fake); // instalar duas vezes não empilha o patch
  assert.doesNotThrow(() => fake.createDiffieHellmanGroup('modp2'));
});
