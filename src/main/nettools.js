'use strict';
// Ferramentas de rede (ping, traceroute, MTR) usando os programas que o próprio sistema já tem.
// A saída vai para uma aba de terminal comum; Ctrl+C ou fechar a aba para o programa.
const { spawn, spawnSync } = require('child_process');

const TOOLS = { ping: 'Ping contínuo', trace: 'Traceroute', mtr: 'MTR (perda e latência por salto)' };

function checkTarget(t) {
  const v = String(t || '').trim();
  if (!/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(v) || v.length > 253) throw new Error('Destino inválido: use um IP ou nome de host');
  return v;
}

// Monta o comando (função pura, testada sem executar nada). `have(cmd)` diz se o programa existe.
function plan(tool, target, platform, have = () => true) {
  const t = checkTarget(target);
  const win = platform === 'win32';
  if (tool === 'ping') return win ? { cmd: 'ping', args: ['-t', t] } : { cmd: 'ping', args: [t] };
  if (tool === 'trace') {
    if (win) return { cmd: 'tracert', args: ['-d', t] };
    if (have('traceroute')) return { cmd: 'traceroute', args: ['-n', t] };
    if (have('tracepath')) return { cmd: 'tracepath', args: ['-n', t] };
    throw new Error('Traceroute não encontrado. No Linux instale: sudo apt install traceroute');
  }
  if (tool === 'mtr') {
    if (win) return { cmd: 'pathping', args: ['-n', '-q', '20', t], note: 'No Windows o MTR é o pathping: leva cerca de 1 minuto e meio para mostrar o resultado.' };
    if (have('mtr')) return { cmd: 'mtr', args: ['-n', '-r', '-w', '-c', '20', t], note: 'Relatório com 20 ciclos: aguarde alguns segundos.' };
    throw new Error(platform === 'darwin' ? 'MTR não encontrado. No Mac: brew install mtr (e rode com permissão de administrador).' : 'MTR não encontrado. No Linux instale: sudo apt install mtr-tiny');
  }
  throw new Error('Ferramenta desconhecida');
}

const haveCmd = (c) => { try { return spawnSync('which', [c], { stdio: 'ignore' }).status === 0; } catch { return false; } };

function makeDecoder(platform) {
  if (platform === 'win32') { try { return new TextDecoder('ibm850'); } catch { /* usa latin1 */ } try { return new TextDecoder('latin1'); } catch { /* usa utf-8 */ } }
  return new TextDecoder('utf-8');
}

class ToolSession {
  constructor({ host, onData, onClose, onStatus, planner }) {
    this.host = host; this.onData = onData; this.onClose = onClose; this.onStatus = onStatus;
    this.planner = planner || plan;
  }

  start() {
    const platform = process.platform;
    const p = this.planner(this.host.tool, this.host.address, platform, haveCmd);
    const dec = { out: makeDecoder(platform), err: makeDecoder(platform) };
    return new Promise((resolve, reject) => {
      const child = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      let started = false;
      const show = (d, dc) => this.onData(dc.decode(d, { stream: true }).replace(/\r?\n/g, '\r\n'));
      child.stdout.on('data', (d) => show(d, dec.out));
      child.stderr.on('data', (d) => show(d, dec.err));
      child.on('error', (e) => {
        if (started) return;
        reject(new Error(e.code === 'ENOENT' ? `Programa "${p.cmd}" não encontrado neste computador.` : e.message));
      });
      child.on('spawn', () => {
        started = true;
        this.onStatus(`Executando: ${p.cmd} ${p.args.join(' ')}`);
        if (p.note) this.onData('\x1b[90m' + p.note + '\x1b[0m\r\n');
        resolve();
      });
      child.on('close', (code, sig) => {
        if (this.closed) return;
        this.closed = true;
        this.onClose(sig ? 'Interrompido' : `Concluído (código ${code})`);
      });
    });
  }

  write(data) { if (String(data).includes('\x03') && this.child) { try { this.child.kill(); } catch { /* ignora */ } } } // Ctrl+C para
  resize() { /* sem janela */ }
  close() { this.closed = true; if (this.child) { try { this.child.kill(); } catch { /* ignora */ } } }
}

module.exports = { ToolSession, plan, checkTarget, TOOLS };
