'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Vault } = require('../src/core/vault');
const { Store, parseSshConfig } = require('../src/core/store');
const keys = require('../src/core/keys');

const FAST = { N: 1 << 10, r: 8, p: 1 }; // KDF rápido só nos testes
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-')), 'u.vault');
const newStore = () => new Store(Vault.create(tmp(), 'senha-mestra-123', {}, FAST));

test('cofre: grava cifrado, reabre com a senha certa', () => {
  const f = tmp();
  const v = Vault.create(f, 'senha-mestra-123', { segredo: 'MEU-SEGREDO-XYZ' }, FAST);
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes('MEU-SEGREDO-XYZ'), 'o segredo não pode aparecer em texto puro');
  v.lock();
  assert.equal(v.data, null);
  const v2 = Vault.open(f, 'senha-mestra-123');
  assert.equal(v2.data.segredo, 'MEU-SEGREDO-XYZ');
});

test('cofre: senha errada e arquivo adulterado são rejeitados', () => {
  const f = tmp();
  Vault.create(f, 'senha-mestra-123', { a: 1 }, FAST);
  assert.throws(() => Vault.open(f, 'senha-errada-999'), { code: 'BAD_PASSWORD' });
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  const buf = Buffer.from(doc.data, 'base64'); buf[0] ^= 1; doc.data = buf.toString('base64');
  fs.writeFileSync(f, JSON.stringify(doc));
  assert.throws(() => Vault.open(f, 'senha-mestra-123'), { code: 'BAD_PASSWORD' });
  // parâmetros do KDF também são autenticados
  const f2 = tmp();
  Vault.create(f2, 'senha-mestra-123', {}, FAST);
  const d2 = JSON.parse(fs.readFileSync(f2, 'utf8')); d2.kdf.r = 16;
  fs.writeFileSync(f2, JSON.stringify(d2));
  assert.throws(() => Vault.open(f2, 'senha-mestra-123'), { code: 'BAD_PASSWORD' });
});

test('cofre: senha fraca, troca de senha, IV novo a cada gravação', () => {
  assert.throws(() => Vault.create(tmp(), '123', {}, FAST), { code: 'WEAK_PASSWORD' });
  const f = tmp();
  const v = Vault.create(f, 'senha-mestra-123', { x: 1 }, FAST);
  const iv1 = JSON.parse(fs.readFileSync(f)).iv;
  v.save();
  assert.notEqual(JSON.parse(fs.readFileSync(f)).iv, iv1);
  v.changePassword('outra-senha-456');
  assert.throws(() => Vault.open(f, 'senha-mestra-123'), { code: 'BAD_PASSWORD' });
  assert.equal(Vault.open(f, 'outra-senha-456').data.x, 1);
});

test('pastas: árvore, subpastas, mover hosts', () => {
  const s = newStore();
  const a = s.addFolder({ name: 'Cliente A' });
  const prod = s.addFolder({ name: 'Produção', parentId: a.id });
  const h = s.addHost({ name: 'web-01', address: '10.0.0.1', folderId: prod.id });
  const raiz = s.addHost({ name: 'solto', address: '10.0.0.9' });
  let t = s.tree();
  assert.equal(t.folders[0].children[0].hosts[0].name, 'web-01');
  assert.equal(t.rootHosts[0].id, raiz.id);
  s.moveHost(h.id, null);
  t = s.tree();
  assert.equal(t.rootHosts.length, 2);
});

test('pastas: impede ciclo ao mover pasta para dentro de si', () => {
  const s = newStore();
  const a = s.addFolder({ name: 'A' });
  const b = s.addFolder({ name: 'B', parentId: a.id });
  const c = s.addFolder({ name: 'C', parentId: b.id });
  assert.throws(() => s.moveFolder(a.id, c.id), /dentro dela mesma/);
  assert.throws(() => s.moveFolder(a.id, a.id), /dentro dela mesma/);
  s.moveFolder(c.id, null); // mover para a raiz é permitido
});

