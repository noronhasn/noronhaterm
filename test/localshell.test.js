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

const { listShells } = require('../src/main/localshell');

test('terminal local: no Windows lista PowerShell, CMD, WSL (e cada distribuição) e Git Bash', () => {
  const wslOut = 'Ubuntu-22.04\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\n'.split('').join('\0'); // o wsl responde em UTF-16
  const l = listShells({
    platform: 'win32', env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    have: (c) => c === 'wsl.exe' || c === 'pwsh.exe',
    exists: (f) => f === 'C:\\Program Files\\Git\\bin\\bash.exe',
    run: () => wslOut,
  });
  assert.deepEqual(l.map((x) => x.id), ['powershell', 'pwsh', 'cmd', 'wsl', 'wsl:Ubuntu-22.04', 'wsl:Debian', 'gitbash']);
  assert.deepEqual(l.find((x) => x.id === 'wsl:Debian').args, ['-d', 'Debian', '--cd', '~']);
  assert.equal(l.find((x) => x.id === 'wsl').cmd, 'wsl.exe');
});

test('terminal local: sem WSL instalado não aparece; no Linux lista só os shells que existem', () => {
  const l = listShells({ platform: 'win32', env: {}, have: () => false, exists: () => false });
  assert.deepEqual(l.map((x) => x.id), ['powershell', 'cmd']);
  const u = listShells({ platform: 'linux', env: { SHELL: '/usr/bin/zsh' }, exists: (f) => ['/usr/bin/zsh', '/bin/bash', '/bin/sh'].includes(f) });
  assert.deepEqual(u.map((x) => x.id), ['/usr/bin/zsh', '/bin/bash', '/bin/sh']);
  assert.equal(listShells({ platform: 'linux', env: { SHELL: '/bin/bash; rm -rf /' }, exists: () => true }).some((x) => /rm/.test(x.cmd)), false);
});
