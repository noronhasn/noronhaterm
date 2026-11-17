'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isNewer, checkUpdate } = require('../src/main/updater');

test('atualização: compara versões', () => {
  assert.equal(isNewer('v0.4.19', '0.4.18'), true);
  assert.equal(isNewer('0.5.0', '0.4.99'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.4.18', '0.4.18'), false);
  assert.equal(isNewer('0.4.9', '0.4.10'), false); // 9 < 10, não é comparação de texto
  assert.equal(isNewer('abc', '0.4.1'), false);
});

test('atualização: avisa só quando há versão mais nova e nunca estoura erro', async () => {
  const mk = (obj, ok = true) => async () => ({ ok, json: async () => obj });
  const nova = await checkUpdate({ current: '0.4.18', repo: 'a/b', fetchFn: mk({ tag_name: 'v0.4.19', body: 'novidades', html_url: 'https://github.com/a/b/releases/tag/v0.4.19' }) });
  assert.deepEqual(nova, { available: true, version: '0.4.19', notes: 'novidades', url: 'https://github.com/a/b/releases/tag/v0.4.19' });
  assert.equal((await checkUpdate({ current: '0.4.19', repo: 'a/b', fetchFn: mk({ tag_name: 'v0.4.19' }) })).available, false);
  assert.equal((await checkUpdate({ current: '0.4.18', repo: 'a/b', fetchFn: mk({}, false) })).available, false); // repositório privado: 404
  assert.equal((await checkUpdate({ current: '0.4.18', repo: 'a/b', fetchFn: async () => { throw new Error('sem internet'); } })).available, false);
});

test('novidades: changelog válido, em ordem, e a versão atual está nele', () => {
  const root = path.join(__dirname, '..');
  const log = JSON.parse(fs.readFileSync(path.join(root, 'src', 'changelog.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(log[0].version, pkg.version, 'a primeira entrada do changelog tem de ser a versão do package.json');
  for (let i = 0; i < log.length; i++) {
    assert.match(log[i].version, /^\d+\.\d+\.\d+$/);
    assert.ok(Array.isArray(log[i].itens) && log[i].itens.length > 0 && log[i].itens.every((x) => typeof x === 'string' && x.length > 5));
    if (i > 0) assert.equal(isNewer(log[i - 1].version, log[i].version), true, 'em ordem da mais nova para a mais antiga');
  }
});

test('novidades: texto da página de downloads vem do changelog', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release-notes.js')]).toString();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(out, new RegExp('## NetDeck ' + pkg.version.replace(/\./g, '\\.')));
  assert.match(out, /Terminal local/);
});
