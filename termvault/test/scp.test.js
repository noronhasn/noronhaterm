'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Duplex } = require('stream');
const { upload, download, shq } = require('../src/main/scp');

// canal de mentira: o que o cliente escreve vai para `onClient`; o que o servidor empurra chega no cliente
function channel(onClient) {
  const toClient = new PassThrough();
  const ch = new Duplex({
    read() {},
    write(chunk, _e, cb) { onClient(chunk); cb(); },
    final(cb) { toClient.end(); cb(); },
  });
  toClient.on('data', (d) => ch.push(d));
  toClient.on('end', () => ch.push(null));
  ch.stderr = new PassThrough();
  return { ch, server: toClient };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scp-'));

test('scp: aspas no caminho remoto', () => {
  assert.equal(shq('flash:/a b.cfg'), "'flash:/a b.cfg'");
  assert.equal(shq("x'; rm -rf /"), `'x'\\''; rm -rf /'`);
});

test('scp upload: segue o protocolo (C0644, ack, dados, ack final)', async () => {
  const dir = tmp();
  const f = path.join(dir, 'config.cfg');
  const conteudo = Buffer.from('hostname SW1\n'.repeat(5000));
  fs.writeFileSync(f, conteudo);
  let recebido = Buffer.alloc(0);
  let cabecalho = null;
  let estado = 'cab';
  const { ch, server } = channel((d) => {
    recebido = Buffer.concat([recebido, d]);
    if (estado === 'cab' && recebido.includes(10)) {
      const i = recebido.indexOf(10);
      cabecalho = recebido.subarray(0, i).toString();
      recebido = recebido.subarray(i + 1);
      estado = 'dados';
      server.write(Buffer.from([0])); // ack do cabeçalho
    }
    if (estado === 'dados' && recebido.length >= conteudo.length + 1) { estado = 'fim'; server.write(Buffer.from([0])); }
  });
  server.write(Buffer.from([0])); // ack inicial
  await upload(ch, f);
  assert.equal(cabecalho, `C0644 ${conteudo.length} config.cfg`);
  assert.equal(recebido.subarray(0, conteudo.length).equals(conteudo), true);
  assert.equal(recebido[conteudo.length], 0);
});

test('scp upload: erro do equipamento vira mensagem', async () => {
  const f = path.join(tmp(), 'a.bin');
  fs.writeFileSync(f, 'x');
  const { ch, server } = channel(() => {});
  server.write(Buffer.concat([Buffer.from([1]), Buffer.from('scp: /flash: Permission denied\n')]));
  await assert.rejects(upload(ch, f), /Permission denied/);
});

test('scp download: recebe o arquivo em pedaços', async () => {
  const dados = Buffer.from('abc123\n'.repeat(20000));
  const out = path.join(tmp(), 'baixado.txt');
  let n = 0;
  const { ch, server } = channel(() => {
    n += 1;
    if (n === 1) { // cliente mandou o 0 inicial: servidor responde com o cabeçalho
      server.write(`C0644 ${dados.length} x.txt\n`);
    } else if (n === 2) { // ack do cabeçalho: manda os dados em pedaços e o 0 final
      for (let i = 0; i < dados.length; i += 7000) server.write(dados.subarray(i, i + 7000));
      server.write(Buffer.from([0]));
    }
  });
  const size = await download(ch, out);
  assert.equal(size, dados.length);
  assert.equal(fs.readFileSync(out).equals(dados), true);
});

test('scp download: arquivo inexistente mostra o erro do equipamento', async () => {
  const out = path.join(tmp(), 'x');
  const { ch, server } = channel(() => {
    server.write(Buffer.concat([Buffer.from([1]), Buffer.from('scp: nao existe: No such file or directory\n')]));
  });
  await assert.rejects(download(ch, out), /No such file/);
});
