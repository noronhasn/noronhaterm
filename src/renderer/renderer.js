'use strict';
/* global Terminal, FitAddon */
// Interface: bloqueio, árvore de pastas/hosts, abas de terminal, User SSH (identidades), SFTP.
// Tudo dentro de uma função: `const api` no escopo global conflita com window.api criado pelo preload
// (propriedade não configurável) e causava "Identifier 'api' has already been declared".
(() => {

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);

// qualquer erro vira texto visível na tela de bloqueio (e no terminal do app)
const showFatal = (msg) => { const el = document.getElementById('lockError'); if (el) el.textContent = 'Erro: ' + msg; };
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
if (!api) { showFatal('a ponte com o aplicativo (preload) não carregou'); throw new Error('preload não carregou'); }

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

function sel(options, value, attrs) {
  const s = h('select', attrs, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value ?? options[0][0];
  return s;
}

const MOBILE = !!api.mobile; // app Android: mesma tela, sem serial/SFTP/servidores/log
const field = (label, input) => h('label', { class: 'field' }, label, input);
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

let toastTimer;
function toast(msg, ok) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? ' ok' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ok ? 2500 : 6000);
}
const errMsg = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function dialog(title, body, actions = [], { onClose } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog');
    const close = (v) => { if (dlg.open) dlg.close(); dlg.remove(); if (onClose) onClose(); resolve(v); refocusTerminal(); };
    const foot = h('div', { class: 'dlg-foot' }, actions.map((a) => h('button', {
      class: a.cls || '',
      type: 'button',
      onclick: async () => {
        try { await a.onClick(close); } catch (e) { toast(errMsg(e)); }
      },
    }, a.label)));
    dlg.append(...(title ? [h('div', { class: 'dlg-head' }, title)] : []), h('div', { class: 'dlg-body' }, body), foot);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    dlg.addEventListener('keydown', (e) => { // Enter num campo de texto aciona o botão principal (ex.: OK da senha)
      if (e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT' || e.target.type === 'file') return;
      const primary = foot.querySelector('button.primary');
      if (primary) { e.preventDefault(); primary.click(); }
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
  });
}

// depois de fechar um diálogo, o teclado volta para o terminal ativo (e não para um botão qualquer)
function refocusTerminal() {
  requestAnimationFrame(() => {
    if (activePane && !document.querySelector('dialog[open]') && !$('#app').hidden) activePane.term.focus();
  });
}

const cancelBtn = { label: 'Cancelar', onClick: (c) => c(undefined) };
const confirmBox = (msg, okLabel = 'Confirmar', danger = true) =>
  dialog('Confirmação', h('div', {}, msg), [cancelBtn, { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: (c) => c(true) }]).then(Boolean);

// ---------------------------------------------------------------- estado
let S = null; // snapshot (sem segredos)
let currentUser = null;
const collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));
const panes = new Map(); // sessionId -> painel (um terminal com sua conexão)
const tabList = []; // abas; cada uma tem uma árvore de painéis
let activeTab = null;
let activePane = null; // painel com foco, sempre dentro da aba ativa
let broadcast = false;

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
const folderById = (id) => S.folders.find((f) => f.id === id);
const hostById = (id) => S.hosts.find((x) => x.id === id);

async function call(method, ...args) {
  const r = await api.call(method, ...args);
  S = r.snapshot;
  renderTree();
  return r.result;
}

function descendantIds(id) {
  const out = [];
  const walk = (p) => S.folders.filter((f) => f.parentId === p).forEach((f) => { out.push(f.id); walk(f.id); });
  walk(id);
  return out;
}

function folderOptions(excludeId) {
  const skip = new Set(excludeId ? [excludeId, ...descendantIds(excludeId)] : []);
  const out = [['', '(raiz)']];
  const walk = (p, depth) => S.folders.filter((f) => f.parentId === p && !skip.has(f.id)).sort(byOrder).forEach((f) => {
    out.push([f.id, '  '.repeat(depth) + f.name]);
    walk(f.id, depth + 1);
  });
  walk(null, 0);
  return out;
}

const identityOptions = (first) => [['', first], ...S.identities.filter((i) => !i.ownerHostId).map((i) => [i.id, `${i.name}${i.username ? ' (' + i.username + ')' : ''}`])];
const hostOptions = (first, excludeId) => [['', first], ...S.hosts.filter((x) => x.id !== excludeId && x.protocol === 'ssh').map((x) => [x.id, x.name])];

// ---------------------------------------------------------------- bloqueio
let creating = false;
async function refreshUsers() {
  const users = await api.users();
  const s = $('#lockUser');
  s.replaceChildren(...users.map((u) => h('option', { value: u }, u)));
  if (!users.length) setCreating(true);
  $('#lockToggle').hidden = !users.length;
  paintRemember();
}

function setCreating(v) {
  creating = v;
  $('#lockUser').hidden = v;
  $('#lockNewUser').hidden = !v;
  $('#lockPass2Wrap').hidden = !v;
  $('#lockSubmit').textContent = v ? 'Criar cofre' : 'Desbloquear';
  $('#lockToggle').textContent = v ? 'Já tenho usuário' : 'Criar novo usuário';
  $('#lockHint').textContent = v ? 'A senha protege todos os seus hosts e senhas. Se você a perder, não há como recuperar.' : 'Escolha o usuário e digite a senha.';
  $('#lockError').textContent = '';
}

$('#lockToggle').onclick = () => setCreating(!creating);

let noticesShown = false;
function enterApp(user) {
  if (currentUser && currentUser !== user) closeAllTabs();
  currentUser = user;
  $('#lockPass').value = ''; $('#lockPass2').value = '';
  $('#lock').hidden = true;
  $('#app').hidden = false;
  $('#whoami').textContent = '👤 ' + user;
  renderTree();
  resetIdle();
  activeTab && activate(activeTab);
  if (!noticesShown) { noticesShown = true; setTimeout(startupNotices, 900); }
}
async function paintRemember() { // mostra a caixa "Lembrar" só quando o sistema consegue guardar a senha com segurança
  const w = $('#lockRememberWrap');
  try {
    const ok = !MOBILE && api.rememberCan && await api.rememberCan();
    w.hidden = !ok;
    if (ok) $('#lockRemember').checked = !!(await api.rememberHas($('#lockUser').value || $('#lockNewUser').value.trim()));
  } catch { w.hidden = true; }
}
$('#lockUser').addEventListener('change', paintRemember);

$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#lockError');
  err.textContent = '';
  const pass = $('#lockPass').value;
  try {
    let user;
    if (creating) {
      user = $('#lockNewUser').value.trim();
      if (pass !== $('#lockPass2').value) throw new Error('As senhas não conferem');
      S = await api.createVault(user, pass);
    } else {
      user = $('#lockUser').value;
      S = await api.unlock(user, pass);
    }
    if (!MOBILE && api.rememberSet) await api.rememberSet(user, pass, $('#lockRemember').checked);
    rememberedNow = !MOBILE && !!$('#lockRemember').checked && !$('#lockRememberWrap').hidden;
    enterApp(user);
  } catch (ex) {
    err.textContent = errMsg(ex);
  }
});

async function doLock() {
  await api.lock();
  S = null;
  $('#app').hidden = true;
  $('#lock').hidden = false;
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  setCreating(false);
  await refreshUsers();
  $('#lockPass').focus();
}
$('#btnLock').onclick = doLock;

let idleTimer;
let rememberedNow = false; // com "Lembrar neste computador" ligado o app não bloqueia sozinho
// minutos sem uso até bloquear o cofre (0 = nunca); escolhido no botão ⏱ e lembrado neste computador
function idleMinutes() {
  let v = 60;
  try { const n = Number(localStorage.getItem('idleMinutes')); if (localStorage.getItem('idleMinutes') !== null && Number.isFinite(n) && n >= 0) v = n; } catch { /* usa padrão */ }
  return v;
}
function resetIdle() {
  clearTimeout(idleTimer);
  const m = idleMinutes();
  if (S && m > 0 && !rememberedNow) idleTimer = setTimeout(doLock, m * 60 * 1000);
}
$('#btnIdle').onclick = async () => {
  const input = h('input', { type: 'number', min: '0', max: '1440', step: '1' });
  input.value = String(idleMinutes());
  await dialog('Bloqueio automático', [
    field('Bloquear o cofre após quantos minutos sem uso? (0 = nunca bloquear)', input),
    h('div', { class: 'muted' }, 'Isto só afeta o cofre do NetDeck. As sessões abertas continuam conectadas; quem derruba por inatividade é o próprio equipamento.'),
  ], [cancelBtn, {
    label: 'Salvar', cls: 'primary',
    onClick: async (close) => {
      const n = Math.floor(Number(input.value));
      if (!Number.isFinite(n) || n < 0 || n > 1440) throw new Error('Use um número de 0 a 1440.');
      try { localStorage.setItem('idleMinutes', String(n)); } catch { /* ignora */ }
      resetIdle();
      toast(n === 0 ? 'Bloqueio automático desligado.' : 'Bloqueio automático em ' + n + ' min.', true);
      close(true);
    },
  }]);
};
['mousemove', 'keydown', 'mousedown', 'touchstart'].forEach((ev) => window.addEventListener(ev, resetIdle, true));

// ---------------------------------------------------------------- árvore
function matches(x, q) {
  return [x.name, x.address, x.notes, ...(x.tags || [])].some((v) => v && String(v).toLowerCase().includes(q));
}

function renderTree() {
  if (!S) return;
  const root = $('#tree');
  root.replaceChildren();
  const q = $('#search').value.trim().toLowerCase();
  if (q) {
    S.hosts.filter((x) => matches(x, q)).sort(byOrder).forEach((x) => root.append(hostRow(x)));
    if (!root.children.length) root.append(h('div', { class: 'muted', style: 'padding:10px' }, 'Nada encontrado'));
    return;
  }
  const build = (parentId, container) => {
    S.folders.filter((f) => f.parentId === parentId).sort(byOrder).forEach((f) => {
      const open = !collapsed.has(f.id);
      container.append(folderRow(f, open));
      if (open) {
        const ch = h('div', { class: 'children' });
        build(f.id, ch);
        S.hosts.filter((x) => x.folderId === f.id).sort(byOrder).forEach((x) => ch.append(hostRow(x)));
        container.append(ch);
      }
    });
  };
  build(null, root);
  S.hosts.filter((x) => !x.folderId).sort(byOrder).forEach((x) => root.append(hostRow(x)));
  if (!S.hosts.length && !S.folders.length) {
    root.append(h('div', { class: 'muted', style: 'padding:10px' }, 'Nenhum host ainda. Crie uma pasta ou clique em “＋ Host”.'));
  }
}

function dragSource(el, type, id) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ t: type, id })); e.dataTransfer.effectAllowed = 'move'; });
}

function dropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop');
    let d;
    try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    try {
      if (d.t === 'host') await call('moveHost', d.id, folderId);
      else if (d.t === 'folder' && d.id !== folderId) await call('moveFolder', d.id, folderId);
    } catch (ex) { toast(errMsg(ex)); }
  });
}

