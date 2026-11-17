'use strict';
// App Android: o cofre e o armazenamento rodam no WebView com "crypto", "fs" e "net" substituídos.
// Aqui os mesmos arquivos do computador (src/core, src/main/telnet.js) são carregados com os substitutos
// e comparados com os originais, sem precisar de celular.
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const nodeNet = require('net');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCryptoShim } = require('../mobile/src/shims/crypto');
const { createFsShim } = require('../mobile/src/shims/fs');
const pathShim = require('../mobile/src/shims/path');
const netShim = require('../mobile/src/shims/net');
const { createApp } = require('../mobile/src/appcore');

// primitivas = o crypto do Node (no celular são as bibliotecas @noble, que fazem a mesma conta)
const prims = {
  randomBytes: (n) => nodeCrypto.randomBytes(n),
  scrypt: (pw, salt, { N, r, p, dkLen }) => nodeCrypto.scryptSync(pw, salt, dkLen, { N, r, p, maxmem: 512 * 1024 * 1024 }),
  gcmEncrypt(key, iv, aad, pt) {
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(aad);
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  },
  gcmDecrypt(key, iv, aad, ct) {
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv); d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  },
};

function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  };
}

// carrega os módulos do computador trocando crypto/fs/path/net/keys pelos substitutos do celular
function loadMobile(store) {
  const root = path.join(__dirname, '..', 'src');
  const subs = {
    crypto: createCryptoShim(prims), fs: createFsShim(store), path: pathShim, net: netShim,
  };
  const orig = Module._load;
  const mine = (f) => f && f.startsWith(root);
  Module._load = function (req, parent, ...r) {
    if (mine(parent && parent.filename)) {
      if (subs[req]) return subs[req];
      if (/(^|\/)keys$/.test(req)) return require('../mobile/src/shims/keys');
    }
    return orig.call(this, req, parent, ...r);
  };
  for (const k of Object.keys(require.cache)) if (mine(k)) delete require.cache[k];
  try {
    const out = {
      Vault: require('../src/core/vault').Vault, Store: require('../src/core/store').Store,
      TelnetSession: require('../src/main/telnet').TelnetSession, fs: subs.fs,
    };
    return out;
  } finally {
    Module._load = orig;
    for (const k of Object.keys(require.cache)) if (mine(k)) delete require.cache[k]; // não deixa os substitutos vazarem para outros testes
  }
}

const KDF = { N: 1 << 10, r: 8, p: 1 }; // rápido nos testes; o formato é o mesmo

test('android: cofre criado no celular abre no computador e vice-versa (mesmo arquivo)', () => {
  const st = memoryStorage();
  const m = loadMobile(st);
  const { Vault: DesktopVault } = require('../src/core/vault');

  m.Vault.create('/vaults/ana.vault', 'senha-forte-1', { marca: 'celular', n: 1 }, KDF);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-and-'));
  const f1 = path.join(tmp, 'ana.vault');
  fs.writeFileSync(f1, st.getItem('nd:fs:/vaults/ana.vault'));
  assert.equal(DesktopVault.open(f1, 'senha-forte-1').data.marca, 'celular', 'computador abre o cofre do celular');
  assert.throws(() => DesktopVault.open(f1, 'senha-errada-1'));

  const f2 = path.join(tmp, 'bia.vault');
  DesktopVault.create(f2, 'outra-senha-22', { marca: 'computador' }, KDF).lock();
  st.setItem('nd:fs:/vaults/bia.vault', fs.readFileSync(f2, 'utf8'));
  assert.equal(m.Vault.open('/vaults/bia.vault', 'outra-senha-22').data.marca, 'computador', 'celular abre o cofre do computador');
  assert.throws(() => m.Vault.open('/vaults/bia.vault', 'senha-errada-1'), /incorreta|corrompido/);

  // alterar e gravar de novo no celular continua legível no computador
  const v = m.Vault.open('/vaults/bia.vault', 'outra-senha-22');
  v.data.extra = 'sim'; v.save();
  fs.writeFileSync(f2, st.getItem('nd:fs:/vaults/bia.vault'));
  assert.equal(DesktopVault.open(f2, 'outra-senha-22').data.extra, 'sim');
});

