'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { TftpServer, FtpServer, ServerManager, jail, sanitizeServers } = require('../src/main/servers');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nt-srv-'));
const rnd = (n) => crypto.randomBytes(n);

// ------------------------------------------------------------ jail
test('jail: caminhos fora da raiz são recusados e os de dentro resolvem', () => {
  const root = mk();
  fs.mkdirSync(path.join(root, 'sub'));
  const real = fs.realpathSync(root);
  assert.equal(jail(root, 'a.bin'), path.join(real, 'a.bin'));
  assert.equal(jail(root, '/sub/../a.bin'), path.join(real, 'a.bin'));
  assert.equal(jail(root, '../etc/passwd'), path.join(real, 'etc', 'passwd'), '.. acima da raiz é preso na raiz');
  assert.equal(jail(root, '..\\..\\x'), path.join(real, 'x'));
  assert.equal(jail(root, ''), real);
  assert.ok(jail(root, 'x\0../../y').startsWith(real));
});

test('jail: link simbólico para fora da raiz é recusado', { skip: process.platform === 'win32' }, () => {
  const root = mk(); const out = mk();
  fs.writeFileSync(path.join(out, 'segredo.txt'), 'x');
  fs.symlinkSync(out, path.join(root, 'saida'));
  assert.equal(jail(root, 'saida/segredo.txt'), null);
  assert.equal(jail(root, 'saida/novo.txt'), null);
});

// ------------------------------------------------------------ TFTP (cliente de teste)
function tftpClient(port) {
  const sock = dgram.createSocket('udp4');
  const q = []; let waiter = null;
  sock.on('message', (m, r) => { if (waiter) { const w = waiter; waiter = null; w({ m, r }); } else q.push({ m, r }); });
  const next = (ms = 2000) => new Promise((res, rej) => {
    if (q.length) return res(q.shift());
    waiter = res; setTimeout(() => { if (waiter === res) { waiter = null; rej(new Error('sem resposta')); } }, ms);
  });
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const cs = (s) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
  const req = (op, file, opts = {}) => Buffer.concat([u16(op), cs(file), cs('octet'), ...Object.entries(opts).flatMap(([k, v]) => [cs(k), cs(v)])]);
  return {
    sock, next,
    send: (b, p, a = '127.0.0.1') => sock.send(b, p, a),
    u16, req, cs,
    async get(file, opts) {
      sock.send(req(1, file, opts), port, '127.0.0.1');
      const chunks = []; let blk = 1; let blksize = 512; let tsize = null;
      let { m, r } = await this.next();
      if (m.readUInt16BE(0) === 5) return { error: m.readUInt16BE(2), msg: m.subarray(4, m.length - 1).toString() };
      if (m.readUInt16BE(0) === 6) {
        const p = m.subarray(2).toString().split('\0');
        for (let i = 0; i + 1 < p.length; i += 2) { if (p[i] === 'blksize') blksize = +p[i + 1]; if (p[i] === 'tsize') tsize = +p[i + 1]; }
        sock.send(Buffer.concat([u16(4), u16(0)]), r.port, r.address);
        ({ m, r } = await this.next());
      }
      for (;;) {
        assert.equal(m.readUInt16BE(0), 3);
        assert.equal(m.readUInt16BE(2), blk);
        const d = m.subarray(4); chunks.push(d);
        sock.send(Buffer.concat([u16(4), u16(blk)]), r.port, r.address);
        if (d.length < blksize) break;
        blk++; ({ m, r } = await this.next());
      }
      return { data: Buffer.concat(chunks), tsize, blocks: blk };
    },
    async put(file, data, opts) {
      sock.send(req(2, file, opts), port, '127.0.0.1');
      let { m, r } = await this.next();
      if (m.readUInt16BE(0) === 5) return { error: m.readUInt16BE(2), msg: m.subarray(4, m.length - 1).toString() };
      let blksize = 512;
      if (m.readUInt16BE(0) === 6) { const p = m.subarray(2).toString().split('\0'); for (let i = 0; i + 1 < p.length; i += 2) if (p[i] === 'blksize') blksize = +p[i + 1]; } else assert.equal(m.readUInt16BE(0), 4);
      let off = 0; let blk = 1;
      for (;;) {
        const chunk = data.subarray(off, off + blksize); off += blksize;
        sock.send(Buffer.concat([u16(3), u16(blk), chunk]), r.port, r.address);
        ({ m, r } = await this.next());
        assert.equal(m.readUInt16BE(0), 4); assert.equal(m.readUInt16BE(2), blk);
        if (chunk.length < blksize) break;
        blk++;
      }
      return { ok: true };
    },
    close() { sock.close(); },
  };
}

