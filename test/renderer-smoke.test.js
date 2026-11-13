'use strict';
// Executa o renderer.js REAL contra um DOM/xterm de mentira e simula o uso (abas, divisões, arrastar e soltar).
// Não prova que o visual está certo, mas pega erros de lógica/JS (variável inexistente, função errada etc.).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function setup() {
  const created = [];
  const elements = {};
  const mkEl = (tag) => {
    const handlers = {};
    const o = {
      tag, style: {}, className: '', value: '', textContent: '', hidden: false, nodeType: 1, children: [], _handlers: handlers,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener(t, f) { (handlers[t] ||= []).push(f); },
      append(...k) { this.children.push(...k); }, replaceChildren() {}, remove() {}, setAttribute() {}, focus() {}, contains: () => true, showModal() {}, close() {}, open: false,
      querySelector: () => mkEl('q'), querySelectorAll: () => [], closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    };
    created.push(o);
    return o;
  };
  const byId = (sel) => (elements[sel] ||= mkEl(sel));

  const log = { open: [], close: [], writes: [] };
  let uuid = 0;
  const events = {};
  const hostRow = { id: 'h1', name: 'sw1', protocol: 'ssh', folderId: null, address: '1.1.1.1', tags: [] };
  const api = {
    version: async () => '9.9.9',
    users: async () => ['u'],
    unlock: async () => ({ folders: [], hosts: [hostRow], identities: [], keys: [] }),
    open: async (o) => { log.open.push(o); return { id: o.id, snapshot: null }; },
    close: (id) => log.close.push(id),
    input: () => {}, resize: () => {}, lock: async () => {},
    on: (ch, cb) => { events[ch] = cb; },
    backupGet: async () => { log.backup = (log.backup || 0) + 1; return { enabled: false, folder: '', intervalMinutes: 360, keep: 20, lastAt: null, lastError: null, lastFiles: 0 }; },
    backupSet: async (p) => ({ ...p, running: !!p.enabled }), backupPickFolder: async () => '/tmp/x', backupPickFile: async () => null, backupRestore: async () => ({ snapshot: {}, saved: null }), backupNow: async () => ({ files: 1, state: { lastAt: new Date().toISOString(), lastFiles: 1 } }),
    serversStatus: async () => { log.servers = (log.servers || 0) + 1; return { config: { root: '', tftp: { enabled: false, port: 69, allowWrite: true }, ftp: { enabled: false, port: 21, allowWrite: true, user: 'noronha', anonymous: false, hasPassword: false } }, running: { tftp: false, ftp: false }, errors: { tftp: null, ftp: null }, logs: [] }; },
    serversApply: async () => ({}), serversPickRoot: async () => '/tmp/r', serversAddresses: async () => ['192.168.0.10'],
  };

  class Terminal {
    constructor() { this.cols = 80; this.rows = 24; }
    loadAddon() {} open() { this.opened = true; } onData() {} onResize() {} attachCustomKeyEventHandler() {}
    writeln(m) { log.writes.push(m); } write() {} dispose() { this.disposed = true; } focus() {}
  }
  const winListeners = {};
  const ctx = {
    document: {
      querySelector: byId, querySelectorAll: () => [], getElementById: byId, createElement: mkEl,
      createTextNode: (t) => ({ nodeType: 3, t }), body: mkEl('body'), addEventListener() {},
    },
    console, JSON, Map, Set, Promise, Object, Array, String, Number, Error, Math, Date, clearTimeout,
    // timers do renderer (bloqueio por inatividade, toast) não podem segurar o processo de teste
    setTimeout: (f, ms) => { const h = setTimeout(f, ms); if (h.unref) h.unref(); return h; },
    localStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => 'aaaaaaaa-0000-0000-0000-' + String(++uuid).padStart(12, '0') },
    ResizeObserver: class { observe() {} },
    navigator: {}, requestAnimationFrame: (f) => f(),
    Terminal, FitAddon: { FitAddon: class { fit() {} } },
  };
  ctx.window = ctx;
  ctx.addEventListener = (t, f) => { (winListeners[t] ||= []).push(f); };
  Object.defineProperty(ctx, 'api', { value: api, configurable: false, writable: false, enumerable: true });
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  vm.runInContext(fs.readFileSync(path.join(dir, 'layout.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8'), ctx);
  return { ctx, byId, created, log, events, winListeners };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const ev = (o = {}) => ({ preventDefault() {}, stopPropagation() {}, ...o });

test('renderer: abas, divisões, soltar host, fechar painéis e reconectar sem erro', async () => {
  const errors = [];
  const onRej = (e) => errors.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const t = setup();
    await tick();

    // desbloquear
    t.byId('#lockUser').value = 'u';
    t.byId('#lockPass').value = 'senha-qualquer';
    await t.byId('#lockForm')._handlers.submit[0](ev());
    assert.equal(t.byId('#lock').hidden, true, 'tela de bloqueio some');

    // conexão rápida -> 1ª aba
    t.byId('#quickInput').value = 'root@10.0.0.1';
    await t.byId('#quick')._handlers.submit[0](ev());
    await tick();
    assert.equal(t.log.open.length, 1);
    assert.deepEqual(t.log.open[0].adhoc && t.log.open[0].adhoc.address, '10.0.0.1');

    // dividir lado a lado e empilhado repete a conexão do painel ativo
    const kd = t.winListeners.keydown.at(-1);
    kd(ev({ ctrlKey: true, shiftKey: true, code: 'KeyD' }));
    await tick();
    kd(ev({ ctrlKey: true, shiftKey: true, code: 'KeyE' }));
    await tick();
    assert.equal(t.log.open.length, 3, 'três conexões abertas na mesma aba');
    assert.equal(new Set(t.log.open.map((o) => o.id)).size, 3, 'ids de sessão únicos');
    t.byId('#btnSplitH').onclick(); // o botão abre a escolha de host (diálogo), sem erro
    await tick();

    // soltar um host da lista fora de qualquer painel -> nova aba
    const drop = t.byId('#terms')._handlers.drop[0];
    const dt = { getData: () => JSON.stringify({ t: 'host', id: 'h1' }), types: ['text/plain'] };
    drop(ev({ dataTransfer: dt, target: { closest: () => null }, clientX: 0, clientY: 0 }));
    await tick();
    assert.equal(t.log.open.length, 4);
    assert.equal(t.log.open[3].hostId, 'h1');

    // soltar na borda direita de um painel -> divide
    const wrap = t.created.filter((e) => /^pane( |$)/.test(e.className)).pop();
    assert.ok(wrap, 'existe um painel renderizado');
    drop(ev({ dataTransfer: dt, target: { closest: () => wrap }, clientX: 990, clientY: 300 }));
    await tick();
    assert.equal(t.log.open.length, 5, 'soltar na borda abriu mais um painel');

    // dragover mostra a dica
    t.byId('#terms')._handlers.dragover[0](ev({ dataTransfer: { types: ['text/plain'] }, target: { closest: () => wrap }, clientX: 990, clientY: 300 }));

    // soltar algo que não é host é ignorado
    drop(ev({ dataTransfer: { getData: () => 'lixo' }, target: { closest: () => null } }));
    drop(ev({ dataTransfer: { getData: () => JSON.stringify({ t: 'folder', id: 'x' }) }, target: { closest: () => null } }));
    assert.equal(t.log.open.length, 5);

    // evento de encerramento + reconectar
    const firstSid = t.log.open[0].id;
    t.events['session:close'](firstSid, 'Conexão encerrada');
    t.events['session:status'](t.log.open[4].id, 'ok');
    t.events['session:data'](t.log.open[4].id, new Uint8Array([65]));
    t.byId('#btnReconnect').onclick();
    await tick();
    assert.equal(t.log.open.length, 6, 'reconectar abriu nova sessão');

    // multi-exec liga e desliga
    t.byId('#btnBroadcast').onclick();
    t.byId('#btnBroadcast').onclick();

    // Ctrl+Shift+D / E dividem; Ctrl+Shift+W fecha painéis até esvaziar tudo
    const keydown = t.winListeners.keydown.at(-1); // o último é o dos atalhos (o primeiro é o do bloqueio por inatividade)
    keydown(ev({ ctrlKey: true, shiftKey: true, code: 'KeyD' }));
    keydown(ev({ ctrlKey: true, shiftKey: true, code: 'KeyE' }));
    await tick();
    assert.equal(t.log.open.length, 8);
    keydown(ev({ ctrlKey: true, code: 'Tab' }));
    for (let i = 0; i < 20; i++) keydown(ev({ ctrlKey: true, shiftKey: true, code: 'KeyW' }));
    assert.ok(t.log.close.length >= 8, 'todas as sessões foram fechadas: ' + t.log.close.length);
    assert.equal(t.byId('#empty').hidden, false, 'mostra o estado vazio quando não há abas');

    // depois de fechar tudo, dividir sem conexão apenas avisa (não quebra)
    t.byId('#btnSplitH').onclick();
  } finally {
    process.off('unhandledRejection', onRej);
  }
  assert.deepEqual(errors.map(String), [], 'nenhuma promessa rejeitada sem tratamento');
});