const act = (label, title, fn) => h('button', { title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);

function folderRow(f, open) {
  const row = h('div', { class: 'row', ondblclick: () => toggleFolder(f.id) },
    h('span', { onclick: () => toggleFolder(f.id) }, open ? '▾' : '▸'),
    h('span', { style: f.color ? `color:${f.color}` : '' }, '📁'),
    h('span', { class: 'name', onclick: () => toggleFolder(f.id) }, f.name),
    h('span', { class: 'acts' },
      act('⚡', 'Conectar em todos os hosts da pasta', () => connectFolder(f.id)),
      act('＋', 'Novo host nesta pasta', () => hostDialog(null, f.id)),
      act('📁', 'Nova subpasta', () => folderDialog(null, f.id)),
      act('✎', 'Editar pasta', () => folderDialog(f)),
      act('✕', 'Excluir pasta', () => deleteFolder(f))));
  dragSource(row, 'folder', f.id);
  dropTarget(row, f.id);
  return row;
}

function toggleFolder(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
  renderTree();
}

function hostRow(x) {
  const row = h('div', { class: 'row', ondblclick: () => openHost(x.id), title: x.address || (x.serial && x.serial.port) || '' },
    h('span', { class: 'dot', style: x.lastConnectedAt ? 'background:var(--ok)' : '' }),
    h('span', { class: 'name' }, (x.favorite ? '★ ' : '') + x.name),
    h('span', { class: 'badge ' + x.protocol }, x.protocol),
    h('span', { class: 'acts' },
      act('▶', 'Conectar', () => openHost(x.id)),
      act(x.favorite ? '★' : '☆', 'Favorito', () => call('updateHost', x.id, { favorite: !x.favorite })),
      act('✎', 'Editar', () => hostDialog(x)),
      act('⧉', 'Duplicar', () => call('duplicateHost', x.id)),
      act('✕', 'Excluir', async () => { if (await confirmBox(`Excluir o host “${x.name}”?`, 'Excluir')) await call('removeHost', x.id); })));
  dragSource(row, 'host', x.id);
  dropTarget(row, x.folderId || null);
  return row;
}

const tree = $('#tree');
tree.addEventListener('dragover', (e) => e.preventDefault());
tree.addEventListener('drop', async (e) => {
  e.preventDefault();
  let d;
  try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
  try {
    if (d.t === 'host') await call('moveHost', d.id, null);
    else if (d.t === 'folder') await call('moveFolder', d.id, null);
  } catch (ex) { toast(errMsg(ex)); }
});

$('#search').addEventListener('input', renderTree);
$('#btnNewHost').onclick = () => hostDialog(null, null);
$('#btnNewFolder').onclick = () => folderDialog(null, null);
$('#btnVault').onclick = () => vaultDialog();

async function deleteFolder(f) {
  const nHosts = S.hosts.filter((x) => x.folderId === f.id || descendantIds(f.id).includes(x.folderId)).length;
  const r = await dialog('Excluir pasta', h('div', {}, `A pasta “${f.name}” contém ${nHosts} host(s) (incluindo subpastas). O que fazer?`), [
    cancelBtn,
    { label: 'Mover conteúdo para a pasta pai', onClick: (c) => c('move') },
    { label: 'Apagar tudo', cls: 'danger', onClick: (c) => c('all') },
  ]);
  if (r) await call('removeFolder', f.id, { cascade: r === 'all' });
}

async function connectFolder(id) {
  const ids = new Set([id, ...descendantIds(id)]);
  const list = S.hosts.filter((x) => ids.has(x.folderId)).sort(byOrder);
  if (!list.length) return toast('A pasta não tem hosts');
  if (list.length > 5 && !(await confirmBox(`Abrir ${list.length} conexões de uma vez?`, 'Abrir', false))) return;
  for (const x of list) openHost(x.id);
}

// ---------------------------------------------------------------- diálogos: host e pasta
async function hostDialog(existing, folderId) {
  const d = existing || {
    protocol: 'ssh', port: 22, tags: [], folderId: folderId || null, startupCommands: [], forwards: [], telnetEnter: 'crlf',
    serial: { port: '', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none' },
  };
  const isLinux = /Linux/i.test(navigator.userAgent || '') && !/Android/i.test(navigator.userAgent || '');
  const DEFAULT_PORT = isLinux ? '/dev/ttyUSB0' : ''; // no Linux o adaptador USB-serial costuma ser /dev/ttyUSB0
  const sr = d.serial || { port: DEFAULT_PORT, baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none' };
  const own = existing ? S.identities.find((x) => x.ownerHostId === existing.id) : null; // usuário/senha salvos só neste host
  const i = {
    name: h('input', { value: d.name || '', placeholder: 'ex.: web-01' }),
    protocol: sel([['ssh', 'SSH'], ['telnet', 'Telnet'], ...(MOBILE ? [] : [['serial', 'Serial'], ['rdp', 'RDP'], ['ftp', 'FTP']])], d.protocol),
    folder: sel(folderOptions(), d.folderId || ''),
    address: h('input', { value: d.address || '', placeholder: 'IP ou hostname' }),
    port: h('input', { type: 'number', value: d.port ?? '' }),
    identity: sel(identityOptions('(herdar da pasta)'), (own ? '' : d.identityId) || ''),
    user: h('input', { value: own ? own.username : '', placeholder: 'usuário', autocomplete: 'off' }),
    pass: h('input', { type: 'password', autocomplete: 'new-password', placeholder: own && own.hasPassword ? '(salva — digite para trocar)' : 'senha (opcional)' }),
    jump: sel(hostOptions('(nenhum / herdar da pasta)', d.id), d.jumpHostId || ''),
    enter: sel([['crlf', 'Enter = CR+LF'], ['crnul', 'Enter = CR+NUL']], d.telnetEnter || 'crlf'),
    forwards: h('textarea', { placeholder: 'L:8080:db.interno:5432   (túnel local)\nD:1080   (proxy SOCKS5)' }),
    sPort: h('input', { value: sr.port, list: 'serialPorts', placeholder: 'COM3 ou /dev/ttyUSB0' }),
    sBaud: sel([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => [String(b), String(b)]), String(sr.baud)),
    sData: sel([5, 6, 7, 8].map((b) => [String(b), String(b)]), String(sr.dataBits)),
    sParity: sel([['none', 'Nenhuma'], ['even', 'Par'], ['odd', 'Ímpar'], ['mark', 'Mark'], ['space', 'Space']], sr.parity),
    sStop: sel([['1', '1'], ['2', '2']], String(sr.stopBits)),
    sFlow: sel([['none', 'Nenhum'], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']], sr.flow),
    tags: h('input', { value: (d.tags || []).join(', '), placeholder: 'producao, cliente-a' }),
    cmds: h('textarea', { placeholder: 'um comando por linha, executado ao conectar' }),
    notes: h('textarea', {}),
  };
  i.forwards.value = (d.forwards || []).join('\n');
  i.cmds.value = (d.startupCommands || []).join('\n');
  i.notes.value = d.notes || '';
  const ports = h('datalist', { id: 'serialPorts' });
  const detect = h('button', {
    type: 'button',
    onclick: async () => {
      try {
        const list = await api.serialList();
        ports.replaceChildren(...list.map((p) => h('option', { value: p.path }, p.manufacturer)));
        if (list.length && (!i.sPort.value || i.sPort.value === DEFAULT_PORT)) i.sPort.value = list[0].path; // já preenche com a porta achada
        toast(list.length ? `${list.length} porta(s) encontrada(s)` : 'Nenhuma porta serial encontrada', true);
      } catch (e) { toast(errMsg(e)); }
    },
  }, 'Detectar portas');

  let jumpRow;
  const net = h('div', { class: 'list' },
    h('div', { class: 'grid2' }, field('Porta', i.port), jumpRow = field('Jump host (ProxyJump)', i.jump)),
    field('Identidade (usuário + senha). Vazio = pergunta ao conectar', i.identity));
  i.legacy = h('input', { type: 'checkbox', checked: d.legacyAlgorithms !== false });
  const sshOnly = h('div', { class: 'list' },
    h('label', { class: 'check' }, i.legacy, 'Aceitar algoritmos antigos (switches, CPEs e roteadores legados)'),
    h('div', { class: 'muted' }, 'Acrescenta DH group1/group14-sha1, cifras CBC e ssh-rsa ao final da lista. Servidores modernos continuam usando os modernos.'),
    field('Túneis (um por linha)', i.forwards));
  const telnetOnly = h('div', {}, field('Tecla Enter', i.enter));
  const serial = h('div', { class: 'list' }, ports,
    h('div', { class: 'grid2' }, field('Porta serial', i.sPort), h('div', { style: 'align-self:end' }, detect)),
    h('div', { class: 'grid3' }, field('Baud rate', i.sBaud), field('Bits de dados', i.sData), field('Paridade', i.sParity)),
    h('div', { class: 'grid2' }, field('Stop bits', i.sStop), field('Controle de fluxo', i.sFlow)));

  // protocolo escolhido por "chips" (o select fica só como valor interno)
  const chips = h('div', { class: 'chips' });
  const PROTO = [['ssh', '🔐 SSH'], ['telnet', '📟 Telnet'], ...(MOBILE ? [] : [['serial', '🔌 Serial'], ['rdp', '🖥 RDP'], ['ftp', '📂 FTP']])];
  const paintChips = () => chips.replaceChildren(...PROTO.map(([v, l]) =>
    h('button', { type: 'button', class: 'chip' + (i.protocol.value === v ? ' on' : ''), onclick: () => { i.protocol.value = v; sync(); } }, l)));
  const advanced = h('details', { class: 'adv' }, h('summary', {}, '⚙ Opções avançadas'),
    h('div', { class: 'list adv-body' }, net, sshOnly, telnetOnly, field('Tags (separadas por vírgula)', i.tags), field('Comandos iniciais', i.cmds), field('Notas', i.notes)));
  const addrField = field('Endereço (IP ou hostname)', i.address);
  const clearPass = h('input', { type: 'checkbox' });
  const creds = h('div', { class: 'list' },
    h('div', { class: 'grid2' }, field('Usuário (opcional)', i.user), field('Senha (salva no cofre)', i.pass)),
    own && own.hasPassword ? h('label', { class: 'check' }, clearPass, 'Remover a senha salva') : null,
    h('div', { class: 'muted' }, 'Preenchendo, é só clicar no host para conectar. Vazio = pergunta ao conectar.'));
  const sync = () => {
    const p = i.protocol.value;
    addrField.hidden = p === 'serial';
    creds.hidden = p === 'serial';
    net.hidden = p === 'serial';
    serial.hidden = p !== 'serial';
    sshOnly.hidden = p !== 'ssh';
    jumpRow.hidden = p === 'rdp' || p === 'ftp';
    telnetOnly.hidden = p !== 'telnet';
    if (!existing || (existing && p !== existing.protocol)) i.port.value = p === 'telnet' ? 23 : p === 'ssh' ? 22 : p === 'rdp' ? 3389 : p === 'ftp' ? 21 : '';
    paintChips();
  };
  i.protocol.onchange = sync;
  sync();
  if (existing) i.port.value = d.port ?? '';
  // host que já tem algo avançado configurado abre a seção expandida
  if (existing && (existing.identityId || existing.jumpHostId || (existing.forwards || []).length || (existing.startupCommands || []).length || (existing.tags || []).length || existing.notes)) advanced.open = true;

  const hero = h('div', { class: 'hero' },
    h('div', { class: 'hero-ic' }, '🖥'),
    h('div', {}, h('div', { class: 'hero-t' }, existing ? 'Editar host' : 'Adicionar um host'),
      h('div', { class: 'muted' }, 'Nome, IP e grupo. Se salvar usuário e senha, conecta direto.')));
  const body = [
    hero, chips,
    h('div', { class: 'grid2' }, field('Nome', i.name), field('Grupo', i.folder)),
    addrField, creds, serial, advanced,
  ];

  await dialog('', body, [cancelBtn, {
    label: 'Salvar', cls: 'primary',
    onClick: async (close) => {
      const p = i.protocol.value;
      const patch = {
        name: i.name.value.trim(), protocol: p, folderId: i.folder.value || null,
        tags: i.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
        startupCommands: lines(i.cmds.value), notes: i.notes.value,
      };
      if (p === 'serial') {
        patch.serial = { port: i.sPort.value.trim(), baud: Number(i.sBaud.value), dataBits: Number(i.sData.value), parity: i.sParity.value, stopBits: Number(i.sStop.value), flow: i.sFlow.value };
        patch.address = '';
        patch.port = null;
      } else {
        patch.address = i.address.value.trim();
        patch.port = Number(i.port.value) || (p === 'telnet' ? 23 : p === 'rdp' ? 3389 : p === 'ftp' ? 21 : 22);
        patch.identityId = i.identity.value || null;
        patch.jumpHostId = i.jump.value || null;
        if (p === 'ssh') { patch.forwards = lines(i.forwards.value); patch.legacyAlgorithms = i.legacy.checked; }
        if (p === 'telnet') patch.telnetEnter = i.enter.value;
      }
      const saved = existing ? (await call('updateHost', existing.id, patch), existing) : await call('addHost', patch);
      if (p !== 'serial' && saved && saved.id) {
        const u = i.user.value.trim();
        if (own) {
          const ip = { name: patch.name, username: u };
          if (i.pass.value) ip.password = i.pass.value;
          if (clearPass.checked) ip.password = '';
          await call('updateIdentity', own.id, ip);
          if (!patch.identityId) await call('updateHost', saved.id, { identityId: own.id });
        } else if (u || i.pass.value) {
          const idn = await call('addIdentity', { name: patch.name || u, username: u, password: i.pass.value, ownerHostId: saved.id });
          await call('updateHost', saved.id, { identityId: idn.id });
        }
      }
      close(true);
    },
  }]);
}

async function folderDialog(existing, parentId) {
  const i = {
    name: h('input', { value: existing ? existing.name : '' }),
    parent: sel(folderOptions(existing && existing.id), existing ? existing.parentId || '' : parentId || ''),
    color: h('input', { type: 'color', value: (existing && existing.color) || '#4f8cff', style: 'padding:2px;height:32px' }),
    identity: sel(identityOptions('(nenhuma)'), (existing && existing.defaultIdentityId) || ''),
    jump: sel(hostOptions('(nenhum)'), (existing && existing.defaultJumpHostId) || ''),
    cmds: h('textarea', { placeholder: 'executados em todos os hosts da pasta' }),
  };
  i.cmds.value = existing ? (existing.startupCommands || []).join('\n') : '';
  const body = [
    h('div', { class: 'grid2' }, field('Nome da pasta', i.name), field('Dentro de', i.parent)),
    h('div', { class: 'grid3' }, field('Cor', i.color), field('Identidade padrão', i.identity), field('Jump host padrão', i.jump)),
    h('div', { class: 'muted' }, 'Os hosts da pasta (e subpastas) herdam a identidade, o jump host e os comandos, a menos que definam os seus.'),
    field('Comandos iniciais da pasta', i.cmds),
  ];
  await dialog(existing ? 'Editar pasta' : 'Nova pasta', body, [cancelBtn, {
    label: 'Salvar', cls: 'primary',
    onClick: async (close) => {
      const patch = {
        name: i.name.value.trim(), parentId: i.parent.value || null, color: i.color.value,
        defaultIdentityId: i.identity.value || null, defaultJumpHostId: i.jump.value || null, startupCommands: lines(i.cmds.value),
      };
      if (existing) await call('updateFolder', existing.id, patch); else await call('addFolder', patch);
      close(true);
    },
  }]);
}

// ---------------------------------------------------------------- User SSH: identidades
async function vaultDialog() {
  const box = h('div', { class: 'list' });
  function draw() {
    box.replaceChildren();
    box.append(h('div', {}, h('button', { class: 'primary', onclick: async () => { await identityDialog(null); draw(); } }, '＋ Nova identidade')));
    if (!S.identities.some((x) => !x.ownerHostId)) box.append(h('div', { class: 'muted' }, 'Identidade = usuário + senha. Defina uma vez e reutilize em vários hosts.'));
    S.identities.filter((x) => !x.ownerHostId).forEach((x) => {
      const used = S.hosts.filter((hh) => hh.identityId === x.id).length;
      box.append(h('div', { class: 'item' },
        h('span', { class: 'grow' }, `${x.name} — ${x.username || '(sem usuário)'}`, ' ',
          h('code', {}, [x.hasPassword ? 'senha' : '', x.keyId ? 'chave' : ''].filter(Boolean).join(' · ') + ` · ${used} host(s)`)),
        h('button', { onclick: async () => { await identityDialog(x); draw(); } }, 'Editar'),
        h('button', { class: 'danger', onclick: async () => { if (await confirmBox(`Excluir a identidade “${x.name}”? Os hosts que a usam voltarão a herdar da pasta.`)) { await call('removeIdentity', x.id); draw(); } } }, 'Excluir')));
    });
  }
  draw();
  await dialog('User SSH: identidades', [box], [{ label: 'Fechar', onClick: (c) => c(true) }]);
}

async function identityDialog(existing) {
  const i = {
    name: h('input', { value: existing ? existing.name : '', placeholder: 'ex.: root produção' }),
    user: h('input', { value: existing ? existing.username : '' }),
    pass: h('input', { type: 'password', autocomplete: 'new-password', placeholder: existing && existing.hasPassword ? '(mantida — digite para trocar)' : '' }),
  };
  const clear = h('input', { type: 'checkbox' });
  const body = [
    h('div', { class: 'grid2' }, field('Nome', i.name), field('Usuário', i.user)),
    field('Senha', i.pass),
    existing && existing.hasPassword ? h('label', { class: 'check' }, clear, 'Remover a senha salva') : null,
    h('div', { class: 'muted' }, 'Sem senha salva, o app pergunta a senha a cada conexão (sem salvar).'),
  ];
  await dialog(existing ? 'Editar identidade' : 'Nova identidade', body, [cancelBtn, {
    label: 'Salvar', cls: 'primary',
    onClick: async (close) => {
      const patch = { name: i.name.value.trim(), username: i.user.value.trim() };
      if (i.pass.value) patch.password = i.pass.value;
      if (clear.checked) patch.password = '';
      if (existing) await call('updateIdentity', existing.id, patch); else await call('addIdentity', patch);
      close(true);
    },
  }]);
}

// ---------------------------------------------------------------- mais opções
$('#btnMore').onclick = () => {
  const row =(label, fn) => h('button', { style: 'text-align:left', onclick: async () => { try { await fn(); } catch (e) { toast(errMsg(e)); } } }, label);
  dialog('Opções', h('div', { class: 'list' },
    row('Exportar pastas/hosts (sem senhas)…', async () => { const p = await api.exportData(false); if (p) toast('Exportado: ' + p, true); }),
    row('Importar JSON exportado…', async () => {
      const r = await api.importData();
      if (r) { S = r.snapshot; renderTree(); toast(`${r.added} item(ns) importado(s)`, true); }
    }),
    ...(MOBILE ? [
      row('Backup do cofre (compartilhar o arquivo)…', async () => { const n = await api.backupExport(); toast('Backup pronto: ' + n, true); }),
      row('Restaurar backup do cofre…', restoreDialog),
    ] : [
      row('Backup automático do cofre…', backupDialog),
      row('Log de sessão (gravar o terminal em arquivo)…', logDialog),
      row('Restaurar backup do cofre…', restoreDialog),
      row('Servidores TFTP / FTP…', serversDialog),
      row('Novidades e atualizações…', whatsNewDialog),
    ]),
    row('Alterar senha…', async () => {
      const a = h('input', { type: 'password', autocomplete: 'new-password' });
      const b = h('input', { type: 'password', autocomplete: 'new-password' });
      await dialog('Alterar senha', [field('Nova senha (mín. 8 caracteres)', a), field('Confirmar', b)], [cancelBtn, {
        label: 'Alterar', cls: 'primary',
        onClick: async (close) => {
          if (a.value !== b.value) throw new Error('As senhas não conferem');
          await api.changePassword(a.value);
          toast('Senha alterada', true);
          close(true);
        },
      }]);
    })), [{ label: 'Fechar', onClick: (c) => c(true) }]);
};

// ---------------------------------------------------------------- backup automático
const UNITS = [['m', 'minutos', 1], ['h', 'horas', 60], ['d', 'dias', 1440]];
function splitInterval(min) {
  if (min % 1440 === 0) return [min / 1440, 'd'];
  if (min % 60 === 0) return [min / 60, 'h'];
  return [min, 'm'];
}
const toMinutes = (n, u) => Math.floor(Number(n)) * UNITS.find((x) => x[0] === u)[2];
const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString('pt-BR'); } catch { return String(iso); } };

async function logDialog() {
  const cur = await api.logsGet();
  const enabled = h('input', { type: 'checkbox', checked: cur.enabled });
  const ts = h('input', { type: 'checkbox', checked: cur.timestamps });
  const folder = h('input', { readonly: true, placeholder: cur.effectiveFolder });
  folder.value = cur.folder || '';
  const pick = h('button', { type: 'button', onclick: async () => { const p = await api.logsPickFolder(); if (p) folder.value = p; } }, 'Escolher…');
  const openBtn = h('button', { type: 'button', onclick: async () => { try { await api.logsOpenFolder(); } catch (e) { toast(errMsg(e)); } } }, 'Abrir pasta de logs');
  await dialog('Log de sessão', [
    h('div', { class: 'muted' }, 'Grava em um arquivo de texto tudo o que aparece no terminal (sem cores), um arquivo por conexão, com o nome do host e a data. Vale para as conexões abertas DEPOIS de ligar.'),
    h('label', { class: 'check' }, enabled, ' Gravar o log das sessões'),
    h('label', { class: 'check' }, ts, ' Colocar a hora no começo de cada linha'),
    field('Pasta dos logs (vazio = ' + cur.effectiveFolder + ')', h('div', { class: 'grid2', style: 'grid-template-columns:1fr auto' }, folder, pick)),
    openBtn,
    h('div', { class: 'muted' }, 'Atenção: o log guarda o que foi exibido, inclusive configurações dos equipamentos. Senhas digitadas no terminal normalmente não aparecem, mas guarde a pasta com cuidado.'),
  ], [cancelBtn, {
    label: 'Salvar', cls: 'primary',
    onClick: async (close) => {
      await api.logsSet({ enabled: enabled.checked, timestamps: ts.checked, folder: folder.value });
      toast(enabled.checked ? 'Log de sessão ligado' : 'Log de sessão desligado', true);
      close(true);
    },
  }]);
}

async function restoreDialog() {
  const file = await api.backupPickFile();
  if (!file) return;
  const name = file.split(/[\\/]/).pop();
  const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: 'senha daquele backup' });
  await dialog('Restaurar backup', [
    h('div', { class: 'muted' }, 'Arquivo: ' + name),
    h('div', { class: 'muted' }, 'O cofre atual será substituído pelo backup (uma cópia dele fica guardada na pasta de dados). Use a senha que valia quando o backup foi feito.'),
    field('Senha do backup', pw),
  ], [cancelBtn, {
    label: 'Restaurar', cls: 'primary',
    onClick: async (close) => {
      const r = await api.backupRestore(file, pw.value);
      S = r.snapshot; renderTree();
      toast('Backup restaurado' + (r.saved ? ' (cofre anterior guardado como ' + r.saved + ')' : ''), true);
      close(true);
    },
  }]);
}

async function backupDialog() {
  const cur = await api.backupGet();
  const [amount, unit] = splitInterval(cur.intervalMinutes);
  const enabled = h('input', { type: 'checkbox', checked: cur.enabled });
  const folder = h('input', { readonly: true, placeholder: 'Escolha a pasta (ex.: a do Google Drive para computador)' });
  folder.value = cur.folder || '';
  const pick = h('button', { type: 'button', onclick: async () => { const p = await api.backupPickFolder(); if (p) folder.value = p; } }, 'Escolher…');
  const every = h('input', { type: 'number', min: '1', step: '1' }); every.value = String(amount);
  const unitSel = sel(UNITS.map(([k, l]) => [k, l]), unit);
  const keep = h('input', { type: 'number', min: '1', max: '500', step: '1' }); keep.value = String(cur.keep);
  const status = h('div', { class: 'muted' });
  const paint = (st) => {
    status.textContent = st.lastError ? 'Último erro: ' + st.lastError
      : st.lastAt ? `Último backup: ${fmtWhen(st.lastAt)} (${st.lastFiles} cofre(s))` : 'Nenhum backup feito ainda.';
    status.style.color = st.lastError ? 'var(--danger)' : '';
  };
  paint(cur);
  const read = () => ({ enabled: enabled.checked, folder: folder.value.trim(), intervalMinutes: toMinutes(every.value, unitSel.value), keep: Number(keep.value) });
  await dialog('Backup automático', [
    h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, '☁'), h('div', {},
      h('div', { class: 'hero-t' }, 'Cópia automática do cofre'),
      h('div', { class: 'muted' }, 'Escolha uma pasta sincronizada (Google Drive, OneDrive, Dropbox…) e o serviço envia sozinho.'))),
    h('label', { class: 'check' }, enabled, 'Ligar o backup automático'),
    field('Pasta de destino', h('div', { class: 'grid2', style: 'grid-template-columns:1fr auto' }, folder, pick)),
    h('div', { class: 'grid3' }, field('Repetir a cada', every), field('Unidade', unitSel), field('Guardar os últimos', keep)),
    status,
    h('div', { class: 'muted' }, 'Os arquivos copiados continuam criptografados com a sua senha. O backup roda enquanto o NetDeck estiver aberto. Para restaurar, copie o arquivo .vault de volta para a pasta de dados do app.'),
  ], [cancelBtn,
    { label: 'Fazer backup agora', onClick: async () => {
      await api.backupSet(read());
      try { const r = await api.backupNow(); paint(r.state); toast(`Backup feito (${r.files} cofre(s))`, true); } catch (e) { paint(await api.backupGet()); throw e; }
    } },
    { label: 'Salvar', cls: 'primary', onClick: async (close) => {
      const st = await api.backupSet(read());
      toast(st.enabled ? 'Backup automático ligado' : 'Backup automático desligado', true);
      close(true);
    } }]);
}