async function tftpUp(over = {}) {
  const root = mk();
  const s = new TftpServer({ root, port: 0, host: '127.0.0.1', allowWrite: true, ...over });
  const logs = []; s.on('log', (l) => logs.push(l));
  const port = await s.start();
  return { s, root, port, logs, c: tftpClient(port) };
}

test('tftp: baixa arquivo pequeno, grande (várias voltas) e com tamanho múltiplo do bloco', async () => {
  const { s, root, port, c } = await tftpUp();
  try {
    const small = rnd(100); const big = rnd(512 * 70 + 33); const exact = rnd(1024);
    fs.writeFileSync(path.join(root, 'small.bin'), small);
    fs.writeFileSync(path.join(root, 'big.bin'), big);
    fs.writeFileSync(path.join(root, 'exact.bin'), exact);
    assert.deepEqual((await c.get('small.bin')).data, small);
    assert.deepEqual((await c.get('big.bin')).data, big);
    const e = await c.get('exact.bin');
    assert.deepEqual(e.data, exact);
    assert.equal(e.blocks, 3, 'bloco final vazio quando o tamanho é múltiplo do bloco');
    assert.ok(port > 0);
  } finally { c.close(); await s.stop(); }
});

test('tftp: opções blksize e tsize são negociadas (OACK)', async () => {
  const { s, root, c } = await tftpUp();
  try {
    const f = rnd(5000);
    fs.writeFileSync(path.join(root, 'fw.bin'), f);
    const r = await c.get('fw.bin', { blksize: '1428', tsize: '0' });
    assert.deepEqual(r.data, f);
    assert.equal(r.tsize, 5000);
    assert.equal(r.blocks, 4);
  } finally { c.close(); await s.stop(); }
});

