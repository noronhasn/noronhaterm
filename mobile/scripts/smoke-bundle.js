'use strict';
// Teste do pacote FINAL do app (www/mobile.js): roda dentro do Node, com um "navegador" e um "código nativo" de mentira,
// e confere que o cofre, a lista de hosts, o SSH (via plugin) e o Telnet (socket de verdade) funcionam empacotados.
// Uso (dentro de mobile/): node scripts/build-web.js && node scripts/smoke-bundle.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const assert = require('assert/strict');

const www = path.join(__dirname, '..', 'www');
const mem = new Map();
const localStorage = {
  get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
};
const calls = []; const handlers = {}; const tcp = new Map();
const fire = (ev, e) => (handlers[ev] || []).forEach((f) => f(e));
const native = {
  addListener(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); return Promise.resolve({ remove() {} }); },
  async sshOpen(a) { calls.push(['sshOpen', a]); },
  async sshWrite(a) { calls.push(['sshWrite', a]); },
  async sshResize(a) { calls.push(['sshResize', a]); },
  async sshClose(a) { calls.push(['sshClose', a]); },
  async hostKeyAnswer(a) { calls.push(['hostKeyAnswer', a]); },
  tcpOpen: ({ sid, host, port }) => new Promise((res, rej) => {
    const c = net.connect({ host, port }, res);
    c.on('error', rej);
    c.on('data', (d) => fire('tcpdata', { sid, b64: d.toString('base64') }));
    c.on('close', () => fire('tcpclosed', { sid }));
    tcp.set(sid, c);
  }),
  async tcpWrite({ sid, b64 }) { tcp.get(sid).write(Buffer.from(b64, 'base64')); },
  async tcpClose({ sid }) { const c = tcp.get(sid); if (c) c.destroy(); },
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
  atob, btoa, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, URL,
  crypto: crypto.webcrypto, localStorage, navigator: { userAgent: 'Android' },
  document: { createElement: () => ({ style: {}, click() {}, remove() {}, addEventListener() {} }), body: { append() {} }, addEventListener() {} },
  __NETDECK_VERSION__: '9.9.9', __NETDECK_NATIVE__: native,
};
sandbox.window = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
// só para as bibliotecas de teste (nos pacotes reais isto é ignorado)
sandbox.__nodeCrypto = crypto; sandbox.__NodeBuffer = Buffer;
vm.runInContext(fs.readFileSync(path.join(www, 'mobile.js'), 'utf8'), sandbox, { filename: 'www/mobile.js' });

(async () => {
  const api = sandbox.window.api;
  assert.ok(api && api.mobile, 'window.api criado');
  assert.equal(await api.version(), '9.9.9');
  const SID = '11111111-2222-3333-4444-555555555555';

  // cofre: criar, usar, bloquear, entrar com senha certa e errada
  let t0 = Date.now();
  await api.createVault('noronha', 'senha-forte-1');
  console.log('  criar cofre (scrypt N=32768):', Date.now() - t0, 'ms');
  const id = await api.call('addIdentity', { name: 'admin', username: 'admin', password: 'segredo' });
  const host = await api.call('addHost', { name: 'SW1', address: '198.19.0.07', protocol: 'ssh', identityId: id.result.id });
  assert.ok(!JSON.stringify(host.snapshot).includes('segredo'));
  await api.lock();
  await assert.rejects(api.unlock('noronha', 'errada-errada'), /incorreta|corrompido/);
  const snap = await api.unlock('noronha', 'senha-forte-1');
  assert.equal(snap.hosts[0].name, 'SW1');
  const raw = mem.get('nd:fs:/vaults/noronha.vault');
  assert.ok(raw && !raw.includes('SW1') && !raw.includes('segredo'), 'o cofre salvo está criptografado');

  // o MESMO arquivo abre no cofre do computador
  const { Vault } = require('../../src/core/vault');
  const tmp = path.join(require('os').tmpdir(), 'nd-smoke-' + process.pid + '.vault');
  fs.writeFileSync(tmp, raw);
  assert.equal(Vault.open(tmp, 'senha-forte-1').data.hosts[0].name, 'SW1', 'cofre do pacote abre no computador');
  fs.rmSync(tmp);

  // SSH pelo plugin
  const events = [];
  api.on('session:status', (sid, m) => events.push(m));
  const got = [];
  api.on('session:data', (sid, d) => got.push(Buffer.from(d).toString()));
  await api.open({ id: SID, hostId: host.result.id, cols: 90, rows: 30 });
  const open = calls.find((c) => c[0] === 'sshOpen')[1];
  assert.equal(open.hops[0].host, '198.19.0.7');
  assert.equal(open.hops[0].username, 'admin');
  fire('data', { sid: SID, b64: Buffer.from('SW1# ').toString('base64') });
  assert.deepEqual(got, ['SW1# ']);
  api.input(SID, 'ls\r');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'sshWrite')[1]), JSON.stringify({ sid: SID, data: 'ls\r' })); // objetos de outro "mundo" (vm): compara como texto
  api.close(SID);

  // Telnet de verdade (servidor local)
  const server = net.createServer((s) => { s.write('Login: '); s.on('data', (d) => s.write('eco:' + d)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const th = await api.call('addHost', { name: 'T', address: '127.0.0.1', port: server.address().port, protocol: 'telnet' });
  const tout = [];
  api.on('session:data', (sid, d) => { if (sid === SID.replace('1111', '2222')) tout.push(Buffer.from(d).toString()); });
  const TSID = SID.replace('1111', '2222');
  await api.open({ id: TSID, hostId: th.result.id, cols: 80, rows: 24 });
  await new Promise((r) => setTimeout(r, 100));
  api.input(TSID, 'oi\r');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(tout.join('').includes('Login: ') && tout.join('').includes('eco:oi'), 'Telnet: ' + JSON.stringify(tout));
  api.close(TSID);
  server.close(); for (const c of tcp.values()) c.destroy();
  console.log('smoke do pacote Android: OK');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