// ---------------------------------------------------------------- servidores TFTP / FTP
async function serversDialog() {
  let st = await api.serversStatus();
  const addrs = await api.serversAddresses().catch(() => []);
  const c = st.config;
  const root = h('input', { readonly: true, placeholder: 'Pasta que os equipamentos vão enxergar' }); root.value = c.root || '';
  const pickRoot = h('button', { type: 'button', onclick: async () => { const p = await api.serversPickRoot(); if (p) root.value = p; } }, 'Escolher…');
  const tOn = h('input', { type: 'checkbox', checked: c.tftp.enabled });
  const tPort = h('input', { type: 'number', min: '1', max: '65535' }); tPort.value = String(c.tftp.port);
  const tW = h('input', { type: 'checkbox', checked: c.tftp.allowWrite });
  const fOn = h('input', { type: 'checkbox', checked: c.ftp.enabled });
  const fPort = h('input', { type: 'number', min: '1', max: '65535' }); fPort.value = String(c.ftp.port);
  const fUser = h('input', { autocomplete: 'off' }); fUser.value = c.ftp.user || '';
  const fPass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.ftp.hasPassword ? '(mantida — digite para trocar)' : 'defina uma senha' });
  const fW = h('input', { type: 'checkbox', checked: c.ftp.allowWrite });
  const fAnon = h('input', { type: 'checkbox', checked: c.ftp.anonymous });
  const state = h('div', { class: 'muted' });
  const log = h('textarea', { readonly: true, rows: '7', style: 'min-height:110px' });
  const paint = (s) => {
    st = s;
    const line = (name, on, err) => (err ? `${name}: ERRO — ${err}` : on ? `${name}: ligado` : `${name}: desligado`);
    state.textContent = line('TFTP', s.running.tftp, s.errors.tftp) + '   |   ' + line('FTP', s.running.ftp, s.errors.ftp);
    state.style.color = s.errors.tftp || s.errors.ftp ? 'var(--danger)' : '';
    log.value = s.logs.slice(-60).join('\n');
    log.scrollTop = log.scrollHeight;
  };
  paint(st);
  const read = () => ({
    root: root.value.trim(),
    tftp: { enabled: tOn.checked, port: Number(tPort.value), allowWrite: tW.checked },
    ftp: { enabled: fOn.checked, port: Number(fPort.value), user: fUser.value, password: fPass.value, allowWrite: fW.checked, anonymous: fAnon.checked },
  });
  const card = (title, ...rows) => h('div', { class: 'adv', style: 'padding:10px 12px' }, h('div', { style: 'font-weight:600;margin-bottom:8px' }, title), h('div', { class: 'list' }, ...rows));
  await dialog('Servidores TFTP e FTP', [
    h('div', { class: 'hero' }, h('div', { class: 'hero-ic' }, '🗄'), h('div', {},
      h('div', { class: 'hero-t' }, 'Servidores para equipamentos'),
      h('div', { class: 'muted' }, addrs.length ? 'Neste computador use: ' + addrs.join('  ou  ') : 'Use o IP deste computador na rede.'))),
    field('Pasta raiz (o que os equipamentos veem)', h('div', { class: 'grid2', style: 'grid-template-columns:1fr auto' }, root, pickRoot)),
    card('TFTP (firmware e configuração de switches, CPEs, MikroTik)',
      h('label', { class: 'check' }, tOn, 'Ligar o servidor TFTP'),
      h('div', { class: 'grid2' }, field('Porta (padrão 69)', tPort), h('label', { class: 'check', style: 'align-self:end' }, tW, 'Permitir receber arquivos (gravar)')),
      h('div', { class: 'muted' }, 'TFTP não tem senha: ligue só em rede confiável e desligue quando terminar.')),
    card('FTP',
      h('label', { class: 'check' }, fOn, 'Ligar o servidor FTP'),
      h('div', { class: 'grid3' }, field('Porta (padrão 21)', fPort), field('Usuário', fUser), field('Senha', fPass)),
      h('div', { class: 'grid2' }, h('label', { class: 'check' }, fW, 'Permitir enviar, apagar e renomear'), h('label', { class: 'check' }, fAnon, 'Aceitar acesso anônimo (sem senha)')),
      h('div', { class: 'muted' }, 'Modo passivo usa as portas 50000–50100 (libere no firewall se o equipamento estiver em outra rede).')),
    state,
    field('Atividade', log),
    h('div', { class: 'muted' }, 'O Windows pode perguntar sobre o firewall na primeira vez: permita para rede privada. No Linux, portas abaixo de 1024 exigem root; use 2121 e 6969.'),
  ], [
    { label: 'Atualizar atividade', onClick: async () => paint(await api.serversStatus()) },
    { label: 'Fechar', onClick: (close) => close(true) },
    { label: 'Salvar e aplicar', cls: 'primary', onClick: async () => {
      paint(await api.serversApply(read()));
      fPass.value = '';
      if (st.errors.tftp || st.errors.ftp) throw new Error(st.errors.tftp || st.errors.ftp);
      toast('Servidores atualizados', true);
    } }]);
}