test('tftp: recebe arquivo (com e sem opções) e grava inteiro, sem sobras .nt-partial', async () => {
  const { s, root, c, logs } = await tftpUp();
  try {
    const a = rnd(3000); const b = rnd(2048);
    assert.deepEqual(await c.put('backup.rsc', a), { ok: true });
    assert.deepEqual(await c.put('cfg.bin', b, { blksize: '1024', tsize: '2048' }), { ok: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(fs.readFileSync(path.join(root, 'backup.rsc')), a);
    assert.deepEqual(fs.readFileSync(path.join(root, 'cfg.bin')), b);
    assert.ok(!fs.readdirSync(root).some((x) => x.endsWith('.nt-partial')));
    assert.ok(logs.some((l) => /recebeu de .*backup\.rsc.*3000 bytes\) OK/.test(l)), JSON.stringify(logs));
  } finally { c.close(); await s.stop(); }
});

test('tftp: arquivo inexistente, fora da pasta e gravação desligada devolvem erro', async () => {
  const { s, root, c } = await tftpUp({ allowWrite: false });
  try {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
    assert.equal((await c.get('nao-existe.bin')).error, 1);
    const fora = await c.get('../../../../etc/hostname');
    assert.ok(fora.error === 1 || fora.error === 2, 'não entrega arquivo de fora');
    assert.equal((await c.put('novo.bin', Buffer.from('x'))).error, 2);
    assert.ok(!fs.existsSync(path.join(root, 'novo.bin')));
  } finally { c.close(); await s.stop(); }
});

test('tftp: atende duas transferências ao mesmo tempo', async () => {
  const { s, root, port } = await tftpUp();
  const c1 = tftpClient(port); const c2 = tftpClient(port);
  try {
    const f1 = rnd(512 * 20); const f2 = rnd(512 * 25 + 1);
    fs.writeFileSync(path.join(root, 'a'), f1); fs.writeFileSync(path.join(root, 'b'), f2);
    const [r1, r2] = await Promise.all([c1.get('a'), c2.get('b')]);
    assert.deepEqual(r1.data, f1); assert.deepEqual(r2.data, f2);
  } finally { c1.close(); c2.close(); await s.stop(); }
});

// ------------------------------------------------------------ FTP (cliente de teste)
function ftpClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = ''; const lines = []; let waiter = null;
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
      if (waiter) { const w = waiter; waiter = null; w(); }
    });
    sock.on('error', reject);
    const read = async () => { // lê uma resposta completa (inclui multilinha "211-")
      for (;;) {
        const l = lines.findIndex((x) => /^\d{3} /.test(x));
        if (l >= 0) { const out = lines.splice(0, l + 1); return out.join('\n'); }
        await new Promise((r, j) => { waiter = r; setTimeout(() => j(new Error('timeout ftp')), 3000).unref(); });
      }
    };
    const c = {
      sock, read,
      async cmd(line) { sock.write(line + '\r\n'); return read(); },
      async login(u, p) { await c.cmd('USER ' + u); return c.cmd('PASS ' + p); },
      async pasv() {
        const r = await c.cmd('EPSV'); const port2 = +/\|\|\|(\d+)\|/.exec(r)[1];
        return new Promise((res, rej) => { const d = net.connect(port2, '127.0.0.1', () => res(d)); d.on('error', rej); });
      },
      collect(d) { return new Promise((res) => { const ch = []; d.on('data', (x) => ch.push(x)); d.on('close', () => res(Buffer.concat(ch))); }); },
      async retr(name) {
        const d = await c.pasv(); const data = c.collect(d);
        sock.write('RETR ' + name + '\r\n');
        const first = await read();
        if (!first.startsWith('150')) { d.destroy(); return { reply: first }; }
        const done = await read();
        return { reply: done, data: await data };
      },
      async stor(name, buf) {
        const d = await c.pasv();
        sock.write('STOR ' + name + '\r\n');
        const first = await read();
        if (!first.startsWith('150')) { d.destroy(); return { reply: first }; }
        d.end(buf);
        return { reply: await read() };
      },
      close() { sock.destroy(); },
    };
    sock.once('data', () => {});
    read().then((hello) => { assert.match(hello, /^220/); resolve(c); }, reject);
  });
}

async function ftpUp(over = {}) {
  const root = mk();
  const s = new FtpServer({ root, port: 0, host: '127.0.0.1', allowWrite: true, user: 'noronha', password: 'segredo', pasvMin: 52000, pasvMax: 52999, ...over });
  const logs = []; s.on('log', (l) => logs.push(l));
  const port = await s.start();
  return { s, root, port, logs };
}

test('ftp: exige login, recusa senha errada e aceita a certa', async () => {
  const { s, port } = await ftpUp();
  const c = await ftpClient(port);
  try {
    assert.match(await c.cmd('PWD'), /^530/);
    await c.cmd('USER noronha');
    assert.match(await c.cmd('PASS errada'), /^530/);
    assert.match(await c.login('noronha', 'segredo'), /^230/);
    assert.match(await c.cmd('PWD'), /^257 "\/"/);
    assert.match(await c.cmd('SYST'), /^215/);
    assert.match(await c.cmd('FEAT'), /^211/);
  } finally { c.close(); await s.stop(); }
});

test('ftp: não sobe sem usuário/senha, a não ser que o anônimo esteja ligado', () => {
  assert.throws(() => new FtpServer({ root: mk(), user: '', password: '' }), /usu[aá]rio e senha/);
  assert.doesNotThrow(() => new FtpServer({ root: mk(), anonymous: true }));
});

