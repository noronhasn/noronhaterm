'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FtpServer } = require('../src/main/servers');
const { FtpClient, parseList, parseMlsd } = require('../src/main/ftpclient');

test('ftp: lê listas no formato Unix, DOS e MLSD', () => {
  const unix = parseList('total 8\r\ndrwxr-xr-x 2 root root 4096 Jan 02 10:00 backup\r\n-rw-r--r-- 1 root root 1234 Jan 02 2023 fw v1.bin\r\nlrwxrwxrwx 1 root root 4 Jan 02 10:00 atalho -> backup\r\n');
  assert.deepEqual(unix.map((x) => [x.name, x.isDir, x.size]), [['backup', true, 4096], ['fw v1.bin', false, 1234], ['atalho', true, 4]]);
  const dos = parseList('01-02-24  10:00AM       <DIR>          pasta\r\n01-02-24  10:00AM              2048 config.cfg\r\n');
  assert.deepEqual(dos.map((x) => [x.name, x.isDir, x.size]), [['pasta', true, 0], ['config.cfg', false, 2048]]);
  const m = parseMlsd('type=dir;modify=20240102100000; sub dir\r\ntype=file;size=10;modify=20240102100000; a.txt\r\ntype=cdir; .\r\n');
  assert.deepEqual(m.map((x) => [x.name, x.isDir, x.size]), [['sub dir', true, 0], ['a.txt', false, 10]]);
});

test('ftp cliente: conecta no servidor do NetDeck, lista, baixa e envia', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpc-'));
  fs.mkdirSync(path.join(root, 'backup'));
  fs.writeFileSync(path.join(root, 'backup', 'a.cfg'), 'conf-a');
  const grande = Buffer.alloc(300000, 7);
  fs.writeFileSync(path.join(root, 'fw.bin'), grande);
  const srv = new FtpServer({ root, port: 0, host: '127.0.0.1', allowWrite: true, user: 'u', password: 'p', pasvMin: 52000, pasvMax: 52100 });
  const port = await srv.start();
  t.after(() => srv.stop && srv.stop());
  const c = await new FtpClient().connect({ host: '127.0.0.1', port, user: 'u', password: 'p' });
  t.after(() => c.close());

  const raiz = await c.list('/');
  assert.deepEqual(raiz.items.map((i) => [i.name, i.isDir]), [['backup', true], ['fw.bin', false]]);
  assert.equal(raiz.items[1].size, 300000);
  const sub = await c.list('/backup');
  assert.equal(sub.path, '/backup');
  assert.deepEqual(sub.items.map((i) => i.name), ['a.cfg']);

  const dest = path.join(os.tmpdir(), 'ftpc-baixado-' + process.pid + '.bin');
  await c.download('/fw.bin', dest);
  assert.equal(fs.readFileSync(dest).equals(grande), true);

  const local = path.join(os.tmpdir(), 'enviado.txt');
  fs.writeFileSync(local, 'olá envio');
  await c.upload(local, '/backup');
  assert.equal(fs.readFileSync(path.join(root, 'backup', 'enviado.txt'), 'utf8'), 'olá envio');

  await assert.rejects(c.download('/nao-existe.bin', dest), /./);
  await assert.rejects(c.list('/pasta-que-nao-existe'), /./);
});

test('ftp cliente: senha errada dá mensagem clara', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpc-'));
  const srv = new FtpServer({ root, port: 0, host: '127.0.0.1', user: 'u', password: 'p', pasvMin: 52200, pasvMax: 52300 });
  const port = await srv.start();
  t.after(() => srv.stop && srv.stop());
  await assert.rejects(new FtpClient().connect({ host: '127.0.0.1', port, user: 'u', password: 'errada' }), /incorretos/);
});