// ---------------------------------------------------------------- prompt vindo do processo principal
api.on('prompt:ask', async (id, title, label, secret) => {
  const inp = h('input', { type: secret ? 'password' : 'text', autocomplete: 'off' });
  const v = await dialog(title, field(label, inp), [
    { label: 'Cancelar', onClick: (c) => c(null) },
    { label: 'OK', cls: 'primary', onClick: (c) => c(inp.value) },
  ]);
  api.answerPrompt(id, v === undefined ? null : v);
});

// confirmação de chave de servidor (no Android; no computador isso é uma janela do sistema)
api.on('confirm:ask', async (id, info) => {
  const ok = await dialog(info.changed ? 'ALERTA: a chave do servidor mudou' : 'Servidor desconhecido', [
    h('div', {}, info.changed
      ? `A chave de ${info.hostport} é diferente da registrada. Isso pode indicar um ataque (man-in-the-middle) ou reinstalação do servidor.`
      : `Primeira conexão com ${info.hostport}.`),
    h('code', { style: 'word-break:break-all;display:block;margin:8px 0' }, `${info.algo}\n${info.fingerprint}`),
    h('div', { class: 'muted' }, 'Confirme o fingerprint por um canal confiável antes de continuar.'),
  ], [
    { label: 'Cancelar', onClick: (c) => c(false) },
    { label: info.changed ? 'Aceitar nova chave' : 'Confiar e conectar', cls: info.changed ? 'danger' : 'primary', onClick: (c) => c(true) },
  ]);
  api.answerPrompt(id, !!ok);
});

// ---------------------------------------------------------------- abas, painéis e terminais
// Cada aba tem uma árvore de painéis (Layout); cada painel é um terminal com sua própria conexão.
const THEME = {
  background: '#0d0f13', foreground: '#d7dae0', cursor: '#4f8cff', selectionBackground: '#2f4a80',
  black: '#1b1e25', red: '#e5534b', green: '#3fb950', yellow: '#d29922', blue: '#4f8cff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7dae0',
  brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f3f6',
};
const { Layout } = window;

function setEmpty() { $('#empty').hidden = tabList.length > 0; }

