'use strict';
// Descoberta de vizinhos MikroTik (MNDP, UDP 5678) — o mesmo que a aba "Neighbors" do WinBox.
const dgram = require('node:dgram');
const os = require('node:os');

const PORT = 5678;
const mac = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
const str = (b) => b.toString('utf8').replace(/\0+$/, '');

// pacote: 2 bytes de sequência + blocos [tipo u16][tamanho u16][valor] (tudo big-endian, exceto uptime)
function parseMndp(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  const n = { mac: '', ip: '', ipv6: '', identity: '', version: '', platform: '', board: '', uptime: 0, iface: '' };
  let o = 4;
  while (o + 4 <= buf.length) {
    const t = buf.readUInt16BE(o); const l = buf.readUInt16BE(o + 2); o += 4;
    if (o + l > buf.length) break;
    const v = buf.subarray(o, o + l); o += l;
    if (t === 1 && l === 6) n.mac = mac(v);
    else if (t === 5) n.identity = str(v);
    else if (t === 7) n.version = str(v);
    else if (t === 8) n.platform = str(v);
    else if (t === 10 && l === 4) n.uptime = v.readUInt32LE(0);
    else if (t === 12) n.board = str(v);
    else if (t === 15 && l === 16) { const p = []; for (let i = 0; i < 16; i += 2) p.push(v.readUInt16BE(i).toString(16)); n.ipv6 = p.join(':'); }
    else if (t === 16) n.iface = str(v);
    else if (t === 17 && l === 4) n.ip = [...v].join('.');
  }
  return n.mac ? n : null;
}

function broadcasts() { // endereço de broadcast de cada placa de rede IPv4
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number); const m = a.netmask.split('.').map(Number);
      out.add(ip.map((x, i) => (x | (~m[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

// escuta ~3 s e devolve a lista (sem repetir o mesmo MAC+IP)
function discover({ timeoutMs = 3000, createSocket = (o) => dgram.createSocket(o), targets = broadcasts() } = {}) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (err) => {
      if (done) return; done = true;
      try { sock.close(); } catch { /* ignora */ }
      if (err) reject(err); else resolve([...found.values()]);
    };
    sock.on('error', (e) => finish(new Error(e.code === 'EACCES' || e.code === 'EADDRINUSE'
      ? 'Não consegui usar a porta 5678 (feche o WinBox ou libere no firewall): ' + e.message : e.message)));
    sock.on('message', (msg) => {
      const n = parseMndp(msg);
      if (n) found.set(n.mac + '|' + n.ip, n);
    });
    sock.bind(PORT, () => {
      try { sock.setBroadcast(true); } catch { /* ignora */ }
      const ask = () => targets.forEach((t) => { try { sock.send(Buffer.alloc(4), PORT, t); } catch { /* ignora */ } });
      ask(); setTimeout(ask, 800); // pede para os equipamentos se anunciarem
      setTimeout(() => finish(), timeoutMs);
    });
  });
}

module.exports = { parseMndp, discover, broadcasts, PORT };
