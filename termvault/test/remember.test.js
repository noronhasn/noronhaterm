'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Remember } = require('../src/main/remember');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rm-')), 'remember.json');
const rev = (b) => Buffer.from([...Buffer.from(b)].reverse()); // "cifra" de mentira
const mk = (f) => new Remember({ file: f, enc: (t) => rev(t), dec: (b) => rev(b).toString() });

test('lembrar: guarda cifrado, devolve a senha e esquece', () => {
  const f = file();
  const r = mk(f);
  assert.equal(r.last(), null);
  r.set('noronha', 'senha-secreta-1');
  assert.ok(!fs.readFileSync(f, 'utf8').includes('senha-secreta-1'), 'não pode ficar em texto puro');
  assert.equal(r.has('noronha'), true);
  assert.deepEqual(r.last(), { user: 'noronha', password: 'senha-secreta-1' });
  assert.deepEqual(mk(f).last(), { user: 'noronha', password: 'senha-secreta-1' }); // sobrevive a reinício
  r.forget('noronha');
  assert.equal(r.has('noronha'), false);
  assert.equal(r.last(), null);
});

test('lembrar: arquivo corrompido ou cifra que falha não derruba nada', () => {
  const f = file();
  fs.writeFileSync(f, '{lixo');
  assert.equal(mk(f).last(), null);
  const r = new Remember({ file: f, enc: (t) => Buffer.from(t), dec: () => { throw new Error('x'); } });
  r.set('a', 'b');
  assert.equal(r.last(), null);
});