test('renderer: botões da barra superior ignoram clique de teclado (Enter no terminal não reconecta)', async () => {
  const t = setup();
  await tick();
  const bar = t.byId('.topbar');
  const btn = { closest: (sel) => (sel === 'button' ? {} : null) };
  const notBtn = { closest: () => null };
  let prevented = 0; let stopped = 0;
  const e = (target, detail) => ({ target, detail, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  // mouse: não rouba o foco do terminal
  bar._handlers.mousedown[0](e(btn, 1));
  assert.equal(prevented, 1, 'mousedown em botão não pode focar o botão');
  bar._handlers.mousedown[0](e(notBtn, 1));
  assert.equal(prevented, 1, 'mousedown fora de botão segue normal (campo de conexão rápida)');
  // clique de teclado (detail 0) é bloqueado; clique de mouse passa
  bar._handlers.click[0](e(btn, 0));
  assert.equal(stopped, 1, 'Enter/Espaço em botão focado é bloqueado');
  bar._handlers.click[0](e(btn, 1));
  assert.equal(stopped, 1, 'clique de mouse não é bloqueado');
  bar._handlers.click[0](e(notBtn, 0));
  assert.equal(stopped, 1);
});

test('renderer: botão de fonte abre o diálogo sem erro e o painel usa a fonte salva', async () => {
  const errors = [];
  const onRej = (e) => errors.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const t = setup();
    await tick();
    t.byId('#lockUser').value = 'u'; t.byId('#lockPass').value = 'senha-qualquer';
    await t.byId('#lockForm')._handlers.submit[0](ev());
    t.byId('#quickInput').value = 'root@10.0.0.1';
    await t.byId('#quick')._handlers.submit[0](ev());
    await tick();
    t.byId('#btnFont').onclick();
    await tick();
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(errors.map(String), []);
});

test('renderer: novo host abre o formulário simplificado sem erro', async () => {
  const errors = [];
  const onRej = (e) => errors.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const t = setup();
    await tick();
    t.byId('#lockUser').value = 'u'; t.byId('#lockPass').value = 'senha-qualquer';
    await t.byId('#lockForm')._handlers.submit[0](ev());
    await tick();
    const b = t.byId('#btnNewHost');
    if (b.onclick) { b.onclick(); await tick(); }
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(errors.map(String), []);
});

function findButton(t, label) {
  return t.created.find((e) => e.tag === 'button' && e.children.some((c) => c && c.nodeType === 3 && c.t === label));
}

test('renderer: telas de backup automático e servidores TFTP/FTP abrem pelo menu sem erro', async () => {
  const errors = [];
  const onRej = (e) => errors.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const t = setup();
    await tick();
    t.byId('#lockUser').value = 'u'; t.byId('#lockPass').value = 'senha-qualquer';
    await t.byId('#lockForm')._handlers.submit[0](ev());
    await tick();
    t.byId('#btnMore').onclick();
    await tick();
    const bk = findButton(t, 'Backup automático do cofre…');
    const sv = findButton(t, 'Servidores TFTP / FTP…');
    assert.ok(bk, 'menu tem o item de backup');
    assert.ok(sv, 'menu tem o item de servidores');
    bk._handlers.click[0]();
    await tick();
    assert.equal(t.log.backup, 1, 'a tela de backup leu a configuração');
    sv._handlers.click[0]();
    await tick();
    assert.equal(t.log.servers, 1, 'a tela de servidores leu o estado');
    assert.ok(findButton(t, 'Fazer backup agora') && findButton(t, 'Salvar e aplicar'));
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(errors.map(String), []);
});