function fakeNative() {
  const calls = []; const handlers = {};
  const n = {
    calls,
    on: (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); },
    fire: (ev, e) => (handlers[ev] || []).forEach((cb) => cb(e)),
  };
  for (const m of ['sshOpen', 'sshWrite', 'sshResize', 'sshClose', 'hostKeyAnswer', 'tcpOpen', 'tcpWrite', 'tcpClose']) {
    n[m] = async (a) => { calls.push([m, a]); if (n['_' + m]) return n['_' + m](a); };
  }
  return n;
}

function makeApp(over = {}) {
  const st = memoryStorage();
  const m = loadMobile(st);
  const native = fakeNative();
  const saved = [];
  const picks = [];
  const files = { save: async (name, text) => saved.push({ name, text }), pick: async () => picks.shift() || null };
  const app = createApp({ ...m, native, files, version: '9.9.9', uuid: () => nodeCrypto.randomUUID(), tick: async () => {} });
  return { app, st, native, saved, picks, m };
}

test('android: criar usuário, hosts, identidades; senha nunca vai para a interface; bloquear e entrar de novo', async () => {
  const { app } = makeApp();
  assert.deepEqual(await app.users(), []);
  await assert.rejects(app.createVault('../x', 'senha-forte-1'), /inválido/);
  await assert.rejects(app.createVault('curta', '123'), /pelo menos 8/);
  await app.createVault('noronha', 'senha-forte-1');
  assert.deepEqual(await app.users(), ['noronha']);

  const f = await app.call('addFolder', { name: 'sinalbr' });
  const i = await app.call('addIdentity', { name: 'admin', username: 'admin', password: 'segredo' });
  const h = await app.call('addHost', { name: 'SW1', address: '10.0.0.1', protocol: 'ssh', folderId: f.result.id, identityId: i.result.id });
  assert.equal(h.snapshot.hosts.length, 1);
  assert.equal(h.snapshot.identities[0].hasPassword, true);
  assert.ok(!JSON.stringify(h.snapshot).includes('segredo'), 'a senha não vai para a tela');
  await assert.rejects(app.call('generateKey', {}), /não permitida/);

  await app.lock();
  await assert.rejects(app.snapshot(), /bloqueado/);
  await assert.rejects(app.unlock('noronha', 'senha-errada-1'), /incorreta|corrompido/);
  const s = await app.unlock('noronha', 'senha-forte-1');
  assert.equal(s.hosts[0].name, 'SW1');
  assert.equal(await app.version(), '9.9.9');
});

test('android: exportar/importar hosts e backup/restauração do cofre', async () => {
  const { app, saved, picks } = makeApp();
  await app.createVault('noronha', 'senha-forte-1');
  await app.call('addHost', { name: 'A', address: '10.0.0.1', protocol: 'ssh' });

  const nameJson = await app.exportData(false);
  assert.match(nameJson, /^netdeck-hosts-\d{8}-\d{6}\.json$/);
  const json = JSON.parse(saved[0].text);
  assert.equal(json.hosts.length, 1);

  const nameBkp = await app.backupExport();
  assert.match(nameBkp, /^noronha-\d{8}-\d{6}\.vault$/);
  assert.equal(JSON.parse(saved[1].text).format, 'termvault/1', 'o backup é o arquivo criptografado');
  assert.ok(!saved[1].text.includes('10.0.0.1'), 'nada legível dentro do backup');

  await app.call('addHost', { name: 'B', address: '10.0.0.2', protocol: 'ssh' });
  assert.equal((await app.snapshot()).hosts.length, 2);

  // senha errada: nada muda
  picks.push({ name: nameBkp, text: saved[1].text });
  assert.equal(await app.backupPickFile(), nameBkp);
  await assert.rejects(app.backupRestore(nameBkp, 'senha-errada-1'), /incorreta|corrompido/);
  assert.equal((await app.snapshot()).hosts.length, 2);

  const r = await app.backupRestore(nameBkp, 'senha-forte-1');
  assert.equal(r.snapshot.hosts.length, 1, 'voltou ao estado do backup');
  assert.match(r.saved, /^noronha\.vault\.antes-\d{8}-\d{6}$/, 'o cofre anterior ficou guardado');
  await assert.rejects(app.backupRestore(nameBkp, 'senha-forte-1'), /novamente/);

  // importar JSON: só acrescenta o que não existe
  picks.push({ name: 'x.json', text: JSON.stringify({ hosts: [{ id: 'novo-1', name: 'C', address: '10.0.0.3', protocol: 'ssh', folderId: null }] }) });
  const imp = await app.importData();
  assert.equal(imp.added, 1);
  assert.equal(imp.snapshot.hosts.length, 2);
  picks.push({ name: 'ruim.json', text: '{nao é json' });
  await assert.rejects(app.importData(), /JSON válido/);
  assert.equal(await app.importData(), null, 'cancelar não é erro');
});

