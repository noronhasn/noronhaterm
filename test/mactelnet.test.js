'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MacTelnetSession, parse, header, control, passwordHash, validMac, PT, CP } = require('../src/main/mactelnet');

const DEV = Buffer.from([0x04, 0xf4, 0x1c, 0x17, 0x47, 0x75]);
const KEY = Buffer.from('0123456789abcdef');

// equipamento de mentira: fala o protocolo do lado do servidor
function fakeNet({ goodPass = 'senha', silent = false } = {}) {
  const sockets = [];
  const mk = () => {
    const h = {};
    const sock = {
      on: (e, f) => { h[e] = f; }, bind: (_o, cb) => setImmediate(cb), setBroadcast() {}, close() { sock.closed = true; },
      send(buf) { if (!silent) setImmediate(() => device(sock, h, buf)); },
      push: (b) => h.message && h.message(b), sent: [],
    };
    sockets.push(sock); return sock;
  };
  const st = { outS: 0, inC: 0, got: [], authed: false };
  function device(sock, h, buf) {
    const p = parse(buf); if (!p) return;
    sock.sent.push(p);
    const reply = (ptype, counter, payload = Buffer.alloc(0)) => h.message(Buffer.concat([header(ptype, DEV, p.src, p.key, counter), payload]));
    if (p.ptype === PT.START) return reply(PT.ACK, 0);
    if (p.ptype === PT.DATA) {
      if (p.counter !== st.inC) return reply(PT.ACK, st.inC);
      st.inC += p.payload.length; reply(PT.ACK, st.inC);
      if (p.controls.length) {
        for (const c of p.controls) {
          if (c.type === CP.BEGINAUTH) { const pl = control(CP.KEY, KEY); reply(PT.DATA, st.outS, pl); st.outS += pl.length; }
          if (c.type === CP.PASSWORD) st.pass = c.data;
          if (c.type === CP.USERNAME) st.user = c.data.toString();
          if (c.type === CP.WIDTH) st.w = c.data.readUInt16LE(0);
        }
        if (st.pass) {
          st.authed = st.pass.equals(passwordHash(goodPass, KEY));
          const msg = Buffer.from(st.authed ? '[admin@RB] > ' : 'Login failed\r\n'); reply(PT.DATA, st.outS, msg); st.outS += msg.length;
          if (!st.authed) setImmediate(() => reply(PT.END, st.outS));
        }
      } else { st.got.push(p.payload.toString()); const echo = Buffer.from(p.payload); reply(PT.DATA, st.outS, echo); st.outS += echo.length; }
    }
  }
  return { create: mk, sockets, st };
}
const ifaces = () => [{ name: 'eth0', address: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:01', broadcast: '10.0.0.255' }];
const mkSession = (net, extra = {}) => {
  const out = []; const closed = [];
  const s = new MacTelnetSession({ host: { address: '04:F4:1C:17:47:75', identity: { username: 'admin', password: 'senha' } }, cols: 100, rows: 30,
    onData: (d) => out.push(d), onClose: (r) => closed.push(r), onStatus() {}, createSocket: net.create, ifaces, timing: { resend: 40, startTimeout: 300, keepalive: 100000 }, ...extra });
  return { s, out, closed };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('mactelnet: pacotes e senha MD5', () => {
  assert.ok(validMac('04:F4:1C:17:47:75')); assert.ok(!validMac('1.2.3.4'));
  const h = header(PT.DATA, DEV, DEV, 0x1234, 9);
  assert.equal(h.length, 22); assert.equal(h.readUInt16BE(14), 0x1234); assert.equal(h.readUInt32BE(18), 9);
  const pw = passwordHash('abc', KEY); assert.equal(pw.length, 17); assert.equal(pw[0], 0);
  const p = parse(Buffer.concat([h, control(CP.USERNAME, 'admin'), control(CP.ENDAUTH)]));
  assert.equal(p.controls.length, 2); assert.equal(p.controls[0].data.toString(), 'admin');
});

test('mactelnet: autentica, mostra o prompt e envia o que for digitado', async () => {
  const net = fakeNet(); const { s, out } = mkSession(net);
  await s.start(); await wait(60);
  assert.equal(net.st.user, 'admin'); assert.equal(net.st.w, 100); assert.ok(net.st.authed);
  assert.ok(out.join('').includes('[admin@RB] > '));
  s.write('ip address print\r'); await wait(60);
  assert.equal(net.st.got.join(''), 'ip address print\r');
  assert.ok(out.join('').endsWith('ip address print\r'));
  s.close(); assert.ok(net.sockets[0].closed);
});

test('mactelnet: senha errada mostra a mensagem e encerra', async () => {
  const net = fakeNet({ goodPass: 'outra' }); const { s, out, closed } = mkSession(net);
  await s.start(); await wait(100);
  assert.ok(out.join('').includes('Login failed')); assert.equal(closed.length, 1); s.close();
});

test('mactelnet: equipamento mudo dá erro claro', async () => {
  const net = fakeNet({ silent: true }); const { s } = mkSession(net);
  await assert.rejects(s.start(), /não respondeu/);
});

test('mactelnet: pede usuário e senha quando não vieram', async () => {
  const net = fakeNet(); const asked = [];
  const { s } = mkSession(net, { host: { address: '04:f4:1c:17:47:75' }, prompt: async (t, l, secret) => { asked.push(secret); return secret ? 'senha' : 'admin'; } });
  await s.start(); await wait(40);
  assert.deepEqual(asked, [false, true]); assert.ok(net.st.authed); s.close();
});

test('mactelnet: MAC inválido', async () => {
  const net = fakeNet(); const { s } = mkSession(net, { host: { address: '10.0.0.1' } });
  await assert.rejects(s.start(), /MAC inválido/);
});
