'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/main/rdp');

const host = { address: '10.0.0.5', port: 3389, identity: { username: 'admin', password: 'Segredo!1' } };

test('rdp windows: mstsc + credencial temporária, senha fora da linha de comando', () => {
  const p = plan(host, 'win32');
  assert.equal(p.cmd, 'mstsc');
  assert.deepEqual(p.args, ['/v:10.0.0.5:3389']);
  assert.deepEqual(p.cred, { target: 'TERMSRV/10.0.0.5', user: 'admin', pass: 'Segredo!1' });
  assert.ok(!JSON.stringify(p.args).includes('Segredo'));
  assert.equal(plan({ address: 'pc1' }, 'win32').cred, null);
});

test('rdp linux: xfreerdp recebe a senha por stdin, não pelos argumentos', () => {
  const p = plan(host, 'linux', (c) => c === 'xfreerdp3');
  assert.equal(p.cmd, 'xfreerdp3');
  assert.deepEqual(p.args, ['/args-from:stdin']);
  assert.ok(p.stdin.includes('/p:Segredo!1') && p.stdin.includes('/v:10.0.0.5:3389'));
  const q = plan({ address: 'pc1', port: 3390 }, 'linux', (c) => c === 'xfreerdp');
  assert.ok(q.args.includes('/v:pc1:3390') && q.stdin === null);
});

test('rdp linux: usa remmina se não há freerdp; sem nenhum, explica o que instalar', () => {
  assert.equal(plan(host, 'linux', (c) => c === 'remmina').cmd, 'remmina');
  assert.throws(() => plan(host, 'linux', () => false), /sudo apt install/);
});

test('rdp: endereço com lixo/opções é recusado', () => {
  for (const a of ['', '10.0.0.1 /admin', '-v:x', 'a;b', undefined]) assert.throws(() => plan({ address: a }, 'win32'), /inválido/);
});