const SID = '11111111-2222-3333-4444-555555555555';

test('android: SSH usa o plugin nativo: identidade, algoritmos antigos, dados, entrada e fechamento', async () => {
  const { app, native } = makeApp();
  await app.createVault('noronha', 'senha-forte-1');
  const i = await app.call('addIdentity', { name: 'admin', username: 'admin', password: 'segredo' });
  const h = await app.call('addHost', { name: 'SW1', address: '198.19.0.07', protocol: 'ssh', identityId: i.result.id, forwards: ['L:8080:db:5432', 'D:1080'] });
  const got = []; const closed = []; const status = [];
  app.on('session:data', (id, d) => got.push([id, d]));
  app.on('session:close', (id, r) => closed.push([id, r]));
  app.on('session:status', (id, m) => status.push(m));

  const r = await app.open({ id: SID, hostId: h.result.id, cols: 100, rows: 30 });
  assert.equal(r.protocol, 'ssh');
  const open = native.calls.find((c) => c[0] === 'sshOpen')[1];
  assert.equal(open.sid, SID);
  assert.equal(open.cols, 100);
  assert.deepEqual(open.hops, [{ name: 'SW1', host: '198.19.0.7', port: 22, username: 'admin', password: 'segredo', legacy: true }]);
  assert.deepEqual(open.forwards, ['L:8080:db:5432', 'D:1080']);
  assert.ok(status.includes('Conectado'));

  native.fire('data', { sid: SID, b64: Buffer.from('SW1# ').toString('base64') });
  assert.equal(Buffer.from(got[0][1]).toString(), 'SW1# ');
  assert.ok(got[0][1] instanceof Uint8Array);
  native.fire('data', { sid: 'outro', b64: 'AAAA' });
  assert.equal(got.length, 1, 'dados de outra sessão não aparecem aqui');

  app.input(SID, 'show version\r');
  app.resize(SID, 120, 40);
  await new Promise((r2) => setImmediate(r2));
  assert.deepEqual(native.calls.find((c) => c[0] === 'sshWrite')[1], { sid: SID, data: 'show version\r' });
  assert.deepEqual(native.calls.find((c) => c[0] === 'sshResize')[1], { sid: SID, cols: 120, rows: 40 });

  native.fire('closed', { sid: SID, reason: 'Sessão encerrada' });
  assert.deepEqual(closed, [[SID, 'Sessão encerrada']]);
  await assert.rejects(app.open({ id: 'nao-e-uuid', hostId: h.result.id }), /Identificador/);
});

test('android: SSH pergunta usuário e senha quando o host não tem identidade; cancelar não conecta', async () => {
  const { app, native } = makeApp();
  await app.createVault('noronha', 'senha-forte-1');
  const h = await app.call('addHost', { name: 'SW2', address: '10.0.0.2', protocol: 'ssh', legacyAlgorithms: false });
  const asked = [];
  app.on('prompt:ask', (id, title, label, secret) => { asked.push([label, secret]); app.answerPrompt(id, label === 'Usuário' ? 'root' : 'abc'); });
  await app.open({ id: SID, hostId: h.result.id });
  assert.deepEqual(asked, [['Usuário', false], ['Senha', true]]);
  const hop = native.calls.find((c) => c[0] === 'sshOpen')[1].hops[0];
  assert.deepEqual([hop.username, hop.password, hop.legacy], ['root', 'abc', false]);

  const second = makeApp();
  await second.app.createVault('noronha', 'senha-forte-1');
  const h2 = await second.app.call('addHost', { name: 'SW3', address: '10.0.0.3', protocol: 'ssh' });
  second.app.on('prompt:ask', (id) => second.app.answerPrompt(id, null));
  await assert.rejects(second.app.open({ id: SID, hostId: h2.result.id }), /cancelada/);
  assert.ok(!second.native.calls.some((c) => c[0] === 'sshOpen'), 'sem usuário/senha nem tenta conectar');
});