test('ftp: baixa e envia arquivos (modo passivo), lista e confere tamanho', async () => {
  const { s, root, port } = await ftpUp();
  const c = await ftpClient(port);
  try {
    await c.login('noronha', 'segredo');
    const f = rnd(300000);
    fs.writeFileSync(path.join(root, 'firmware.npk'), f);
    const g = await c.retr('firmware.npk');
    assert.match(g.reply, /^226/);
    assert.deepEqual(g.data, f);
    assert.equal(await c.cmd('SIZE firmware.npk'), '213 300000');

    const up = rnd(123456);
    const r = await c.stor('config.rsc', up);
    assert.match(r.reply, /^226/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'config.rsc')), up);
    assert.ok(!fs.readdirSync(root).some((x) => x.endsWith('.nt-partial')));

    const d = await c.pasv(); const list = c.collect(d);
    await c.cmd('LIST');
    await c.read().catch(() => {}); // 226
    const txt = (await list).toString();
    assert.match(txt, /firmware\.npk/);
    assert.match(txt, /config\.rsc/);
  } finally { c.close(); await s.stop(); }
});

test('ftp: modo ativo (PORT) funciona e recusa endereço de outro host', async () => {
  const { s, root, port } = await ftpUp();
  const c = await ftpClient(port);
  try {
    await c.login('noronha', 'segredo');
    fs.writeFileSync(path.join(root, 'x.txt'), 'olá');
    assert.match(await c.cmd('PORT 10,9,8,7,4,1'), /^500/, 'bounce recusado');

    const got = await new Promise((resolve, reject) => {
      const ls = net.createServer((d) => { const ch = []; d.on('data', (x) => ch.push(x)); d.on('close', () => { ls.close(); resolve(Buffer.concat(ch).toString()); }); });
      ls.listen(0, '127.0.0.1', async () => {
        const p = ls.address().port;
        try {
          assert.match(await c.cmd(`PORT 127,0,0,1,${p >> 8},${p & 255}`), /^200/);
          c.sock.write('RETR x.txt\r\n'); await c.read(); await c.read();
        } catch (e) { reject(e); }
      });
    });
    assert.equal(got, 'olá');
  } finally { c.close(); await s.stop(); }
});

test('ftp: navegação presa à raiz (CWD/CDUP/.. e nomes com ../)', async () => {
  const { s, root, port } = await ftpUp();
  const c = await ftpClient(port);
  try {
    await c.login('noronha', 'segredo');
    fs.mkdirSync(path.join(root, 'sub'));
    assert.match(await c.cmd('CWD sub'), /^250/);
    assert.match(await c.cmd('PWD'), /"\/sub"/);
    await c.cmd('CDUP'); await c.cmd('CDUP'); await c.cmd('CWD ../../..');
    assert.match(await c.cmd('PWD'), /^257 "\/"/, 'nunca sai da raiz');
    assert.match(await c.cmd('SIZE ../../../../etc/hostname'), /^550/);
    const r = await c.retr('../../../../etc/hostname');
    assert.match(r.reply, /^550/);
  } finally { c.close(); await s.stop(); }
});

test('ftp: somente leitura bloqueia envio, apagar, criar e renomear', async () => {
  const { s, root, port } = await ftpUp({ allowWrite: false });
  const c = await ftpClient(port);
  try {
    await c.login('noronha', 'segredo');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    assert.match((await c.stor('b.txt', Buffer.from('b'))).reply, /^550/);
    assert.match(await c.cmd('DELE a.txt'), /^550/);
    assert.match(await c.cmd('MKD novo'), /^550/);
    assert.match(await c.cmd('RNFR a.txt'), /^550/);
    assert.ok(fs.existsSync(path.join(root, 'a.txt')) && !fs.existsSync(path.join(root, 'b.txt')));
  } finally { c.close(); await s.stop(); }
});