test('pastas: remover movendo conteúdo vs em cascata', () => {
  const s = newStore();
  const a = s.addFolder({ name: 'A' });
  const b = s.addFolder({ name: 'B', parentId: a.id });
  const h = s.addHost({ name: 'h', address: 'x', folderId: b.id });
  s.removeFolder(b.id);
  assert.equal(s._host(h.id).folderId, a.id);
  s.removeFolder(a.id, { cascade: true });
  assert.equal(s.data.hosts.length, 0);
  assert.equal(s.data.folders.length, 0);
});

test('herança: identidade, comandos iniciais e jump host vindos da pasta', () => {
  const s = newStore();
  const id1 = s.addIdentity({ name: 'root', username: 'root', password: 'pw1' });
  const id2 = s.addIdentity({ name: 'dba', username: 'dba', password: 'pw2' });
  const a = s.addFolder({ name: 'A', defaultIdentityId: id1.id, startupCommands: ['cd /srv'] });
  const b = s.addFolder({ name: 'B', parentId: a.id, startupCommands: ['ls'] });
  const bastion = s.addHost({ name: 'bastion', address: '1.1.1.1', folderId: a.id });
  s.updateFolder(b.id, { defaultJumpHostId: bastion.id });
  const web = s.addHost({ name: 'web', address: '10.0.0.2', folderId: b.id, startupCommands: ['htop'] });
  const db = s.addHost({ name: 'db', address: '10.0.0.3', folderId: b.id, identityId: id2.id });

  const r = s.resolveHost(web.id);
  assert.equal(r.identity.username, 'root', 'herda da pasta avó');
  assert.deepEqual(r.startupCommands, ['cd /srv', 'ls', 'htop'], 'raiz -> folha -> host');
  assert.equal(r.jumpChain.length, 1);
  assert.equal(r.jumpChain[0].address, '1.1.1.1');
  assert.equal(r.jumpChain[0].identity.username, 'root', 'o jump também herda identidade');
  assert.equal(s.resolveHost(db.id).identity.username, 'dba', 'identidade própria vence');
});

test('herança: ciclo de jump hosts é detectado', () => {
  const s = newStore();
  const x = s.addHost({ name: 'x', address: '1' });
  const y = s.addHost({ name: 'y', address: '2', jumpHostId: x.id });
  s.updateHost(x.id, { jumpHostId: y.id });
  assert.throws(() => s.resolveHost(x.id), /Ciclo/);
  assert.throws(() => s.updateHost(x.id, { jumpHostId: x.id }), /si mesmo/);
});

test('remover identidade/chave limpa referências', () => {
  const s = newStore();
  const k = s.generateKey({ name: 'k1' });
  const i = s.addIdentity({ name: 'i', username: 'u', keyId: k.id });
  const h = s.addHost({ name: 'h', address: 'x', identityId: i.id });
  s.removeKey(k.id);
  assert.equal(s._identity(i.id).keyId, null);
  s.removeIdentity(i.id);
  assert.equal(s._host(h.id).identityId, null);
});

test('busca por nome, endereço e tag', () => {
  const s = newStore();
  s.addHost({ name: 'Switch-Core', address: '192.168.1.1', tags: ['rede', 'cisco'] });
  s.addHost({ name: 'web', address: '10.0.0.5' });
  assert.equal(s.search('cisco').length, 1);
  assert.equal(s.search('10.0.0').length, 1);
  assert.equal(s.search('SWITCH').length, 1);
  assert.equal(s.search('').length, 0);
});

