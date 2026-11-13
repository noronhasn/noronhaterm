'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BackupScheduler, runBackup, sanitize, stamp } = require('../src/main/backup');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nt-bkp-')); }

function setup() {
  const base = tmp();
  const vaultDir = path.join(base, 'vaults');
  const dest = path.join(base, 'drive');
  fs.mkdirSync(vaultDir); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(vaultDir, 'noronha.vault'), 'cofre-criptografado-1');
  fs.writeFileSync(path.join(vaultDir, 'ana.vault'), 'cofre-ana');
  return { base, vaultDir, dest };
}

test('backup: copia cada cofre com data no nome e sem sobras de .partial', () => {
  const { vaultDir, dest } = setup();
  const r = runBackup({ vaultDir, folder: dest, keep: 5, now: new Date(2026, 10, 13, 22, 30, 5) });
  assert.deepEqual(r.files.sort(), ['ana-20261113-223005.vault', 'noronha-20261113-223005.vault']);
  assert.equal(fs.readFileSync(path.join(dest, 'noronha-20261113-223005.vault'), 'utf8'), 'cofre-criptografado-1');
  assert.ok(!fs.readdirSync(dest).some((f) => f.endsWith('.partial')));
});

test('backup: mantém só os N mais recentes de cada usuário', () => {
  const { vaultDir, dest } = setup();
  for (let i = 0; i < 5; i++) runBackup({ vaultDir, folder: dest, keep: 3, now: new Date(2026, 10, 13, 10, i, 0) });
  const mine = fs.readdirSync(dest).filter((f) => f.startsWith('noronha-')).sort();
  assert.equal(mine.length, 3);
  assert.equal(mine[0], 'noronha-' + stamp(new Date(2026, 10, 13, 10, 2, 0)) + '.vault', 'os mais antigos saíram');
  assert.equal(fs.readdirSync(dest).filter((f) => f.startsWith('ana-')).length, 3, 'cada usuário tem a própria contagem');
});

test('backup: não confunde usuários de nome parecido ao apagar antigos', () => {
  const { vaultDir, dest } = setup();
  fs.writeFileSync(path.join(vaultDir, 'ana-maria.vault'), 'x');
  for (let i = 0; i < 4; i++) runBackup({ vaultDir, folder: dest, keep: 2, now: new Date(2026, 10, 13, 10, i, 0) });
  assert.equal(fs.readdirSync(dest).filter((f) => /^ana-\d{8}-/.test(f)).length, 2);
  assert.equal(fs.readdirSync(dest).filter((f) => f.startsWith('ana-maria-')).length, 2);
});

test('backup: recusa destino inexistente, arquivo, vazio e a própria pasta do cofre', () => {
  const { vaultDir, dest, base } = setup();
  assert.throws(() => runBackup({ vaultDir, folder: '' }), /Escolha a pasta/);
  assert.throws(() => runBackup({ vaultDir, folder: path.join(base, 'nao-existe') }), /não existe/);
  fs.writeFileSync(path.join(base, 'arq.txt'), 'x');
  assert.throws(() => runBackup({ vaultDir, folder: path.join(base, 'arq.txt') }), /não é uma pasta/);
  assert.throws(() => runBackup({ vaultDir, folder: vaultDir }), /diferente da pasta do cofre/);
  assert.ok(dest);
});

test('backup: configuração é saneada (limites de intervalo e quantidade)', () => {
  assert.equal(sanitize({ intervalMinutes: 0 }).intervalMinutes, 1);
  assert.equal(sanitize({ intervalMinutes: 'abc' }).intervalMinutes, 360);
  assert.equal(sanitize({ intervalMinutes: 99999999 }).intervalMinutes, 43200);
  assert.equal(sanitize({ keep: 0 }).keep, 1);
  assert.equal(sanitize({ keep: 9999 }).keep, 500);
  assert.equal(sanitize({ enabled: 1, folder: '  /x  ' }).folder, '/x');
});

test('backup: agendador liga, executa no intervalo escolhido, registra status e desliga', () => {
  const { vaultDir, dest, base } = setup();
  let tick = null; let cleared = 0; let ms = null;
  const sch = new BackupScheduler({
    configFile: path.join(base, 'backup.json'), vaultDir,
    setIntervalFn: (f, m) => { tick = f; ms = m; return { unref() {} }; },
    clearIntervalFn: () => { cleared++; },
  });
  assert.equal(sch.get().enabled, false);
  assert.throws(() => sch.set({ enabled: true, folder: path.join(base, 'nada') }), /não existe/, 'não liga com destino inválido');

  const st = sch.set({ enabled: true, folder: dest, intervalMinutes: 90, keep: 4 });
  assert.equal(st.running, true);
  assert.equal(ms, 90 * 60 * 1000, 'o intervalo escolhido vira milissegundos');
  tick();
  assert.equal(sch.get().lastFiles, 2);
  assert.ok(sch.get().lastAt);
  assert.equal(sch.get().lastError, null);

  // configuração persiste em disco e é relida
  const again = new BackupScheduler({ configFile: path.join(base, 'backup.json'), vaultDir });
  assert.equal(again.get().intervalMinutes, 90);
  assert.equal(again.get().folder, dest);

  sch.set({ enabled: false });
  assert.equal(sch.get().running, false);
  assert.ok(cleared >= 1);
});

test('backup: falha grava o erro no status e relança', () => {
  const { vaultDir, dest, base } = setup();
  const sch = new BackupScheduler({ configFile: path.join(base, 'backup.json'), vaultDir });
  sch.set({ enabled: false, folder: dest });
  fs.rmSync(dest, { recursive: true });
  assert.throws(() => sch.runNow(), /não existe/);
  assert.match(sch.get().lastError, /não existe/);
});
