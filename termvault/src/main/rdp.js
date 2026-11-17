'use strict';
// Acesso remoto (RDP): abre o cliente que o próprio sistema já tem.
//   Windows: mstsc (Conexão de Área de Trabalho Remota)
//   Linux:   xfreerdp3 / xfreerdp / remmina (se instalado)
// A senha salva não vai na linha de comando (qualquer um veria com "ps"):
//   Windows -> credencial temporária do sistema (cmdkey), apagada logo depois
//   Linux   -> xfreerdp recebe os argumentos pela entrada padrão
const { spawn, spawnSync } = require('child_process');

const hostPort = (h) => `${h.address}:${Number(h.port) || 3389}`;

function checkAddress(a) {
  if (!a || !/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(String(a).trim())) throw new Error('Endereço inválido para RDP');
  return String(a).trim();
}

// Monta o que será executado (função pura, testada sem abrir nada).
function plan(host, platform, have = () => false) {
  const addr = checkAddress(host.address);
  const target = hostPort({ address: addr, port: host.port });
  const id = host.identity || {};
  const user = id.username || '';
  const pass = id.password || '';
  if (platform === 'win32') {
    return {
      kind: 'mstsc', cmd: 'mstsc', args: [`/v:${target}`],
      cred: user && pass ? { target: `TERMSRV/${addr}`, user, pass } : null,
    };
  }
  if (platform === 'linux' || platform === 'darwin') {
    const x = ['xfreerdp3', 'xfreerdp'].find(have);
    if (x) {
      const args = [`/v:${target}`, '/cert:ignore', '+clipboard', '/dynamic-resolution', '/size:1280x800'];
      if (user) args.push(`/u:${user}`);
      if (pass) args.push(`/p:${pass}`);
      return { kind: 'freerdp', cmd: x, args: pass ? ['/args-from:stdin'] : args, stdin: pass ? args.join('\n') + '\n' : null };
    }
    if (have('remmina')) return { kind: 'remmina', cmd: 'remmina', args: ['-c', `rdp://${user ? encodeURIComponent(user) + '@' : ''}${target}`] };
    throw new Error('Nenhum cliente RDP encontrado. No Linux instale um: sudo apt install freerdp3-x11 (ou freerdp2-x11, ou remmina).');
  }
  throw new Error('RDP não é suportado neste sistema');
}

const haveCmd = (c) => { try { return spawnSync('which', [c], { stdio: 'ignore' }).status === 0; } catch { return false; } };

function launch(host, platform = process.platform) {
  const p = plan(host, platform, haveCmd);
  if (p.cred) { // Windows: credencial temporária para o mstsc não pedir senha; some em 20 s
    spawnSync('cmdkey', [`/generic:${p.cred.target}`, `/user:${p.cred.user}`, `/pass:${p.cred.pass}`], { stdio: 'ignore', windowsHide: true });
    setTimeout(() => { try { spawnSync('cmdkey', [`/delete:${p.cred.target}`], { stdio: 'ignore', windowsHide: true }); } catch { /* ignora */ } }, 20000);
  }
  const child = spawn(p.cmd, p.args, { detached: true, stdio: [p.stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
  child.on('error', () => {});
  if (p.stdin) { child.stdin.on('error', () => {}); child.stdin.end(p.stdin); }
  child.unref();
  return p.kind;
}

module.exports = { plan, launch, checkAddress };
