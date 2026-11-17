'use strict';
// Terminal local: abre o shell do próprio computador numa aba (PowerShell no Windows, bash/zsh no Linux e Mac).
// Usa node-pty (pseudo-terminal de verdade: cores, vim, top, setas). Se o módulo não estiver na instalação,
// no Linux/Mac cai para o comando `script`; no Windows avisa o que fazer.
const os = require('os');
const { spawn, spawnSync } = require('child_process');

function loadPty() {
  for (const name of ['@lydell/node-pty', 'node-pty']) {
    try { return require(name); } catch { /* tenta o próximo */ }
  }
  return null;
}

function pickShell(platform = process.platform, env = process.env, have = () => true) {
  if (platform === 'win32') {
    const ps = have('powershell.exe') ? 'powershell.exe' : null;
    return ps ? { cmd: ps, args: ['-NoLogo'] } : { cmd: env.COMSPEC || 'cmd.exe', args: [] };
  }
  const sh = env.SHELL && /^\/[\w/.+-]+$/.test(env.SHELL) ? env.SHELL : (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { cmd: sh, args: [] };
}

class LocalShellSession {
  constructor({ host, cols, rows, onData, onClose, onStatus, ptyLib, shell }) {
    this.cols = cols || 80; this.rows = rows || 24;
    this.onData = onData; this.onClose = onClose; this.onStatus = onStatus;
    this.pty = ptyLib === undefined ? loadPty() : ptyLib;
    this.shell = shell || pickShell(process.platform, process.env, (c) => { try { return spawnSync('where', [c], { stdio: 'ignore', windowsHide: true }).status === 0; } catch { return false; } });
    this.host = host;
  }

  async start() {
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const cwd = os.homedir();
    if (this.pty) {
      this.p = this.pty.spawn(this.shell.cmd, this.shell.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env });
      this.p.onData((d) => this.onData(d));
      this.p.onExit(() => { if (!this.closed) { this.closed = true; this.onClose('Terminal local encerrado'); } });
      this.onStatus('Terminal local: ' + this.shell.cmd);
      return;
    }
    if (process.platform === 'win32') throw new Error('O terminal local precisa do módulo node-pty, que não veio nesta instalação. Reinstale o NetDeck (versão completa).');
    // sem node-pty: `script` cria o pseudo-terminal (sem ajuste de tamanho da janela)
    const hasScript = spawnSync('which', ['script'], { stdio: 'ignore' }).status === 0;
    if (!hasScript) throw new Error('Terminal local indisponível: falta o módulo node-pty e o comando "script".');
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', this.shell.cmd] : ['-qfc', this.shell.cmd, '/dev/null'];
    this.child = spawn('script', args, { cwd, env: { ...env, COLUMNS: String(this.cols), LINES: String(this.rows) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.onData(d.toString('utf8')));
    this.child.stderr.on('data', (d) => this.onData(d.toString('utf8')));
    this.child.on('close', () => { if (!this.closed) { this.closed = true; this.onClose('Terminal local encerrado'); } });
    await new Promise((res, rej) => { this.child.once('spawn', res); this.child.once('error', rej); });
    this.onStatus('Terminal local (modo simples): ' + this.shell.cmd);
  }

  write(d) { if (this.p) this.p.write(d); else if (this.child && this.child.stdin.writable) this.child.stdin.write(d); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; if (this.p) { try { this.p.resize(Math.max(2, cols), Math.max(1, rows)); } catch { /* ignora */ } } }
  close() { this.closed = true; try { if (this.p) this.p.kill(); if (this.child) this.child.kill(); } catch { /* ignora */ } }
}

module.exports = { LocalShellSession, pickShell, loadPty };
