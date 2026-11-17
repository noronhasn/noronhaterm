'use strict';
// Ferramentas de rede (ping, traceroute, MTR) usando os programas que o próprio sistema já tem.
// A saída vai para uma aba de terminal comum; Ctrl+C ou fechar a aba para o programa.
const { spawn, spawnSync } = require('child_process');

const net = require('net');

const TOOLS = {
  ping: 'Ping contínuo', trace: 'Traceroute', mtr: 'MTR (perda e latência por salto)',
  dns: 'DNS (nslookup)', whois: 'Whois (dono do domínio ou IP)',
  nmap: 'Nmap: portas abertas (rápido)', nmapsv: 'Nmap: portas e versões dos serviços', nmapsn: 'Nmap: descobrir equipamentos ativos (ex.: 192.168.0.0/24)',
};

function checkTarget(t, { cidr = false } = {}) {
  const v = String(t || '').trim();
  const re = cidr ? /^[A-Za-z0-9._:][A-Za-z0-9._:\/-]*$/ : /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;
  if (!re.test(v) || v.length > 253) throw new Error('Destino inválido: use um IP ou nome de host' + (cidr ? ' (ou rede, ex.: 192.168.0.0/24)' : ''));
  return v;
}

const NMAP_AVISO = 'Use o nmap só em redes suas ou com autorização.';
const nmapHint = (platform) => platform === 'win32'
  ? 'Nmap não encontrado. No Windows instale: winget install Insecure.Nmap (ou baixe em nmap.org) e abra o NetDeck de novo.'
  : platform === 'darwin' ? 'Nmap não encontrado. No Mac: brew install nmap' : 'Nmap não encontrado. No Linux instale: sudo apt install nmap';

// Monta o comando (função pura, testada sem executar nada). `have(cmd)` diz se o programa existe.
function plan(tool, target, platform, have = () => true) {
  const isNmap = /^nmap/.test(String(tool));
  const t = isNmap ? String(target || '').trim() : checkTarget(target);
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
  if (tool === 'dns') return { cmd: 'nslookup', args: [t] };
  if (tool === 'whois') return { native: 'whois', target: t };
  if (tool === 'nmap' || tool === 'nmapsv' || tool === 'nmapsn') {
    const nt = checkTarget(target, { cidr: true });
    if (!have('nmap')) throw new Error(nmapHint(platform));
    const args = tool === 'nmap' ? ['-T4', '-F', nt] : tool === 'nmapsv' ? ['-T4', '-sV', '--top-ports', '100', nt] : ['-sn', nt];
    return { cmd: 'nmap', args, note: NMAP_AVISO };
  }
  throw new Error('Ferramenta desconhecida');
}

const haveCmd = (c) => { try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore', windowsHide: true }).status === 0; } catch { return false; } };

// Whois feito aqui mesmo (o Windows não tem whois): pergunta ao IANA e segue o "refer:" até o servidor certo
function whoisAsk(server, query, { port = 43, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.connect({ host: server, port });
    const timer = setTimeout(() => sock.destroy(new Error('Tempo esgotado consultando ' + server)), timeoutMs);
    sock.on('connect', () => sock.write(query + '\r\n'));
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    sock.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    sock.setTimeout(timeoutMs);
    whoisAsk.last = sock;
  });
}

async function whois(target, emit, opts = {}) {
  const first = opts.first || 'whois.iana.org';
  const port = opts.port || 43;
  emit(`\x1b[90m>> ${first}\x1b[0m\r\n`);
  const a = await whoisAsk(first, target, { port, timeoutMs: opts.timeoutMs });
  const m = /^(?:refer|whois):\s*(\S+)/im.exec(a);
  if (!m || m[1].toLowerCase() === first.toLowerCase() || opts.noFollow) { emit(a.replace(/\r?\n/g, '\r\n')); return; }
  emit(`\x1b[90m>> ${m[1]}\x1b[0m\r\n`);
  const b = await whoisAsk(m[1], target, { port: opts.followPort || 43, timeoutMs: opts.timeoutMs });
  emit(b.replace(/\r?\n/g, '\r\n'));
}

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
    if (p.native === 'whois') { // consulta feita dentro do app, sem programa externo
      this.onStatus('Consultando whois de ' + p.target);
      whois(p.target, (t) => this.onData(t), this.whoisOpts || {})
        .then(() => { if (!this.closed) { this.closed = true; this.onClose('Concluído'); } })
        .catch((e) => { if (!this.closed) { this.closed = true; this.onData('\r\n\x1b[31mFalha: ' + e.message + '\x1b[0m\r\n'); this.onClose('Erro'); } });
      return Promise.resolve();
    }
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

  write(data) { if (String(data).includes('\x03') && !this.child) { this.closed = true; try { whoisAsk.last && whoisAsk.last.destroy(); } catch { /* ignora */ } this.onClose('Interrompido'); return; }
    if (String(data).includes('\x03') && this.child) { try { this.child.kill(); } catch { /* ignora */ } } } // Ctrl+C para
  resize() { /* sem janela */ }
  close() { this.closed = true; if (this.child) { try { this.child.kill(); } catch { /* ignora */ } } }
}

module.exports = { ToolSession, plan, checkTarget, TOOLS, whois };