test('android: chave do servidor — conhecida passa; nova e alterada pedem confirmação', async () => {
  const { app, native } = makeApp();
  await app.createVault('noronha', 'senha-forte-1');
  const i = await app.call('addIdentity', { name: 'a', username: 'u', password: 'p' });
  const h = await app.call('addHost', { name: 'SW', address: '10.0.0.9', protocol: 'ssh', identityId: i.result.id });
  await app.open({ id: SID, hostId: h.result.id });
  const confirms = [];
  app.on('confirm:ask', (id, info) => { confirms.push(info); app.answerPrompt(id, confirms.length !== 2); });
  const ev = (fp) => ({ sid: SID, hop: 0, hostport: '10.0.0.9:22', algo: 'ssh-rsa', fp });
  const answers = () => native.calls.filter((c) => c[0] === 'hostKeyAnswer').map((c) => c[1].ok);
  const settle = () => new Promise((r) => setTimeout(r, 5));

  native.fire('hostkey', ev('SHA256:AAA')); await settle();
  assert.equal(confirms[0].changed, false);
  assert.deepEqual(answers(), [true], 'primeira vez: confirmou, vira confiável');
  native.fire('hostkey', ev('SHA256:AAA')); await settle();
  assert.equal(confirms.length, 1, 'já conhecida: não pergunta de novo');
  assert.deepEqual(answers(), [true, true]);
  native.fire('hostkey', ev('SHA256:BBB')); await settle();
  assert.equal(confirms[1].changed, true, 'chave diferente: alerta');
  assert.deepEqual(answers(), [true, true, false], 'recusou: a conexão não segue');
  native.fire('hostkey', ev('SHA256:AAA')); await settle();
  assert.deepEqual(answers().at(-1), true, 'a chave antiga continua confiável depois de recusar a nova');
});

test('android: Telnet do computador roda sobre o socket nativo (servidor de verdade)', async (t) => {
  const conns = new Map();
  const { app, native } = makeApp();
  await app.createVault('noronha', 'senha-forte-1');
  const received = [];
  const server = nodeNet.createServer((sock) => {
    sock.write('Login: ');
    sock.on('data', (d) => { received.push(d.toString()); sock.write('eco:' + d.toString()); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of conns.values()) c.destroy(); server.close(); }); // mesmo se o teste falhar
  const port = server.address().port;

  // o "nativo" de mentira abre sockets TCP de verdade
  netShim.setNative(native);
  native._tcpOpen = ({ sid, host, port: p }) => new Promise((res, rej) => {
    const c = nodeNet.connect({ host, port: p }, () => res());
    c.on('error', rej);
    c.on('data', (d) => native.fire('tcpdata', { sid, b64: d.toString('base64') }));
    c.on('close', () => native.fire('tcpclosed', { sid }));
    conns.set(sid, c);
  });
  native._tcpWrite = ({ sid, b64 }) => { conns.get(sid).write(Buffer.from(b64, 'base64')); };
  native._tcpClose = ({ sid }) => { const c = conns.get(sid); if (c) c.destroy(); };

  const h = await app.call('addHost', { name: 'T', address: '127.0.0.1', port, protocol: 'telnet' });
  const out = [];
  app.on('session:data', (id, d) => out.push(Buffer.from(d).toString()));
  await app.open({ id: SID, hostId: h.result.id, cols: 80, rows: 24 });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(out.join('').includes('Login: '), 'recebeu o banner do servidor');
  app.input(SID, 'admin\r');
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(received.join('').startsWith('admin\r\n'), 'Enter vira CR+LF como no computador: ' + JSON.stringify(received));
  assert.ok(out.join('').includes('eco:admin'));
  const closed = [];
  app.on('session:close', (id) => closed.push(id));
  app.close(SID);
  await new Promise((r) => setTimeout(r, 50));
});

test('android: serial, SFTP e chaves SSH dizem claramente que não existem no celular', async () => {
  const { app } = makeApp();
  await app.createVault('noronha', 'senha-forte-1');
  assert.deepEqual(await app.serialList(), []);
  await assert.rejects(async () => app.sftpList(), /Android/);
  await assert.rejects(async () => app.publicKey(), /Android/);
  const h = await app.call('addHost', { name: 'S', protocol: 'serial', serial: { port: 'COM1' } });
  await assert.rejects(app.open({ id: SID, hostId: h.result.id }), /serial/i);
});
