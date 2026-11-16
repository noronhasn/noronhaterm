'use strict';
// SCP (cópia de arquivo por SSH) para equipamentos que não têm SFTP. Funciona sobre um canal `exec` já aberto
// ("scp -t <destino>" para enviar, "scp -f <origem>" para baixar). O SCP não lista pastas: é preciso saber o caminho.
const fs = require('fs');
const { once } = require('events');
const path = require('path');

// entre aspas simples para o shell remoto
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class Reader {
  constructor(stream) {
    this.s = stream;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.err = '';
    this.waiters = [];
    stream.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._wake(); });
    const end = () => { this.closed = true; this._wake(); };
    stream.on('end', end); stream.on('close', end);
    if (stream.stderr) stream.stderr.on('data', (d) => { this.err += d.toString(); });
  }

  _wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  async _until(ok) {
    while (!ok()) {
      if (this.closed) throw new Error(this.err.trim() || 'O equipamento encerrou a conexão SCP');
      await new Promise((r) => { this.waiters.push(r); });
    }
  }

  async bytes(n) {
    await this._until(() => this.buf.length >= n);
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return b;
  }

  async line() {
    await this._until(() => this.buf.includes(10));
    const i = this.buf.indexOf(10);
    const l = this.buf.subarray(0, i).toString();
    this.buf = this.buf.subarray(i + 1);
    return l;
  }

  async ack() {
    const b = (await this.bytes(1))[0];
    if (b === 0) return;
    const msg = (await this.line().catch(() => '')) || this.err.trim();
    throw new Error(msg || 'Erro do equipamento no SCP');
  }

  // entrega n bytes ao destino sem guardar tudo na memória
  async copy(n, sink) {
    let left = n;
    while (left > 0) {
      await this._until(() => this.buf.length > 0);
      const take = Math.min(left, this.buf.length);
      const chunk = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      if (!sink.write(chunk)) await once(sink, 'drain');
    }
  }
}

async function send(stream, data) { if (!stream.write(data)) await once(stream, 'drain'); }

// stream = canal de "scp -t <remote>"
async function upload(stream, localFile) {
  const r = new Reader(stream);
  const size = fs.statSync(localFile).size;
  const name = path.basename(localFile).replace(/[\r\n]/g, '_');
  await r.ack();
  await send(stream, `C0644 ${size} ${name}\n`);
  await r.ack();
  for await (const chunk of fs.createReadStream(localFile)) await send(stream, chunk);
  await send(stream, Buffer.from([0]));
  await r.ack();
  stream.end();
}

// stream = canal de "scp -f <remote>"
async function download(stream, localFile) {
  const r = new Reader(stream);
  await send(stream, Buffer.from([0]));
  for (;;) {
    const first = (await r.bytes(1))[0];
    const head = String.fromCharCode(first);
    if (first === 1 || first === 2) throw new Error((await r.line().catch(() => '')) || r.err.trim() || 'Erro do equipamento no SCP');
    const line = await r.line();
    if (head === 'T') { await send(stream, Buffer.from([0])); continue; }
    if (head !== 'C') throw new Error('Resposta inesperada do SCP (é uma pasta? use o caminho de um arquivo)');
    const m = /^(\d{4}) (\d+) /.exec(line);
    if (!m) throw new Error('Resposta inesperada do SCP');
    const size = Number(m[2]);
    await send(stream, Buffer.from([0]));
    const out = fs.createWriteStream(localFile);
    try {
      await r.copy(size, out);
      await r.ack();
    } finally { out.end(); await once(out, 'close').catch(() => {}); }
    await send(stream, Buffer.from([0]));
    stream.end();
    return size;
  }
}

module.exports = { upload, download, shq, Reader };
