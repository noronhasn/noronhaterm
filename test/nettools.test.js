'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolSession, plan, checkTarget } = require('../src/main/nettools');

test('nettools: monta os comandos certos em cada sistema', () => {
  assert.deepEqual(plan('ping', '10.0.0.1', 'win32'), { cmd: 'ping', args: ['-t', '10.0.0.1'] });
  assert.deepEqual(plan('ping', 'a.com', 'linux'), { cmd: 'ping', args: ['a.com'] });
  assert.equal(plan('trace', '8.8.8.8', 'win32').cmd, 'tracert');
  assert.deepEqual(plan('trace', '8.8.8.8', 'linux', (c) => c === 'traceroute').args, ['-n', '8.8.8.8']);
  assert.equal(plan('trace', '8.8.8.8', 'linux', (c) => c === 'tracepath').cmd, 'tracepath');
  assert.equal(plan('mtr', '8.8.8.8', 'win32').cmd, 'pathping');
  assert.equal(plan('mtr', '8.8.8.8', 'linux', (c) => c === 'mtr').cmd, 'mtr');
});

test('nettools: sem o programa, explica o que instalar', () => {
  assert.throws(() => plan('trace', 'x.com', 'linux', () => false), /sudo apt install traceroute/);
  assert.throws(() => plan('mtr', 'x.com', 'linux', () => false), /mtr-tiny/);
  assert.throws(() => plan('mtr', 'x.com', 'darwin', () => false), /brew install mtr/);
  assert.throws(() => plan('nmap', 'x.com', 'linux'), /desconhecida/);
});

test('nettools: destino com lixo ou opção é recusado', () => {
  for (const t of ['', '-c 1000', '1.1.1.1; rm -rf /', 'a b', '$(id)', '../x', undefined]) assert.throws(() => checkTarget(t), /inválido/);
  for (const t of ['1.1.1.1', 'sw-01.empresa.com.br', '2001:db8::1']) assert.equal(checkTarget(t), t);
});

test('nettools: sessão mostra a saída com CRLF, avisa o fim e Ctrl+C interrompe', async () => {
  const out = [];
  let closed = null;
  const s = new ToolSession({
    host: { tool: 'ping', address: '127.0.0.1' },
    planner: () => ({ cmd: process.execPath, args: ['-e', "console.log('linha1');console.log('linha2')"] }),
    onData: (d) => out.push(d), onStatus: () => {}, onClose: (r) => { closed = r; },
  });
  await s.start();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(out.join(''), 'linha1\r\nlinha2\r\n');
  assert.match(closed, /Concluído/);

  let c2 = null;
  const s2 = new ToolSession({
    host: { tool: 'ping', address: '127.0.0.1' },
    planner: () => ({ cmd: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }),
    onData: () => {}, onStatus: () => {}, onClose: (r) => { c2 = r; },
  });
  await s2.start();
  s2.write('\x03');
  await new Promise((r) => setTimeout(r, 600));
  assert.match(c2, /Interrompido/);

  const s3 = new ToolSession({ host: { tool: 'ping', address: 'x' }, planner: () => ({ cmd: 'programa-que-nao-existe-xyz', args: [] }), onData: () => {}, onStatus: () => {}, onClose: () => {} });
  await assert.rejects(s3.start(), /não encontrado/);
});