// Tema da interface: Padrão ou Matrix (verde, com chuva de código na tela de senha e na tela vazia)
const UI_THEMES = { padrao: 'Padrão', matrix: 'Matrix (verde, chuva de código)' };
const uiTheme = () => { try { const v = localStorage.getItem('uiTheme'); return UI_THEMES[v] ? v : 'padrao'; } catch { return 'padrao'; } };
const RAIN_MODES = { empty: 'Só nas telas vazias', low: 'Em toda a janela, atrás do terminal (fraca)', mid: 'Em toda a janela, atrás do terminal (média)' };
const rainMode = () => { try { const v = localStorage.getItem('uiRain'); return RAIN_MODES[v] ? v : 'empty'; } catch { return 'empty'; } };
const rainAll = () => uiTheme() === 'matrix' && rainMode() !== 'empty'; // chuva em toda a janela: painéis e terminal ficam translúcidos
function applyRain(m) {
  const v = RAIN_MODES[m] ? m : 'empty';
  try { localStorage.setItem('uiRain', v); } catch { /* ignora */ }
  if (document.documentElement) document.documentElement.dataset.rain = v;
}
function applyUi(id) {
  const v = UI_THEMES[id] ? id : 'padrao';
  if (document.documentElement) document.documentElement.dataset.ui = v;
  try { localStorage.setItem('uiTheme', v); } catch { /* ignora */ }
  applyRain(rainMode());
  if (v === 'matrix') startRain();
}
let rainOn = false;
function startRain() {
  if (rainOn) return;
  rainOn = true;
  const GL = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEFZ:.=*+-<>';
  const SZ = 16;
  const state = new WeakMap();
  let last = 0;
  const frame = (t) => {
    if (!document.documentElement || document.documentElement.dataset.ui !== 'matrix') { rainOn = false; return; }
    requestAnimationFrame(frame);
    if (t - last < 55 || document.hidden) return; // ~18 quadros por segundo: leve para a CPU
    last = t;
    document.querySelectorAll('canvas.rain').forEach((cv) => {
      const w = cv.clientWidth; const hh = cv.clientHeight;
      if (!w || !hh) return;
      let st = state.get(cv);
      if (!st || cv.width !== w || cv.height !== hh) {
        cv.width = w; cv.height = hh;
        st = { drops: Array.from({ length: Math.ceil(w / SZ) }, () => Math.random() * -40) };
        state.set(cv, st);
      }
      const c = cv.getContext('2d');
      c.fillStyle = 'rgba(0,0,0,.09)'; c.fillRect(0, 0, w, hh);
      c.font = SZ + 'px monospace';
      st.drops.forEach((y, i) => {
        const ch = GL[Math.floor(Math.random() * GL.length)];
        c.fillStyle = '#d8ffe3'; c.fillText(ch, i * SZ, y * SZ);
        c.fillStyle = '#1fdc50'; c.fillText(GL[Math.floor(Math.random() * GL.length)], i * SZ, (y - 1) * SZ);
        st.drops[i] = y * SZ > hh && Math.random() > 0.975 ? 0 : y + 1;
      });
    });
  };
  requestAnimationFrame(frame);
}
applyUi(uiTheme());

// Fonte do terminal (botão "Aa"): família + tamanho + altura da linha, lembrados neste computador.
const FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New', 'Lucida Console', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Hack', 'Ubuntu Mono', 'DejaVu Sans Mono'];
const FONT_FALLBACK = "'DejaVu Sans Mono',Consolas,monospace";
const FONT_DEFAULT = { family: 'Cascadia Mono', size: 14, lineHeight: 1, theme: 'padrao', scrollback: 10000 };
const SCROLLBACKS = [1000, 5000, 10000, 20000, 50000, 100000, 200000];
const clampScroll = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(200000, Math.max(1000, n)) : FONT_DEFAULT.scrollback; };
// Cores do texto/fundo do terminal (as 16 cores ANSI continuam as do THEME)
const COLOR_THEMES = {
  padrao: ['Padrão (azul escuro)', { background: '#0d0f13', foreground: '#d7dae0', cursor: '#4f8cff', selectionBackground: '#2f4a80' }],
  matrix: ['Verde (terminal clássico)', { background: '#050805', foreground: '#33ff66', cursor: '#33ff66', selectionBackground: '#145a28' }],
  ambar: ['Âmbar (monitor antigo)', { background: '#100a02', foreground: '#ffb000', cursor: '#ffb000', selectionBackground: '#5a3d00' }],
  solarized: ['Solarized escuro', { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#0b4a5a' }],
  dracula: ['Dracula', { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a' }],
  claro: ['Claro', { background: '#fafafa', foreground: '#1f2328', cursor: '#0969da', selectionBackground: '#b6d4fe' }],
};
const hexA = (hex, a) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex; };
const themeFor = (id) => {
  const t = { ...THEME, ...(COLOR_THEMES[id] || COLOR_THEMES.padrao)[1] };
  if (rainAll()) t.background = hexA(t.background, rainMode() === 'low' ? 0.62 : 0.42); // deixa a chuva aparecer atrás do texto
  return t;
};
function fontPrefs() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem('termFont') || '{}') || {}; } catch { o = {}; }
  const size = Math.min(40, Math.max(8, Math.round(Number(o.size)) || FONT_DEFAULT.size));
  const lh = Math.min(1.6, Math.max(1, Number(o.lineHeight) || FONT_DEFAULT.lineHeight));
  const family = typeof o.family === 'string' && /^[\w .-]{1,60}$/.test(o.family) ? o.family : FONT_DEFAULT.family;
  const theme = COLOR_THEMES[o.theme] ? o.theme : FONT_DEFAULT.theme;
  return { family, size, lineHeight: lh, theme, scrollback: clampScroll(o.scrollback) };
}
const fontStack = (family) => "'" + family + "'," + FONT_FALLBACK;
function applyFont(prefs) {
  try { localStorage.setItem('termFont', JSON.stringify(prefs)); } catch { /* ignora */ }
  for (const p of panes.values()) {
    p.term.options.fontFamily = fontStack(prefs.family);
    p.term.options.fontSize = prefs.size;
    p.term.options.lineHeight = prefs.lineHeight;
    p.term.options.scrollback = clampScroll(prefs.scrollback);
    p.term.options.theme = themeFor(prefs.theme);
    p.el.style.background = themeFor(prefs.theme).background;
  }
  scheduleFit();
}
function zoomFont(delta) {
  const f = fontPrefs();
  applyFont({ ...f, size: Math.min(40, Math.max(8, f.size + delta)) });
}
$('#btnFont').onclick = async () => {
  const cur = fontPrefs();
  const list = FONTS.includes(cur.family) ? FONTS : [cur.family, ...FONTS];
  const family = sel(list.map((f) => [f, f]), cur.family);
  const custom = h('input', { placeholder: 'ou digite o nome de outra fonte instalada' });
  const theme = sel(Object.entries(COLOR_THEMES).map(([k, v]) => [k, v[0]]), cur.theme);
  const ui = sel(Object.entries(UI_THEMES), uiTheme());
  const rain = sel(Object.entries(RAIN_MODES), rainMode());
  const size = h('input', { type: 'number', min: '8', max: '40', step: '1' }); size.value = String(cur.size);
  const lh = h('input', { type: 'number', min: '1', max: '1.6', step: '0.05' }); lh.value = String(cur.lineHeight);
  const scroll = sel(SCROLLBACKS.map((n) => [String(n), n.toLocaleString('pt-BR') + ' linhas']), String(SCROLLBACKS.includes(cur.scrollback) ? cur.scrollback : FONT_DEFAULT.scrollback));
  const preview = h('div', { class: 'font-preview' }, 'admin@MikroTik > /ip address print\n0123456789 O0 Il1 {}[]()');
  const read = () => ({ family: custom.value.trim() || family.value, size: Number(size.value), lineHeight: Number(lh.value), theme: theme.value, scrollback: Number(scroll.value) });
  const refresh = () => {
    const f = read();
    preview.style.fontFamily = fontStack(/^[\w .-]{1,60}$/.test(f.family) ? f.family : FONT_DEFAULT.family);
    preview.style.fontSize = Math.min(40, Math.max(8, f.size || 14)) + 'px';
    preview.style.lineHeight = String(Math.min(1.6, Math.max(1, f.lineHeight || 1)));
    const c = themeFor(f.theme); preview.style.background = c.background; preview.style.color = c.foreground;
  };
  [family, custom, size, lh, theme].forEach((e) => { e.addEventListener('input', refresh); e.addEventListener('change', refresh); });
  refresh();
  await dialog('Fonte e cores do terminal', [
    h('div', { class: 'grid2' }, field('Fonte', family), field('Outra fonte (opcional)', custom)),
    h('div', { class: 'grid2' }, field('Tamanho (8–40)', size), field('Altura da linha (1–1.6)', lh)),
    field('Tema da interface', ui),
    field('Chuva de código (só no tema Matrix)', rain),
    field('Cores do texto e do fundo do terminal', theme),
    field('Histórico para rolar (linhas guardadas por terminal)', scroll),
    preview,
    h('div', { class: 'muted' }, 'Só aparecem fontes instaladas no Windows. Mais linhas de histórico usam mais memória. Atalhos no terminal: Ctrl + roda do mouse, Ctrl + "+" / "-", Ctrl + 0 (padrão).'),
  ], [cancelBtn,
    { label: 'Padrão', onClick: async (close) => { applyFont({ ...FONT_DEFAULT }); applyRain('empty'); applyUi('padrao'); applyFont({ ...FONT_DEFAULT }); close(true); } },
    { label: 'Aplicar', cls: 'primary', onClick: async (close) => {
      const f = sanitizeFont(read());
      if (ui.value === 'matrix' && uiTheme() !== 'matrix' && f.theme === 'padrao') f.theme = 'matrix'; // ao ligar o Matrix, o terminal também fica verde
      applyRain(rain.value);
      applyUi(ui.value);
      applyFont(f); // aplica de novo para o terminal pegar a transparência certa
      close(true);
    } },
  ]);
};
function sanitizeFont(f) {
  const size = Math.min(40, Math.max(8, Math.round(Number(f.size)) || FONT_DEFAULT.size));
  const lineHeight = Math.min(1.6, Math.max(1, Number(f.lineHeight) || 1));
  const family = /^[\w .-]{1,60}$/.test(f.family) ? f.family : FONT_DEFAULT.family;
  const theme = COLOR_THEMES[f.theme] ? f.theme : FONT_DEFAULT.theme;
  return { family, size, lineHeight, theme, scrollback: clampScroll(f.scrollback) };
}

function makePane({ name, protocol, hostId, adhoc }) {
  const el = h('div', { class: 'term' });
  const fp = fontPrefs();
  const term = new Terminal({
    fontFamily: fontStack(fp.family), fontSize: fp.size, lineHeight: fp.lineHeight, cursorBlink: true,
    scrollback: fp.scrollback, theme: themeFor(fp.theme), allowProposedApi: false, allowTransparency: true,
  });
  el.style.background = themeFor(fp.theme).background;
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const pane = { sid: crypto.randomUUID(), name, protocol, hostId, adhoc, term, fit, el, wrap: null, opened: false, connected: false, dead: false, tab: null };
  panes.set(pane.sid, pane);
  term.onData((d) => sendInput(pane, d));
  term.onResize(({ cols, rows }) => { if (pane.connected) api.resize(pane.sid, cols, rows); });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === '+' || e.key === '=') { zoomFont(1); return false; }
      if (e.key === '-') { zoomFont(-1); return false; }
      if (e.key === '0') { applyFont({ ...FONT_DEFAULT }); return false; }
    }
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') { navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.code === 'KeyV') { navigator.clipboard.readText().then((t) => term.paste(t)); return false; }
    return true;
  });
  el.addEventListener('contextmenu', async (e) => { // botão direito: copia se há seleção, senão cola
    e.preventDefault();
    if (term.hasSelection()) { await navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); }
    else term.paste(await navigator.clipboard.readText());
  });
  el.addEventListener('mousedown', () => focusPane(pane), true);
  el.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); zoomFont(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  return pane;
}

