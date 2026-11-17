'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionLogger, Cleaner, safeName } = require('../src/main/sessionlog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nt-log-'));

test('log: limpa cores, títulos, backspace e \\r; junta pedaços partidos', () => {
  const c = new Cleaner();
  assert.deepEqual(c.feed('\x1b[1;32molá\x1b[0m mundo\r\nlinha2 \x1b]0;tit'), ['olá mundo']);
  assert.deepEqual(c.feed('ulo\x07abc\x08X\r\n'), ['linha2 abX']);
  assert.deepEqual(c.feed(Buffer.from('<SW>disp')), []);
  assert.equal(c.rest(), '<SW>disp');
  const d = new Cleaner();
  const acentos = Buffer.from('configuração\n');
  assert.deepEqual([...d.feed(acentos.subarray(0, 10)), ...d.feed(acentos.subarray(10))], ['configuração'], 'UTF-8 partido no meio do caractere');
  assert.deepEqual(new Cleaner().feed('progresso 10%\rprogresso 100%\n'), ['progresso 100%']);
});

test('log: desligado não cria arquivo; ligado grava cabeçalho, linhas e fim', () => {
  const base = tmp();
  const lg = new SessionLogger({ configFile: path.join(base, 'l.json'), defaultFolder: path.join(base, 'padrao') });
  assert.equal(lg.open({ name: 'SW 1', address: '10.0.0.1', protocol: 'ssh' }), null);
  assert.ok(!fs.existsSync(path.join(base, 'padrao')));

  lg.set({ enabled: true, folder: base });
  const l = lg.open({ name: 'CPESW_REDEVIDA/SRR', address: '10.0.0.1', protocol: 'ssh' }, new Date(2026, 10, 13, 16, 20, 0));
  assert.match(path.basename(l.file), /^CPESW_REDEVIDA_SRR_20261113-162000\.log$/);
  l.write('SW#show version\r\n');
  l.write('\x1b[31mErro\x1b[0m: nada\r\nSW#');
  l.close('fechada pelo usuário');
  const txt = fs.readFileSync(l.file, 'utf8');
  assert.match(txt, /^# NetDeck — sessão com CPESW_REDEVIDA\/SRR \(10\.0\.0\.1\) \[ssh\] iniciada em /);
  assert.match(txt, /SW#show version\nErro: nada\nSW#\n/);
  assert.match(txt, /# sessão encerrada em .* — fechada pelo usuário\n$/);
  l.write('depois de fechar'); // não quebra
  assert.ok(!fs.readFileSync(l.file, 'utf8').includes('depois de fechar'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(l.file).mode & 0o077, 0, 'só o dono lê o log');
});

test('log: hora em cada linha, nomes repetidos e pasta inválida', () => {
  const base = tmp();
  const lg = new SessionLogger({ configFile: path.join(base, 'l.json'), defaultFolder: base });
  assert.throws(() => lg.set({ folder: path.join(base, 'nada') }), /não existe/);
  lg.set({ enabled: true, timestamps: true });
  const t = new Date(2026, 10, 13, 9, 5, 7);
  const a = lg.open({ name: 'h', protocol: 'telnet' }, t);
  const b = lg.open({ name: 'h', protocol: 'telnet' }, t);
  assert.notEqual(a.file, b.file, 'dois logs no mesmo segundo não se misturam');
  a.now = () => t; a.write('linha\n'); a.close();
  assert.match(fs.readFileSync(a.file, 'utf8'), /\[09:05:07\] linha\n/);
  b.close();
  const again = new SessionLogger({ configFile: path.join(base, 'l.json'), defaultFolder: base });
  assert.equal(again.get().timestamps, true, 'configuração persiste');
  assert.equal(safeName('../../x y'), 'x_y');
});
