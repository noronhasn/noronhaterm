'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { algorithmsFor, explainError } = require('../src/main/ssh');

test('algoritmos antigos: ligados por padrão e só ACRESCENTADOS ao fim', () => {
  for (const hop of [{}, { legacyAlgorithms: true }]) {
    const a = algorithmsFor(hop);
    assert.ok(a.kex.append.includes('diffie-hellman-group1-sha1'));
    assert.ok(a.kex.append.includes('diffie-hellman-group14-sha1'));
    assert.ok(a.serverHostKey.append.includes('ssh-rsa'));
    assert.ok(a.cipher.append.includes('aes128-cbc') && a.cipher.append.includes('3des-cbc'));
    assert.ok(a.hmac.append.includes('hmac-sha1'));
    assert.equal(a.kex.prepend, undefined, 'nunca antes dos modernos');
  }
});

test('algoritmos antigos: desligados quando o host pede false', () => {
  assert.equal(algorithmsFor({ legacyAlgorithms: false }), undefined);
});

test('mensagem de erro orienta quando não há algoritmo em comum', () => {
  assert.match(explainError(new Error('Handshake failed: no matching key exchange algorithm'), { legacyAlgorithms: false }).message, /Permitir algoritmos antigos/);
  assert.match(explainError(new Error('Handshake failed: no matching cipher'), {}).message, /não suporta/);
  const other = new Error('All configured authentication methods failed');
  assert.equal(explainError(other, {}), other);
});