let dragTab = null; // aba sendo arrastada
let dragPane = null; // painel sendo arrastado

function makeTab(pane) {
  const badge = h('span', { class: 'badge' });
  const label = h('span', { class: 'tab-label' });
  const x = h('span', { class: 'x', title: 'Fechar aba' }, '✕');
  const tabEl = h('div', { class: 'tab' }, badge, label, x);
  const el = h('div', { class: 'tabview' });
  const tab = { root: Layout.leaf(pane), el, tabEl, label, badge };
  pane.tab = tab;
  tabEl.onclick = () => activate(tab);
  tabEl.draggable = true; // arrastar a aba muda a ordem; soltar um painel nela move o painel para essa aba
  tabEl.addEventListener('dragstart', (e) => { dragTab = tab; e.dataTransfer.setData('application/x-netdeck-tab', '1'); e.dataTransfer.effectAllowed = 'move'; });
  tabEl.addEventListener('dragend', () => { dragTab = null; dragPane = null; tabEl.classList.remove('drop-l', 'drop-r', 'drop-in'); });
  tabEl.addEventListener('dragover', (e) => {
    if (!dragTab && !dragPane) return;
    e.preventDefault();
    const r = tabEl.getBoundingClientRect();
    tabEl.classList.toggle('drop-in', !!dragPane);
    tabEl.classList.toggle('drop-l', !!dragTab && e.clientX < r.left + r.width / 2);
    tabEl.classList.toggle('drop-r', !!dragTab && e.clientX >= r.left + r.width / 2);
  });
  tabEl.addEventListener('dragleave', () => tabEl.classList.remove('drop-l', 'drop-r', 'drop-in'));
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = e.clientX >= tabEl.getBoundingClientRect().left + tabEl.offsetWidth / 2;
    tabEl.classList.remove('drop-l', 'drop-r', 'drop-in');
    if (dragTab) moveTab(dragTab, tab, after);
    else if (dragPane) movePaneToTab(dragPane, tab);
    dragTab = null; dragPane = null;
  });
  x.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
  tabEl.classList.toggle('bc', broadcast);
  tabList.push(tab);
  $('#tabs').append(tabEl);
  $('#terms').append(el);
  return tab;
}

function updateTabLabel(tab) {
  const ps = Layout.leaves(tab.root);
  const first = ps[0];
  tab.label.textContent = first.name + (ps.length > 1 ? ` +${ps.length - 1}` : '');
  tab.badge.className = 'badge ' + first.protocol;
  tab.badge.textContent = first.protocol;
  tab.tabEl.title = ps.map((p) => p.name).join(' | ');
  tab.tabEl.classList.toggle('dead', ps.every((p) => p.dead));
}

// Reconstrói o DOM da aba a partir da árvore de painéis (os terminais xterm são reaproveitados).
function renderTab(tab) {
  const multi = Layout.leaves(tab.root).length > 1;
  tab.el.classList.toggle('multi', multi);
  const build = (node) => {
    if (node.kind === 'pane') {
      const p = node.pane;
      const head = h('div', { class: 'pane-head' },
        h('span', { class: 'badge ' + p.protocol }, p.protocol),
        h('span', { class: 'grow' }, p.name),
        h('button', { title: 'Fechar este painel', onclick: (e) => { e.stopPropagation(); closePane(p); } }, '✕'));
      head.draggable = true; // arrastar o título troca de lugar / divide / leva para outra aba
      head.addEventListener('dragstart', (e) => { dragPane = p; e.dataTransfer.setData('application/x-netdeck-pane', '1'); e.dataTransfer.effectAllowed = 'move'; });
      head.addEventListener('dragend', () => { dragPane = null; dropHint.hidden = true; });
      const wrap = h('div', { class: 'pane' + (p === activePane ? ' active' : '') }, head, p.el);
      p.wrap = wrap;
      return wrap;
    }
    const a = build(node.a);
    const b = build(node.b);
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    // prefixo dir-: a classe 'row' já existe na lista de hosts e tem outro estilo
    const gutter = h('div', { class: 'gutter dir-' + node.dir });
    const box = h('div', { class: 'split dir-' + node.dir }, a, gutter, b);
    gutter.addEventListener('mousedown', (e) => dragGutter(e, node, box, a, b));
    return box;
  };
  tab.el.replaceChildren(build(tab.root));
  for (const p of Layout.leaves(tab.root)) {
    if (!p.opened) { p.term.open(p.el); p.opened = true; } // abre só depois de estar no DOM
  }
  updateTabLabel(tab);
}

function dragGutter(e, node, box, a, b) {
  e.preventDefault();
  const rect = box.getBoundingClientRect();
  const row = node.dir === 'row';
  const move = (ev) => {
    const r = row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
    node.ratio = Layout.clampRatio(r);
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    scheduleFit();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
    scheduleFit();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  document.body.classList.add('resizing');
}

function fitTab(tab) {
  if (!tab) return;
  for (const p of Layout.leaves(tab.root)) { try { p.fit.fit(); } catch { /* ignora */ } }
}
let fitQueued = false;
function scheduleFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitTab(activeTab); });
}

function markActive() {
  if (!activeTab) return;
  for (const p of Layout.leaves(activeTab.root)) if (p.wrap) p.wrap.classList.toggle('active', p === activePane);
}

function focusPane(p) {
  activePane = p;
  if (p.tab !== activeTab) { activate(p.tab); return; }
  markActive();
  p.term.focus();
}

function activate(tab) {
  activeTab = tab;
  for (const t of tabList) {
    t.el.classList.toggle('active', t === tab);
    t.tabEl.classList.toggle('active', t === tab);
  }
  const ps = Layout.leaves(tab.root);
  if (!ps.includes(activePane)) activePane = ps[0];
  markActive();
  setEmpty();
  requestAnimationFrame(() => { fitTab(tab); activePane.term.focus(); });
}

function markDead(pane) {
  pane.connected = false;
  pane.dead = true;
  if (pane.tab) updateTabLabel(pane.tab);
}

async function connect(pane) {
  panes.delete(pane.sid);
  pane.sid = crypto.randomUUID(); // id novo a cada tentativa; o main usa o id que enviamos
  panes.set(pane.sid, pane);
  pane.dead = false;
  pane.connected = false;
  updateTabLabel(pane.tab);
  pane.term.writeln('\x1b[90mConectando a ' + pane.name + '…\x1b[0m');
  try { pane.fit.fit(); } catch { /* ignora */ }
  const sid = pane.sid;
  try {
    const r = await api.open({ id: sid, hostId: pane.hostId, adhoc: pane.adhoc, cols: pane.term.cols, rows: pane.term.rows });
    if (pane.sid !== sid) return;
    pane.connected = !pane.dead;
    if (r.snapshot) { S = r.snapshot; renderTree(); }
    api.resize(sid, pane.term.cols, pane.term.rows);
  } catch (e) {
    pane.term.writeln('\r\n\x1b[31mFalha: ' + errMsg(e) + '\x1b[0m');
    markDead(pane);
  }
}

function sendInput(pane, data) {
  if (broadcast) {
    for (const p of panes.values()) if (p.connected) api.input(p.sid, data);
  } else if (pane.connected) {
    api.input(pane.sid, data);
  }
}

// Abre uma conexão em uma NOVA aba.
function newTab(info) {
  const pane = makePane(info);
  const tab = makeTab(pane);
  activeTab = tab;
  activePane = pane;
  renderTab(tab);
  activate(tab);
  connect(pane);
  return tab;
}

// Abre uma conexão DIVIDINDO um painel existente (side: left | right | top | bottom).
function splitOpen(target, side, info) {
  const tab = target.tab;
  const pane = makePane(info);
  pane.tab = tab;
  tab.root = Layout.split(tab.root, target, side, pane);
  activePane = pane;
  renderTab(tab);
  activate(tab);
  fitTab(tab);
  connect(pane);
}

function disposePane(pane) {
  api.close(pane.sid);
  panes.delete(pane.sid);
  try { pane.term.dispose(); } catch { /* ignora */ }
  pane.el.remove();
}

function closePane(pane) {
  const tab = pane.tab;
  if (Layout.leaves(tab.root).length === 1) return closeTab(tab);
  disposePane(pane);
  tab.root = Layout.remove(tab.root, pane);
  if (activePane === pane) activePane = Layout.leaves(tab.root)[0];
  renderTab(tab);
  markActive();
  requestAnimationFrame(() => { fitTab(tab); if (activePane) activePane.term.focus(); });
}

function closeTab(tab) {
  Layout.leaves(tab.root).forEach(disposePane);
  tab.el.remove();
  tab.tabEl.remove();
  const i = tabList.indexOf(tab);
  if (i >= 0) tabList.splice(i, 1);
  if (activeTab === tab) {
    activeTab = null;
    activePane = null;
    const next = tabList[tabList.length - 1];
    if (next) activate(next);
  }
  setEmpty();
}

// ---- mover abas e painéis arrastando ----
function moveTab(src, dst, after) {
  if (src === dst) return;
  tabList.splice(tabList.indexOf(src), 1);
  let i = tabList.indexOf(dst);
  if (after) i += 1;
  tabList.splice(i, 0, src);
  const bar = $('#tabs');
  for (const t of tabList) bar.append(t.tabEl); // reordena no DOM
}

// tira o painel da árvore da aba de origem sem fechar a conexão; se era o único, a aba some
function detachPane(pane) {
  const tab = pane.tab;
  if (Layout.leaves(tab.root).length === 1) {
    tab.el.remove(); tab.tabEl.remove();
    const i = tabList.indexOf(tab);
    if (i >= 0) tabList.splice(i, 1);
    if (activeTab === tab) { activeTab = null; activePane = null; }
    return;
  }
  tab.root = Layout.remove(tab.root, pane);
  if (activePane === pane) activePane = Layout.leaves(tab.root)[0];
  renderTab(tab);
}

function movePaneInTab(pane, target, zone) { // mesma aba: centro troca de lugar, borda reposiciona
  if (pane === target) return;
  const tab = pane.tab;
  if (zone === 'center') {
    const a = Layout.findLeaf(tab.root, pane);
    const b = Layout.findLeaf(tab.root, target);
    a.pane = target; b.pane = pane;
  } else {
    if (Layout.leaves(tab.root).length < 2) return;
    tab.root = Layout.remove(tab.root, pane);
    tab.root = Layout.split(tab.root, target, zone, pane);
  }
  activePane = pane;
  renderTab(tab);
  activate(tab);
  fitTab(tab);
}

function movePaneToTab(pane, dst) { // outra aba: entra dividindo à direita
  if (pane.tab === dst) return;
  const src = pane.tab;
  const was = activeTab;
  detachPane(pane);
  const last = Layout.leaves(dst.root).slice(-1)[0];
  dst.root = Layout.split(dst.root, last, 'right', pane);
  pane.tab = dst;
  activePane = pane;
  renderTab(dst);
  activate(dst);
  fitTab(dst);
  if (was === src && tabList.includes(src)) renderTab(src);
  updateTabLabel(dst);
  if (tabList.includes(src)) updateTabLabel(src);
}

function closeAllTabs() { [...tabList].forEach(closeTab); }

