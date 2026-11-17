'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMndp, discover } = require('../src/main/mndp');

const tlv = (t, v) => { const h = Buffer.alloc(4); h.writeUInt16BE(t, 0); h.writeUInt16BE(v.length, 2); return Buffer.concat([h, v]); };
const up = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pkt = () => Buffer.concat([Buffer.from([0, 1, 0, 1]),
  tlv(1, Buffer.from([4, 0xf4, 0x1c, 0x17, 0x47, 0x75])), tlv(5, Buffer.from('CPERT_TESTE')), tlv(7, Buffer.from('6.49.17 (stable)')),
  tlv(8, Buffer.from('MikroTik')), tlv(10, up(811)), tlv(12, Buffer.from('RB760iGS')), tlv(16, Buffer.from('ether1')), tlv(17, Buffer.from([186, 225, 141, 33]))]);

test('mndp: lê os campos do pacote', () => {
  const n = parseMndp(pkt());
  assert.equal(n.mac, '04:F4:1C:17:47:75'); assert.equal(n.identity, 'CPERT_TESTE'); assert.equal(n.version, '6.49.17 (stable)');
  assert.equal(n.board, 'RB760iGS'); assert.equal(n.uptime, 811); assert.equal(n.ip, '186.225.141.33'); assert.equal(n.iface, 'ether1');
});
test('mndp: lixo e pacote curto são ignorados', () => {
  assert.equal(parseMndp(Buffer.from([1, 2, 3])), null);
  assert.equal(parseMndp(Buffer.alloc(20)), null);
  assert.equal(parseMndp(Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from([0, 5, 0xff, 0xff, 1])])), null);
});
test('mndp: discover junta respostas sem repetir', async () => {
  const sent = [];
  const handlers = {};
  const fake = { on: (e, f) => { handlers[e] = f; }, bind: (_p, cb) => cb(), setBroadcast() {}, send: (b, p, t) => sent.push([p, t]), close() {} };
  const p = discover({ timeoutMs: 50, createSocket: () => fake, targets: ['10.0.0.255'] });
  setTimeout(() => { handlers.message(pkt()); handlers.message(pkt()); handlers.message(Buffer.from([1])); }, 10);
  const r = await p;
  assert.equal(r.length, 1); assert.equal(sent[0][0], 5678); assert.equal(sent[0][1], '10.0.0.255');
});
test('mndp: porta ocupada vira mensagem clara', async () => {
  const handlers = {};
  const fake = { on: (e, f) => { handlers[e] = f; }, bind: () => setTimeout(() => handlers.error(Object.assign(new Error('in use'), { code: 'EADDRINUSE' })), 5), close() {} };
  await assert.rejects(discover({ timeoutMs: 50, createSocket: () => fake, targets: [] }), /5678/);
});
