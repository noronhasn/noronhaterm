'use strict';
// Backup automático do cofre para uma pasta qualquer (ex.: a pasta do Google Drive para computador, OneDrive,
// Dropbox ou um pendrive). Copia os arquivos .vault JÁ CRIPTOGRAFADOS; sem a senha mestra ninguém os abre.
const fs = require('fs');
const path = require('path');
const { Vault } = require('../core/vault');

const DEFAULTS = { enabled: false, folder: '', intervalMinutes: 360, keep: 20, lastAt: null, lastError: null, lastFiles: 0 };
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 60 * 24 * 30; // 30 dias

function sanitize(c = {}) {
  const num = (v, min, max, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  return {
    enabled: !!c.enabled,
    folder: typeof c.folder === 'string' ? c.folder.trim() : '',
    intervalMinutes: num(c.intervalMinutes, MIN_INTERVAL, MAX_INTERVAL, DEFAULTS.intervalMinutes),
    keep: num(c.keep, 1, 500, DEFAULTS.keep),
    lastAt: typeof c.lastAt === 'string' ? c.lastAt : null,
    lastError: typeof c.lastError === 'string' ? c.lastError : null,
    lastFiles: num(c.lastFiles, 0, 100000, 0),
  };
}

function loadConfig(file) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return sanitize(DEFAULTS); }
}

function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sanitize(cfg), null, 2));
  fs.renameSync(tmp, file);
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkFolder(folder, vaultDir) {
  if (!folder) throw new Error('Escolha a pasta de destino do backup');
  let st;
  try { st = fs.statSync(folder); } catch { throw new Error('A pasta de destino não existe: ' + folder); }
  if (!st.isDirectory()) throw new Error('O destino não é uma pasta: ' + folder);
  const a = path.resolve(folder).toLowerCase();
  const b = path.resolve(vaultDir).toLowerCase();
  if (a === b || a.startsWith(b + path.sep)) throw new Error('Escolha uma pasta diferente da pasta do cofre');
  fs.accessSync(folder, fs.constants.W_OK);
}

// Copia cada <usuario>.vault para <pasta>/<usuario>-AAAAMMDD-HHMMSS.vault e mantém só os N mais recentes de cada usuário.
function runBackup({ vaultDir, folder, keep = 20, now = new Date() }) {
  checkFolder(folder, vaultDir);
  const vaults = fs.existsSync(vaultDir) ? fs.readdirSync(vaultDir).filter((f) => f.endsWith('.vault')) : [];
  if (!vaults.length) throw new Error('Não há nenhum cofre para copiar');
  const copied = [];
  let removed = 0;
  for (const f of vaults) {
    const user = f.slice(0, -'.vault'.length);
    const name = `${user}-${stamp(now)}.vault`;
    const dest = path.join(folder, name);
    const tmp = dest + '.partial'; // serviços de nuvem só enxergam o arquivo completo
    fs.copyFileSync(path.join(vaultDir, f), tmp);
    fs.renameSync(tmp, dest);
    copied.push(name);
    const re = new RegExp('^' + escapeRe(user) + '-\\d{8}-\\d{6}\\.vault$');
    const mine = fs.readdirSync(folder).filter((x) => re.test(x)).sort(); // data no nome: ordem alfabética = cronológica
    for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
      try { fs.unlinkSync(path.join(folder, old)); removed++; } catch { /* ignora */ }
    }
  }
  return { files: copied, removed, at: now.toISOString() };
}

// Restaura um backup (.vault) no lugar do cofre `dest`. Antes de trocar, confere se o arquivo abre com a senha
// informada e guarda o cofre atual como <dest>.antes-AAAAMMDD-HHMMSS. Devolve o caminho dessa cópia (ou null).
function restoreVault({ src, dest, password, now = new Date() }) {
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('Arquivo de backup não encontrado');
  const tmp = dest + '.restaurando';
  fs.copyFileSync(src, tmp);
  try {
    Vault.open(tmp, password).lock(); // senha errada / arquivo inválido lança erro aqui, antes de mexer no cofre atual
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  let saved = null;
  if (fs.existsSync(dest)) { saved = `${dest}.antes-${stamp(now)}`; fs.renameSync(dest, saved); }
  fs.renameSync(tmp, dest);
  return saved;
}

class BackupScheduler {
  constructor({ configFile, vaultDir, onChange = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    this.configFile = configFile;
    this.vaultDir = vaultDir;
    this.onChange = onChange;
    this._set = setIntervalFn;
    this._clear = clearIntervalFn;
    this.timer = null;
    this.cfg = loadConfig(configFile);
  }

  get() { return { ...this.cfg, running: !!this.timer }; }

  start() {
    this.stop();
    if (!this.cfg.enabled || !this.cfg.folder) return;
    this.timer = this._set(() => { try { this.runNow(); } catch { /* erro já registrado */ } }, this.cfg.intervalMinutes * 60 * 1000);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { this._clear(this.timer); this.timer = null; } }

  set(patch) {
    const next = sanitize({ ...this.cfg, ...patch });
    if (next.enabled) checkFolder(next.folder, this.vaultDir); // não deixa ligar com destino inválido
    this.cfg = next;
    saveConfig(this.configFile, this.cfg);
    this.start();
    return this.get();
  }

  runNow(now = new Date()) {
    try {
      const r = runBackup({ vaultDir: this.vaultDir, folder: this.cfg.folder, keep: this.cfg.keep, now });
      this.cfg = sanitize({ ...this.cfg, lastAt: r.at, lastError: null, lastFiles: r.files.length });
      saveConfig(this.configFile, this.cfg);
      this.onChange(this.get());
      return r;
    } catch (e) {
      this.cfg = sanitize({ ...this.cfg, lastError: e.message });
      try { saveConfig(this.configFile, this.cfg); } catch { /* ignora */ }
      this.onChange(this.get());
      throw e;
    }
  }
}

module.exports = { restoreVault, BackupScheduler, runBackup, loadConfig, saveConfig, sanitize, checkFolder, stamp };
