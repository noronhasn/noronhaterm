'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalShellSession, pickShell } = require('../src/main/localshell');

test('terminal local: escolhe o shell de cada sistema', () => {
  assert.deepEqual(pickShell('win32', {}, () => true), { cmd: 'powershell.exe', args: ['-NoLogo'] });
  assert.equal(pickShell('win32', { COMSPEC: 'C:\\Windows\\cmd.exe' }, () => false).cmd, 'C:\\Windows\\cmd.exe');
  assert.equal(pickShell('linux', { SHELL: '/usr/bin/fish' }).cmd, '/usr/bin/fish');
  assert.equal(pickShell('linux', {}).cmd, '/bin/bash');
  assert.equal(pickShell('darwin', {}).cmd, '/bin/zsh');
  assert.equal(pickShell('linux', { SHELL: '/bin/bash; rm -rf /' }).cmd, '/bin/bash'); // valor estranho não vira comando
});

test('terminal local: com pty, repassa dados, entrada, tamanho e encerramento', async () => {
  const log = { spawned: null, written: [], resized: null, killed: false };
  let dataCb; let exitCb;
  const fakePty = { spawn: (cmd, args, opts) => { log.spawned = { cmd, args, opts }; return {
    onData: (f) => { dataCb = f; }, onExit: (f) => { exitCb = f; },
    write: (d) => log.written.push(d), resize: (c, r) => { log.resized = [c, r]; }, kill: () => { log.killed = true; },
  }; } };
  const out = []; let closed = null; const st = [];
  const s = new LocalShellSession({ host: {}, cols: 100, rows: 30, ptyLib: fakePty, shell: { cmd: '/bin/sh', args: [] }, onData: (d) => out.push(d), onClose: (r) => { closed = r; }, onStatus: (m) => st.push(m) });
  await s.start();
  assert.equal(log.spawned.cmd, '/bin/sh');
  assert.equal(log.spawned.opts.cols, 100);
  assert.equal(log.spawned.opts.name, 'xterm-256color');
  dataCb('olá\r\n');
  assert.deepEqual(out, ['olá\r\n']);
  s.write('ls\r');
  assert.deepEqual(log.written, ['ls\r']);
  s.resize(120, 40);
  assert.deepEqual(log.resized, [120, 40]);
  exitCb({ exitCode: 0 });
  assert.match(closed, /encerrado/);
  s.close();
  assert.equal(log.killed, true);
});

test('terminal local: sem pty no Linux usa script e roda comandos de verdade', { skip: process.platform === 'win32' }, async () => {
  const out = []; let closed = null;
  const s = new LocalShellSession({ host: {}, cols: 80, rows: 24, ptyLib: null, shell: { cmd: '/bin/sh', args: [] }, onData: (d) => out.push(d), onClose: (r) => { closed = r; }, onStatus: () => {} });
  try { await s.start(); } catch (e) { if (/script/.test(e.message)) return; throw e; }
  s.write('echo teste-$((20+22))\n');
  await new Promise((r) => setTimeout(r, 700));
  s.write('exit\n');
  await new Promise((r) => setTimeout(r, 500));
  assert.match(out.join(''), /teste-42/);
  assert.match(String(closed), /encerrado/);
});
