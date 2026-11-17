'use strict';
// Log de sessão: grava em arquivo de texto tudo o que aparece no terminal (sem códigos de cor/controle),
// um arquivo por conexão, com o nome do host e a data no nome. Serve para documentar o que foi feito.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const DEFAULTS = { enabled: false, folder: '', timestamps: false };

function sanitize(c = {}) {
  return {
    enabled: !!c.enabled,
    folder: typeof c.folder === 'string' ? c.folder.trim() : '',
    timestamps: !!c.timestamps,
  };
}
function loadConfig(file) { try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return sanitize(DEFAULTS); } }
function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sanitize(cfg), null, 2));
  fs.renameSync(tmp, file);
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const safeName = (s) => String(s || 'sessao').replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || 'sessao';

// Tira sequências de escape (cores, cursor, títulos) e trata \r e backspace como o terminal faria na linha.
class Cleaner {
  constructor() { this.state = 'text'; this.line = []; this.dec = new StringDecoder('utf8'); }

  // devolve as linhas COMPLETAS (sem \n) contidas neste pedaço; o que sobra fica guardado
  feed(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.dec.write(Buffer.from(chunk));
    const out = [];
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (this.state === 'esc') {
        if (ch === '[') this.state = 'csi';
        else if (ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X') this.state = 'str';
        else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#') this.state = 'skip1';
        else this.state = 'text';
        continue;
      }
      if (this.state === 'csi') { if (c >= 0x40 && c <= 0x7e) this.state = 'text'; continue; }
      if (this.state === 'str') { if (c === 7) this.state = 'text'; else if (c === 0x1b) this.state = 'strEsc'; continue; }
      if (this.state === 'strEsc') { this.state = ch === '\\' ? 'text' : 'str'; continue; }
      if (this.state === 'skip1') { this.state = 'text'; continue; }
      if (c === 0x1b) { this.state = 'esc'; continue; }
      if (ch === '\n') { out.push(this.line.join('').replace(/\s+$/, '')); this.line = []; continue; }
      if (ch === '\r') { this.cr = true; continue; }
      if (this.cr) { this.cr = false; this.line = []; } // \r sozinho: o texto seguinte sobrescreve a linha
      if (c === 8 || c === 0x7f) { this.line.pop(); continue; }
      if (c < 32 && ch !== '\t') continue; // outros controles (bell etc.)
      this.line.push(ch);
    }
    return out;
  }

  rest() { const r = this.line.join('').replace(/\s+$/, ''); this.line = []; return r; }
}

class SessionLog {
  constructor({ file, header, timestamps, now = () => new Date() }) {
    this.file = file; this.timestamps = timestamps; this.now = now;
    this.clean = new Cleaner();
    this.fd = fs.openSync(file, 'a', 0o600);
    this.error = null;
    this._write(header + '\n');
  }

  _write(s) {
    if (this.fd == null) return;
    try { fs.writeSync(this.fd, s); } catch (e) { this.error = e.message; this.close(); }
  }

  write(chunk) {
    if (this.fd == null) return;
    const lines = this.clean.feed(chunk);
    if (!lines.length) return;
    const t = this.timestamps ? `[${clock(this.now())}] ` : '';
    this._write(lines.map((l) => t + l).join('\n') + '\n');
  }

  close(reason) {
    if (this.fd == null) return;
    const left = this.clean.rest();
    const t = this.timestamps ? `[${clock(this.now())}] ` : '';
    if (left) this._write(t + left + '\n');
    this._write(`# sessão encerrada em ${this.now().toISOString()}${reason ? ' — ' + reason : ''}\n`);
    try { fs.closeSync(this.fd); } catch { /* ignora */ }
    this.fd = null;
  }
}

class SessionLogger {
  constructor({ configFile, defaultFolder }) {
    this.configFile = configFile; this.defaultFolder = defaultFolder;
    this.cfg = loadConfig(configFile);
  }
  folder() { return this.cfg.folder || this.defaultFolder; }
  get() { return { ...this.cfg, folder: this.cfg.folder, effectiveFolder: this.folder() }; }
  set(patch) {
    const next = sanitize({ ...this.cfg, ...patch });
    if (next.folder) {
      let st; try { st = fs.statSync(next.folder); } catch { throw new Error('A pasta não existe: ' + next.folder); }
      if (!st.isDirectory()) throw new Error('O destino não é uma pasta: ' + next.folder);
    }
    this.cfg = next; saveConfig(this.configFile, next);
    return this.get();
  }
  // abre o log de uma conexão (ou devolve null se estiver desligado ou se não for possível gravar)
  open({ name, address, protocol }, now = new Date()) {
    if (!this.cfg.enabled) return null;
    try {
      const dir = this.folder();
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, `${safeName(name)}_${stamp(now)}.log`);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safeName(name)}_${stamp(now)}_${i}.log`);
      const header = `# NetDeck — sessão com ${name}${address ? ' (' + address + ')' : ''} [${protocol}] iniciada em ${now.toISOString()}`;
      return new SessionLog({ file, header, timestamps: this.cfg.timestamps });
    } catch { return null; }
  }
}

module.exports = { SessionLogger, SessionLog, Cleaner, sanitize, safeName };