test('host serial recebe valores padrão e não exige endereço', () => {
  const s = newStore();
  const h = s.addHost({ name: 'console', protocol: 'serial', serial: { port: 'COM3' } });
  assert.deepEqual(h.serial, { port: 'COM3', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none' });
  assert.throws(() => s.addHost({ name: 'x', protocol: 'ssh' }), /endereço/);
});

test('chave Ed25519: formato OpenSSH consistente (privada <-> pública <-> fingerprint)', () => {
  const g = keys.generateKey({ type: 'ed25519', comment: 'teste@pc' });
  assert.match(g.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(g.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ teste@pc$/);
  const parsed = keys.parseOpenSshPrivate(g.privateKey);
  assert.equal(parsed.encrypted, false);
  assert.equal(parsed.blob.toString('base64'), g.publicKey.split(' ')[1]);
  assert.equal(keys.fingerprint(parsed.blob), g.fingerprint);

  // a seed gravada na seção privada deve derivar exatamente a chave pública publicada
  const buf = Buffer.from(g.privateKey.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  let off = 15; const rd = () => { const l = buf.readUInt32BE(off); off += 4; const s = buf.subarray(off, off + l); off += l; return s; };
  rd(); rd(); rd(); off += 4; rd();
  const priv = rd();
  assert.equal(priv.length % 8, 0, 'seção privada alinhada em 8 bytes');
  assert.equal(priv.readUInt32BE(0), priv.readUInt32BE(4), 'checkints iguais');
  off = 8; const rdp = () => { const l = priv.readUInt32BE(off); off += 4; const s = priv.subarray(off, off + l); off += l; return s; };
  assert.equal(rdp().toString(), 'ssh-ed25519');
  const pub = rdp(); const seedPub = rdp();
  const ko = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: seedPub.subarray(0, 32).toString('base64url'), x: pub.toString('base64url') }, format: 'jwk' });
  assert.equal(crypto.createPublicKey(ko).export({ format: 'jwk' }).x, pub.toString('base64url'));
});

test('chaves RSA/ECDSA geram e reimportam com mesmo fingerprint', () => {
  const s = newStore();
  const rsa = s.generateKey({ name: 'r', type: 'rsa', bits: 2048 });
  const ec = s.generateKey({ name: 'e', type: 'ecdsa' });
  assert.match(rsa.publicKey, /^ssh-rsa /);
  assert.match(ec.publicKey, /^ecdsa-sha2-nistp256 /);
  const again = s.importKey({ name: 'r2', privateKey: rsa.privateKey });
  assert.equal(again.fingerprint, rsa.fingerprint);
  assert.throws(() => keys.generateKey({ type: 'rsa', bits: 1024 }), /insegura/);
  assert.throws(() => s.importKey({ name: 'lixo', privateKey: 'isso não é uma chave' }), /não reconhecido/);
});

test('importa chave Ed25519 em formato OpenSSH gerada pelo próprio app', () => {
  const s = newStore();
  const k = s.generateKey({ name: 'k', comment: 'a b/c' });
  assert.equal(k.publicKey.split(' ')[2], 'abc', 'comentário é sanitizado');
  const i = s.importKey({ name: 'k2', privateKey: k.privateKey });
  assert.equal(i.fingerprint, k.fingerprint);
});

test('known hosts: novo, igual e alterado', () => {
  const s = newStore();
  assert.equal(s.checkHostKey('h:22', 'SHA256:aaa'), 'new');
  s.trustHostKey('h:22', 'ssh-ed25519', 'SHA256:aaa');
  assert.equal(s.checkHostKey('h:22', 'SHA256:aaa'), 'match');
  assert.equal(s.checkHostKey('h:22', 'SHA256:bbb'), 'mismatch');
});

test('importar ~/.ssh/config com ProxyJump e IdentityFile', () => {
  const cfg = `
Host *
  ServerAliveInterval 30
Host bastion
  HostName 200.1.1.1
  User ops
  Port 2222
Host app
  HostName 10.0.0.10
  User deploy
  IdentityFile ~/.ssh/id_deploy
  ProxyJump ops@bastion:2222
`;
  assert.equal(parseSshConfig(cfg).length, 3);
  const s = newStore();
  const k = keys.generateKey({ type: 'ed25519' });
  const r = s.importSshConfig(cfg, (p) => (p.endsWith('id_deploy') ? k.privateKey : null));
  assert.equal(r.hosts, 2, 'o Host * é ignorado');
  const app = s.data.hosts.find((h) => h.name === 'app');
  const bastion = s.data.hosts.find((h) => h.name === 'bastion');
  assert.equal(bastion.port, 2222);
  assert.equal(app.jumpHostId, bastion.id);
  assert.equal(s.resolveHost(app.id).identity.privateKey, k.privateKey);
  assert.equal(s.data.keys.length, 1);
});

test('exportar sem segredos e importar em outro cofre', () => {
  const s = newStore();
  const k = s.generateKey({ name: 'k' });
  const i = s.addIdentity({ name: 'i', username: 'u', password: 'SEGREDO', keyId: k.id });
  s.addHost({ name: 'h', address: 'x', identityId: i.id });
  const exp = s.exportData();
  const json = JSON.stringify(exp);
  assert.ok(!json.includes('SEGREDO') && !json.includes('PRIVATE KEY'));
  assert.ok(JSON.stringify(s.exportData({ includeSecrets: true })).includes('SEGREDO'));
  const s2 = newStore();
  assert.equal(s2.importData(exp), 3);
  assert.equal(s2.importData(exp), 0, 'reimportar não duplica');
});

test('persistência: dados do store sobrevivem a fechar e reabrir o cofre', () => {
  const f = tmp();
  const s = new Store(Vault.create(f, 'senha-mestra-123', {}, FAST));
  const folder = s.addFolder({ name: 'Rede' });
  s.addHost({ name: 'sw', address: '10.1.1.1', protocol: 'telnet', folderId: folder.id });
  s.vault.lock();
  const s2 = new Store(Vault.open(f, 'senha-mestra-123'));
  assert.equal(s2.tree().folders[0].hosts[0].protocol, 'telnet');
  assert.equal(s2.tree().folders[0].hosts[0].port, 23);
});

test('chaves: ECDSA P-384 e P-521 geram e reimportam com o mesmo fingerprint', () => {
  const s = newStore();
  for (const [t, name] of [['ecdsa384', 'ecdsa-sha2-nistp384'], ['ecdsa521', 'ecdsa-sha2-nistp521']]) {
    const k = s.generateKey({ name: t, type: t });
    assert.match(k.publicKey, new RegExp('^' + name + ' '));
    assert.equal(s.importKey({ name: t + '2', privateKey: k.privateKey }).fingerprint, k.fingerprint);
  }
});

test('chaves: importa .ppk (pública em claro) e bate o fingerprint com a chave original', () => {
  const g = keys.generateKey({ type: 'ed25519' });
  const blob = Buffer.from(g.publicKey.split(' ')[1], 'base64');
  const b64 = blob.toString('base64');
  const ppk = [
    'PuTTY-User-Key-File-3: ssh-ed25519', 'Encryption: aes256-cbc', 'Comment: teste',
    'Public-Lines: 1', b64, 'Key-Derivation: Argon2id', 'Private-Lines: 1', 'AAAA', 'Private-MAC: 00',
  ].join('\r\n');
  const d = keys.describePrivateKey(ppk);
  assert.equal(d.type, 'ssh-ed25519');
  assert.equal(d.encrypted, true);
  assert.equal(keys.fingerprint(d.blob), g.fingerprint);
  const s = newStore();
  assert.equal(s.importKey({ name: 'ppk', privateKey: ppk }).fingerprint, g.fingerprint);
});

test('normalizeAddress: tira zero à esquerda de IPv4 e deixa o resto como está', () => {
  const { normalizeAddress } = require('../src/main/netutil');
  assert.equal(normalizeAddress('198.19.0.07'), '198.19.0.7');
  assert.equal(normalizeAddress(' 010.001.000.099 '), '10.1.0.99');
  assert.equal(normalizeAddress('192.168.10.103'), '192.168.10.103');
  assert.equal(normalizeAddress('300.1.1.1'), '300.1.1.1');
  assert.equal(normalizeAddress('switch.exemplo.com'), 'switch.exemplo.com');
  assert.equal(normalizeAddress('fe80::1'), 'fe80::1');
});

test('usuário/senha salvos só para o host: resolve e some junto com o host', () => {
  const st = newStore();
  const h = st.addHost({ name: 'sw1', address: '10.0.0.1' });
  const id = st.addIdentity({ name: 'sw1', username: 'admin', password: 'segredo', ownerHostId: h.id });
  st.updateHost(h.id, { identityId: id.id });
  const r = st.resolveHost(h.id);
  assert.equal(r.identity.username, 'admin');
  assert.equal(r.identity.password, 'segredo');
  st.removeHost(h.id);
  assert.equal(st.data.identities.length, 0);
});