let lastAct = 0;
api.on('session:data', (id, data) => {
  const p = panes.get(id); if (p) p.term.write(data);
  const t = Date.now(); if (t - lastAct > 5000) { lastAct = t; resetIdle(); } // sessão com movimento conta como uso: não bloqueia o cofre
});
api.on('session:status', (id, msg) => {
  const p = panes.get(id);
  if (!p) return;
  p.term.writeln('\r\n\x1b[90m[' + msg + ']\x1b[0m');
  if (p === activePane) $('#status').textContent = `${p.name}: ${msg}`;
});
api.on('session:close', (id, reason) => {
  const p = panes.get(id);
  if (!p) return;
  p.term.writeln('\r\n\x1b[33m[' + reason + ' — use ↻ para reconectar]\x1b[0m');
  markDead(p);
  if (p === activePane) $('#status').textContent = `${p.name}: ${reason}`;
});

function openHost(hostId) {
  const x = hostById(hostId);
  if (!x) return;
  if (x.protocol === 'rdp') { // acesso remoto abre o cliente do sistema (mstsc / xfreerdp), fora do NetDeck
    api.rdpOpen(hostId).then(() => toast('Abrindo acesso remoto…', true), (e) => toast(errMsg(e)));
    return;
  }
  if (x.protocol === 'ftp') { ftpDialog(x); return; }
  newTab({ name: x.name, protocol: x.protocol, hostId });
}

// janela de pastas FTP (estilo FileZilla): lista, entra nas pastas, baixa e envia
async function ftpDialog(host) {
  let creds = null;
  let r;
  try {
    r = await api.ftpOpen(host.id, null);
    if (r.needCreds) {
      const u = h('input', { placeholder: 'usuário (ou anonymous)', autocomplete: 'off' });
      const pw = h('input', { type: 'password', autocomplete: 'new-password' });
      const ok = await dialog(`FTP — ${host.name}`, [field('Usuário', u), field('Senha', pw), h('div', { class: 'muted' }, 'Salve usuário e senha no host para não perguntar. FTP não é cifrado: use em rede confiável.')],
        [cancelBtn, { label: 'Conectar', cls: 'primary', onClick: (c) => c(true) }]);
      if (!ok) return;
      creds = { user: u.value.trim() || 'anonymous', password: pw.value };
      r = await api.ftpOpen(host.id, creds);
    }
  } catch (e) { return toast(errMsg(e)); }
  const id = r.id;
  let cwd = '/';
  let selected = null;
  const pathEl = h('div', { class: 'sftp-path muted' });
  const listEl = h('div', { class: 'list', style: 'min-height:260px' });
  const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(1) + ' KB' : n + ' B');
  const join = (a, b) => (a === '/' ? '' : a) + '/' + b;
  async function load(p) {
    try {
      const l = await api.ftpList(id, p);
      cwd = l.path; selected = null; pathEl.textContent = cwd;
      const rows = [];
      if (cwd !== '/') rows.push(h('div', { class: 'sftp-row', ondblclick: () => load(cwd.replace(/\/[^/]+\/?$/, '') || '/') }, '↩', '..', '', ''));
      l.items.forEach((it) => {
        const row = h('div', {
          class: 'sftp-row',
          onclick: () => { listEl.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel')); row.classList.add('sel'); selected = it.isDir ? null : it; },
          ondblclick: () => { if (it.isDir) load(join(cwd, it.name)); },
        }, it.isDir ? '📁' : '📄', it.name, it.isDir ? '' : fmtSize(it.size), it.mtime ? new Date(it.mtime).toLocaleString() : '');
        rows.push(row);
      });
      listEl.replaceChildren(...rows);
    } catch (e) { toast(errMsg(e)); }
  }
  load('/');
  await dialog(`FTP — ${host.name}`, [pathEl, listEl], [
    { label: '⬇ Baixar selecionado', onClick: async () => {
      if (!selected) return toast('Clique em um arquivo primeiro');
      try { const f = await api.ftpDownload(id, join(cwd, selected.name)); if (f) toast('Salvo em ' + f, true); } catch (e) { toast(errMsg(e)); }
    } },
    { label: '⬆ Enviar arquivos…', onClick: async () => {
      try { const o = await api.ftpUpload(id, cwd); if (o.length) { toast(`${o.length} arquivo(s) enviado(s)`, true); load(cwd); } } catch (e) { toast(errMsg(e)); }
    } },
    { label: 'Fechar', onClick: (c) => c(true) },
  ]);
  api.ftpClose(id);
}

function parseQuick(input) {
  let s = input.trim();
  let protocol = 'ssh';
  const m = s.match(/^(ssh|telnet):\/\/(.+)$/i);
  if (m) { protocol = m[1].toLowerCase(); s = m[2]; }
  let username = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) { username = s.slice(0, at); s = s.slice(at + 1); }
  const pm = s.match(/^(.*?)(?::(\d+))?$/);
  return { protocol, username, address: pm[1], port: pm[2] || '' };
}

$('#quick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#quickInput').value.trim();
  if (!v) return;
  const a = parseQuick(v);
  if (!a.address) return;
  if (a.protocol === 'ssh' && !a.username) {
    const inp = h('input', { placeholder: 'usuário' });
    const u = await dialog('Usuário SSH', field(`Usuário para ${a.address}`, inp), [
      { label: 'Cancelar', onClick: (c) => c(null) }, { label: 'OK', cls: 'primary', onClick: (c) => c(inp.value.trim()) }]);
    if (!u) return;
    a.username = u;
  }
  $('#quickInput').value = '';
  newTab({ name: a.address, protocol: a.protocol, adhoc: a });
});

$('#btnBroadcast').onclick = () => {
  broadcast = !broadcast;
  $('#btnBroadcast').classList.toggle('on', broadcast);
  for (const t of tabList) t.tabEl.classList.toggle('bc', broadcast);
  toast(broadcast ? 'Multi-exec LIGADO: o que você digitar vai para todos os painéis conectados' : 'Multi-exec desligado', true);
};

$('#btnReconnect').onclick = () => {
  if (!activePane) return;
  if (activePane.connected) api.close(activePane.sid);
  activePane.term.writeln('');
  connect(activePane);
  activePane.term.focus();
};

// Dividir o painel atual: Ctrl+Shift+D / E repetem o mesmo host; os botões ◫ ⬒ deixam ESCOLHER o host.
const splitHere = (side) => {
  const p = activePane;
  if (!p) return toast('Abra uma conexão primeiro');
  splitOpen(p, side, { name: p.name, protocol: p.protocol, hostId: p.hostId, adhoc: p.adhoc });
};

async function splitPick(side) {
  const p = activePane;
  if (!p) return toast('Abra uma conexão primeiro');
  let chosen = { same: true };
  const q = h('input', { type: 'search', placeholder: 'Buscar host… (duplo clique abre direto)' });
  const list = h('div', { class: 'list pick-list' });
  const entries = () => [
    { same: true, label: '⧉ Mesmo host (' + p.name + ')' },
    ...S.hosts.slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ host: x, label: x.name + '   [' + x.protocol.toUpperCase() + ']' })),
  ];
  const render = () => {
    list.replaceChildren();
    const term = q.value.trim().toLowerCase();
    entries().filter((e) => e.same || !term || e.label.toLowerCase().includes(term) || (e.host.host || '').toLowerCase().includes(term)).forEach((e) => {
      const on = (chosen.same && e.same) || (chosen.host && e.host && chosen.host.id === e.host.id);
      list.append(h('button', {
        type: 'button', class: on ? 'pick on' : 'pick', style: 'text-align:left',
        onclick: () => { chosen = e; render(); },
        ondblclick: (ev) => { chosen = e; ev.target.closest('dialog').querySelector('button.primary').click(); },
      }, e.label));
    });
  };
  q.addEventListener('input', render);
  render();
  const ok = await dialog(side === 'right' ? 'Dividir lado a lado' : 'Dividir empilhado',
    [h('div', { class: 'muted' }, 'Escolha qual host abrir no novo painel.'), field('Host', q), list],
    [cancelBtn, { label: 'Dividir', cls: 'primary', onClick: (c) => c(true) }]);
  if (!ok) return;
  if (chosen.same) splitHere(side);
  else splitOpen(p, side, { name: chosen.host.name, protocol: chosen.host.protocol, hostId: chosen.host.id });
}
// Botões da barra superior nunca ficam com o foco do teclado: assim o Enter/Espaço digitado no terminal não
// aciona por engano "↻ reconectar" ou "dividir". Clique vindo do teclado tem detail === 0 e é ignorado.
const topbarEl = $('.topbar');
topbarEl.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('button')) e.preventDefault(); });
topbarEl.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('button') && e.detail === 0) { e.preventDefault(); e.stopPropagation(); }
}, true);

$('#btnSplitH').onclick = () => splitPick('right');
$('#btnSplitV').onclick = () => splitPick('bottom');

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyW' && activePane) { closePane(activePane); e.preventDefault(); }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD' && activePane) { splitHere('right'); e.preventDefault(); }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyE' && activePane) { splitHere('bottom'); e.preventDefault(); }
  if (e.ctrlKey && e.code === 'Tab' && tabList.length > 1) {
    const idx = tabList.indexOf(activeTab);
    activate(tabList[(idx + (e.shiftKey ? tabList.length - 1 : 1)) % tabList.length]);
    e.preventDefault();
  }
});

new ResizeObserver(() => scheduleFit()).observe($('#terms'));

// ---- arrastar um host da lista para dentro do terminal: soltar nas bordas divide, no centro abre aba ----
const termsEl = $('#terms');
const dropHint = h('div', { class: 'drop-hint', hidden: true });
termsEl.append(dropHint);

function dropInfo(e) {
  const pw = e.target && e.target.closest ? e.target.closest('.pane') : null;
  const pane = pw ? [...panes.values()].find((p) => p.wrap === pw) : null;
  if (!pane) return { pane: null, zone: 'center', rect: termsEl.getBoundingClientRect() };
  const r = pw.getBoundingClientRect();
  return { pane, zone: Layout.zoneFor(r.width, r.height, e.clientX - r.left, e.clientY - r.top), rect: r };
}

function showDropHint({ pane, zone, rect }) {
  const base = termsEl.getBoundingClientRect();
  const f = Layout.hintRect(pane ? zone : 'center');
  dropHint.style.left = `${rect.left - base.left + f.x * rect.width}px`;
  dropHint.style.top = `${rect.top - base.top + f.y * rect.height}px`;
  dropHint.style.width = `${f.w * rect.width}px`;
  dropHint.style.height = `${f.h * rect.height}px`;
  dropHint.textContent = !pane || zone === 'center' ? 'Abrir em nova aba' : 'Abrir dividindo aqui';
  dropHint.hidden = false;
}

termsEl.addEventListener('dragover', (e) => {
  if (dragPane) {
    const info = dropInfo(e);
    if (!info.pane || info.pane === dragPane) { dropHint.hidden = true; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDropHint(info);
    dropHint.textContent = info.zone === 'center' ? 'Trocar de lugar' : 'Mover para cá';
    return;
  }
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('text/plain')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  showDropHint(dropInfo(e));
});
termsEl.addEventListener('dragleave', (e) => { if (!termsEl.contains(e.relatedTarget)) dropHint.hidden = true; });
termsEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dropHint.hidden = true;
  if (dragPane) {
    const info = dropInfo(e);
    const p = dragPane; dragPane = null;
    if (info.pane && info.pane !== p && info.pane.tab === p.tab) movePaneInTab(p, info.pane, info.zone);
    return;
  }
  let d;
  try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
  if (!d || d.t !== 'host') return;
  const x = hostById(d.id);
  if (!x) return;
  const info = dropInfo(e);
  const host = { name: x.name, protocol: x.protocol, hostId: x.id };
  if (!info.pane || info.zone === 'center') newTab(host); else splitOpen(info.pane, info.zone, host);
});