test('ftp: apagar, criar pasta e renomear quando a gravação está ligada', async () => {
  const { s, root, port } = await ftpUp();
  const c = await ftpClient(port);
  try {
    await c.login('noronha', 'segredo');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    assert.match(await c.cmd('MKD pasta'), /^257/);
    assert.match(await c.cmd('RNFR a.txt'), /^350/);
    assert.match(await c.cmd('RNTO pasta/b.txt'), /^250/);
    assert.ok(fs.existsSync(path.join(root, 'pasta', 'b.txt')));
    assert.match(await c.cmd('DELE pasta/b.txt'), /^250/);
    assert.match(await c.cmd('RMD pasta'), /^250/);
    assert.ok(!fs.existsSync(path.join(root, 'pasta')));
  } finally { c.close(); await s.stop(); }
});

test('ftp: bloqueia depois de 5 senhas erradas', async () => {
  const { s, port } = await ftpUp();
  const c = await ftpClient(port);
  try {
    await c.cmd('USER noronha');
    let last;
    for (let i = 0; i < 5; i++) last = await c.cmd('PASS x').catch(() => 'fechou');
    assert.match(last, /^421|fechou/);
  } finally { c.close(); await s.stop(); }
});

// ------------------------------------------------------------ gerenciador
test('gerenciador: salva configuração, liga/desliga, esconde a senha e explica porta ocupada', async () => {
  const dir = mk(); const root = mk();
  const m = new ServerManager({ configFile: path.join(dir, 'servers.json') });
  assert.equal(m.status().running.tftp, false);

  let st = await m.apply({ root, tftp: { enabled: true, port: 0 }, ftp: { enabled: true, port: 0, user: 'u', password: 'p' } });
  // porta 0 é inválida na tela e vira a padrão: troca por portas altas para o teste
  await m.stopAll();
  st = await m.apply({ root, tftp: { enabled: true, port: 46969 }, ftp: { enabled: true, port: 42121, user: 'u', password: 'p' } });
  assert.deepEqual(st.running, { tftp: true, ftp: true });
  assert.equal(st.config.ftp.password, undefined, 'a senha nunca volta para a tela');
  assert.equal(st.config.ftp.hasPassword, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'servers.json'), 'utf8')).ftp.password, 'p');

  // segundo gerenciador na mesma porta: erro claro, sem derrubar o primeiro
  const m2 = new ServerManager({ configFile: path.join(mk(), 's.json') });
  const st2 = await m2.apply({ root, tftp: { enabled: true, port: 46969 } });
  assert.match(st2.errors.tftp, /já está em uso/);

  // senha em branco na tela mantém a atual
  st = await m.apply({ ftp: { password: '' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'servers.json'), 'utf8')).ftp.password, 'p');

  st = await m.apply({ tftp: { enabled: false }, ftp: { enabled: false } });
  assert.deepEqual(st.running, { tftp: false, ftp: false });
  await m.stopAll(); await m2.stopAll();
});

test('gerenciador: sem pasta raiz ou com FTP sem senha, avisa em vez de ligar', async () => {
  const m = new ServerManager({ configFile: path.join(mk(), 's.json') });
  let st = await m.apply({ root: '', tftp: { enabled: true, port: 46970 } });
  assert.match(st.errors.tftp, /pasta raiz/);
  const root = mk();
  st = await m.apply({ root, tftp: { enabled: false }, ftp: { enabled: true, port: 42122, user: 'u', password: '' } });
  assert.match(st.errors.ftp, /usu[aá]rio e senha/);
  assert.equal(st.running.ftp, false);
  await m.stopAll();
});

test('gerenciador: portas e campos são saneados', () => {
  const c = sanitizeServers({ tftp: { port: 99999 }, ftp: { port: 'x', user: ' ana ' } });
  assert.equal(c.tftp.port, 69); assert.equal(c.ftp.port, 21); assert.equal(c.ftp.user, 'ana');
});
