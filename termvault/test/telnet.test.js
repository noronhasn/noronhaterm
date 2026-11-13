'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { TelnetParser, TelnetSession, escapeIac } = require('../src/main/telnet');

const mk = () => {
  const data = []; const replies = []; const subs = [];
  const p = new TelnetParser({ onData: (d) => data.push(...d), onReply: (b) => replies.push([...b]), onSubnegotiation: (s) => subs.push(s) });
  return { p, data, replies, subs };
};

test('telnet: separa texto de comandos e responde à negociação', () => {
  const { p, data, replies } = mk();
  // "ola" + IAC WILL ECHO + IAC DO TTYPE + IAC DO LINEMODE(34) + "!"
  p.feed(Buffer.from([...Buffer.from('ola'), 255, 251, 1, 255, 253, 24, 255, 253, 34, ...Buffer.from('!')]));
  assert.equal(Buffer.from(data).toString(), 'ola!');
  assert.deepEqual(replies, [[255, 253, 1], [255, 251, 24], [255, 252, 34]]); // DO ECHO, WILL TTYPE, WONT LINEMODE
});

test('telnet: comando dividido entre pedaços e IAC IAC literal', () => {
  const { p, data, replies } = mk();
  p.feed(Buffer.from([65, 255]));
  p.feed(Buffer.from([251]));
  p.feed(Buffer.from([3, 66, 255, 255, 67]));
  assert.deepEqual(data, [65, 66, 255, 67]);
  assert.deepEqual(replies, [[255, 253, 3]]);
});

test('telnet: subnegociação TTYPE SEND é entregue', () => {
  const { p, subs } = mk();
  p.feed(Buffer.from([255, 250, 24, 1, 255, 240]));
  assert.deepEqual(subs, [[24, 1]]);
});

test('telnet: não responde duas vezes à mesma opção (evita loop de negociação)', () => {
  const { p, replies } = mk();
  p.feed(Buffer.from([255, 251, 1, 255, 251, 1]));
  assert.equal(replies.length, 1);
});

test('telnet: escapeIac duplica 0xFF', () => {
  assert.deepEqual([...escapeIac(Buffer.from([1, 255, 2]))], [1, 255, 255, 2]);
});

test('telnet: sessão real contra servidor local (eco + CRLF + comando inicial)', async () => {
  const received = [];
  const srv = net.createServer((s) => {
    s.write(Buffer.from([255, 251, 1])); // WILL ECHO
    s.write('login: ');
    s.on('data', (d) => { received.push(...d); s.write(d); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const out = []; let status = '';
  const sess = new TelnetSession({
    host: { address: '127.0.0.1', port: srv.address().port, telnetEnter: 'crlf', startupCommands: ['show ver'] },
    cols: 100, rows: 30, onData: (d) => out.push(...d), onClose: () => {}, onStatus: (m) => { status = m; },
  });
  await sess.start();
  await new Promise((r) => setTimeout(r, 100));
  sess.write('admin\r');
  await new Promise((r) => setTimeout(r, 500));
  sess.close(); srv.close();
  assert.match(status, /conectado/);
  assert.match(Buffer.from(out).toString(), /login: /);
  const rx = Buffer.from(received);
  assert.ok(rx.includes(Buffer.from('admin\r\n')), 'Enter vira CRLF');
  assert.ok(rx.includes(Buffer.from('show ver')), 'comando inicial enviado');
  assert.ok(rx.includes(Buffer.from([255, 253, 1])), 'respondeu DO ECHO ao WILL ECHO');
});