// ---------------------------------------------------------------- novidades de cada versão e aviso de atualização
const verParts = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
const verNewer = (a, b) => { const x = verParts(a); const y = verParts(b); if (!x || !y) return false; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const entriesNode = (list) => h('div', { class: 'list', style: 'max-height:340px;overflow:auto' },
  ...list.map((e) => h('div', {}, h('b', {}, 'v' + e.version), ' ', h('span', { class: 'muted' }, e.date || ''),
    h('ul', { style: 'margin:4px 0 10px 18px;padding:0' }, ...e.itens.map((i) => h('li', {}, i))))));

async function showUpdate(u, cur) {
  await dialog('Nova versão disponível: ' + u.version, [
    h('div', { class: 'muted' }, `Você está na versão ${cur}.`),
    h('pre', { style: 'white-space:pre-wrap;max-height:260px;overflow:auto;margin:8px 0' }, u.notes || 'Sem descrição.'),
  ], [
    { label: 'Ignorar esta versão', onClick: (c) => { try { localStorage.setItem('skipVersion', u.version); } catch { /* ignora */ } c(true); } },
    { label: 'Depois', onClick: (c) => c(true) },
    { label: 'Abrir downloads', cls: 'primary', onClick: async (c) => { try { await api.openExternal(u.url); } catch (e) { toast(errMsg(e)); } c(true); } },
  ]);
}

async function startupNotices() {
  if (MOBILE || !api.changelog) return;
  let cur = '';
  try {
    cur = await api.version();
    let last = null;
    try { last = localStorage.getItem('lastSeenVersion'); localStorage.setItem('lastSeenVersion', cur); } catch { /* ignora */ }
    if (last && last !== cur) { // primeira abertura depois de atualizar: mostra o que mudou
      const news = (await api.changelog()).filter((e) => verNewer(e.version, last) && !verNewer(e.version, cur)).slice(0, 6);
      if (news.length) await dialog('Novidades do NetDeck ' + cur, [entriesNode(news)], [{ label: 'Entendi', cls: 'primary', onClick: (c) => c(true) }]);
    }
  } catch { /* sem novidades, segue */ }
  try {
    if (!api.updateCheck) return;
    const u = await api.updateCheck();
    let skip = null; try { skip = localStorage.getItem('skipVersion'); } catch { /* ignora */ }
    if (u && u.available && u.version !== skip) await showUpdate(u, cur);
  } catch { /* sem internet: silêncio */ }
}

async function whatsNewDialog() { // pelo menu Opções
  let cur = '';
  try { cur = await api.version(); } catch { /* ignora */ }
  const list = (await api.changelog()).slice(0, 12);
  const status = h('div', { class: 'muted' }, 'Você está na versão ' + cur + '.');
  await dialog('Novidades e atualizações', [status, entriesNode(list)], [
    { label: 'Procurar atualização', onClick: async () => {
      status.textContent = 'Procurando…';
      try {
        const u = await api.updateCheck();
        if (u && u.available) { status.textContent = 'Há uma versão nova: ' + u.version; await showUpdate(u, cur); }
        else status.textContent = 'Você está na versão mais recente (' + cur + ').';
      } catch (e) { status.textContent = errMsg(e); }
    } },
    { label: 'Fechar', cls: 'primary', onClick: (c) => c(true) },
  ]);
}

// ---------------------------------------------------------------- ferramentas de rede (ping / traceroute / MTR / nslookup / whois / nmap)
const NET_TOOLS = [
  ['ping', 'Ping contínuo (Ctrl+C para parar)'], ['trace', 'Traceroute (caminho até o destino)'], ['mtr', 'MTR (perda e latência por salto)'],
  ['dns', 'DNS (nslookup)'], ['whois', 'Whois (dono do domínio ou IP)'],
  ['nmap', 'Nmap: portas abertas (rápido)'], ['nmapsv', 'Nmap: portas e versões dos serviços'], ['nmapsn', 'Nmap: descobrir equipamentos ativos (ex.: 192.168.0.0/24)'],
];
const NET_LABEL = { ping: 'Ping', trace: 'Trace', mtr: 'MTR', dns: 'DNS', whois: 'Whois', nmap: 'Nmap', nmapsv: 'Nmap -sV', nmapsn: 'Nmap rede' };
const NET_HINT = { whois: 'ex.: exemplo.com.br ou 200.1.2.3', dns: 'ex.: exemplo.com.br', nmapsn: 'ex.: 192.168.0.0/24', nmap: 'IP ou nome', nmapsv: 'IP ou nome' };
if (MOBILE) { $('#btnNet').remove(); $('#btnLocal').remove(); }
else {
  // terminal local: o shell do próprio computador numa aba (como o "Local Terminal" do Termius)
  $('#btnLocal').onclick = () => newTab({ name: 'Terminal local', protocol: 'local', adhoc: { protocol: 'local' } });
  $('#btnNet').onclick = async () => {
    const ph = activePane && (activePane.hostId ? (hostById(activePane.hostId) || {}).address : (activePane.adhoc || {}).address);
    const target = h('input', { value: ph || '', placeholder: 'IP ou nome, ex.: 8.8.8.8', autocomplete: 'off' });
    const tool = sel(NET_TOOLS, 'ping');
    tool.addEventListener('change', () => { target.placeholder = NET_HINT[tool.value] || 'IP ou nome, ex.: 8.8.8.8'; });
    const run = async (close) => {
      const t = target.value.trim();
      if (!t) throw new Error('Informe o destino');
      close(true);
      newTab({ name: `${NET_LABEL[tool.value]} ${t}`, protocol: 'tool', adhoc: { protocol: 'tool', tool: tool.value, address: t } });
    };
    target.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = target.closest('dialog').querySelector('button.primary'); if (b) b.click(); } });
    await dialog('Ferramentas de rede', [
      field('Destino', target), field('Ferramenta', tool),
      h('div', { class: 'muted' }, 'Usa os programas do próprio computador (o Whois já vem no NetDeck) e abre o resultado em uma nova aba. Se faltar algum (traceroute, mtr, nmap), a aba mostra o que instalar. Use o Nmap só em redes suas ou com autorização. Ctrl+C na aba para parar; ↻ roda de novo.'),
    ], [cancelBtn, { label: 'Executar', cls: 'primary', onClick: run }]);
  };
}

// ---------------------------------------------------------------- SFTP
$('#btnSftp').onclick = async () => {
  const tab = activePane;
  if (!tab || !tab.connected || tab.protocol !== 'ssh') return toast('Abra uma aba SSH conectada primeiro');
  let cwd = '.';
  let selected = null;
  let scpMode = false; // equipamento sem SFTP: cai para SCP (sem lista de pastas, só pelo caminho)
  let loaded = false;
  const remoteIn = h('input', { placeholder: 'ex.: flash:/config.cfg  ou  /tmp/firmware.bin' });
  const pathEl = h('div', { class: 'sftp-path muted' });
  const listEl = h('div', { class: 'list', style: 'min-height:260px' });

  async function load(p) {
    try {
      const r = await api.sftpList(tab.sid, p);
      cwd = r.path;
      selected = null;
      pathEl.textContent = cwd;
      const items = [];
      if (cwd !== '/') items.push(h('div', { class: 'sftp-row', ondblclick: () => load(cwd.replace(/\/[^/]+\/?$/, '') || '/') }, '↩', '..', '', ''));
      r.items.forEach((it) => {
        const row = h('div', {
          class: 'sftp-row',
          onclick: () => { listEl.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel')); row.classList.add('sel'); selected = it.isDir ? null : it; },
          ondblclick: () => { if (it.isDir) load((cwd === '/' ? '' : cwd) + '/' + it.name); },
        }, it.isDir ? '📁' : '📄', it.name, it.isDir ? '' : fmtSize(it.size), new Date(it.mtime).toLocaleString());
        items.push(row);
      });
      listEl.replaceChildren(...items);
      loaded = true;
    } catch (e) {
      if (loaded || scpMode) return toast(errMsg(e));
      scpMode = true; // primeira tentativa falhou: este equipamento não tem SFTP
      pathEl.textContent = 'O equipamento não respondeu ao SFTP (' + errMsg(e) + '). Modo SCP ligado.';
      listEl.replaceChildren(
        field('Caminho do arquivo no equipamento', remoteIn),
        h('div', { class: 'muted' }, 'SCP não lista pastas: escreva o caminho. Baixar = caminho do arquivo no equipamento. Enviar = caminho de destino (arquivo ou pasta).'));
    }
  }

  const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(1) + ' KB' : n + ' B');
  load('.');
  await dialog(`SFTP — ${tab.name}`, [pathEl, listEl], [
    { label: '⬇ Baixar selecionado', onClick: async () => {
      if (scpMode) {
        const rp = remoteIn.value.trim();
        if (!rp) return toast('Escreva o caminho do arquivo no equipamento');
        try { const f = await api.scpDownload(tab.sid, rp); if (f) toast('Salvo em ' + f, true); } catch (e) { toast(errMsg(e)); }
        return;
      }
      if (!selected) return toast('Clique em um arquivo primeiro');
      const p = await api.sftpDownload(tab.sid, (cwd === '/' ? '' : cwd) + '/' + selected.name);
      if (p) toast('Salvo em ' + p, true);
    } },
    { label: '⬆ Enviar arquivos…', onClick: async () => {
      if (scpMode) {
        const rp = remoteIn.value.trim();
        if (!rp) return toast('Escreva o caminho de destino no equipamento');
        try { const f = await api.scpUpload(tab.sid, rp); if (f) toast('Enviado para ' + f, true); } catch (e) { toast(errMsg(e)); }
        return;
      }
      const r = await api.sftpUpload(tab.sid, cwd);
      if (r.length) { toast(`${r.length} arquivo(s) enviado(s)`, true); load(cwd); }
    } },
    { label: 'Fechar', onClick: (c) => c(true) },
  ]);
};

// ---------------------------------------------------------------- início
setCreating(false);
// mostra a versão do programa (ex.: v0.3.1) na tela de bloqueio, no topo da lista e na tela vazia
if (api.version) {
  api.version().then((v) => {
    document.querySelectorAll('[data-ver]').forEach((el) => { el.textContent = 'v' + v; });
    document.title = 'NetDeck ' + v;
  }).catch(() => {});
}
(async () => {
  try {
    await refreshUsers();
    const auto = !MOBILE && api.rememberAuto ? await api.rememberAuto() : null; // usuário lembrado: abre direto
    if (auto) { S = auto.snapshot; rememberedNow = true; enterApp(auto.user); return; }
    $('#lockPass').focus();
  } catch (e) { showFatal(errMsg(e)); }
})();

// ganchos para a barra de teclas do app Android (Esc, Tab, Ctrl, setas) falarem com o terminal ativo
window.__netdeck = {
  activeSid: () => (activePane && activePane.connected ? activePane.sid : null),
  focusTerminal: () => { if (activePane) activePane.term.focus(); },
};

})();
