// Barra de teclas e gestos do app Android. Carregado depois do renderer.js.
(function () {
  'use strict';
  const body = document.body;
  const nd = window.__netdeck;
  const api = window.api;

  // --- gaveta de hosts
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  body.append(scrim);
  const open = (v) => body.classList.toggle('side-open', v);
  document.getElementById('mMenu').addEventListener('click', () => open(!body.classList.contains('side-open')));
  scrim.addEventListener('click', () => open(false));

  // toque num host = conectar (no computador é duplo clique); a pasta já abre/fecha no toque
  document.getElementById('tree').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const row = e.target.closest('.row');
    if (!row || !row.querySelector('.dot')) return;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    setTimeout(() => open(false), 60);
  });
  document.getElementById('quick').addEventListener('submit', () => open(false));

  // --- barra de teclas
  const bar = document.getElementById('xkeys');
  const KEYS = [
    ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', 'CTRL'],
    ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
    ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
    ['|', '|'], ['/', '/'], ['-', '-'], ['~', '~'], ['?', '?'], ['Ctrl+C', '\x03'], ['Ctrl+Z', '\x1a'],
  ];
  const ctrlBtn = {};
  for (const [label, seq] of KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (seq === 'CTRL') ctrlBtn.el = b;
    // não deixa o botão roubar o foco do terminal (senão o teclado fecha)
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (seq === 'CTRL') { window.__ndCtrl.armed = !window.__ndCtrl.armed; b.classList.toggle('on', window.__ndCtrl.armed); return; }
      const sid = nd.activeSid();
      if (sid) api.input(sid, seq);
      nd.focusTerminal();
    });
    bar.append(b);
  }
  window.__ndCtrl.listeners.push((on) => ctrlBtn.el.classList.toggle('on', on));

  // só aparece quando há um terminal conectado
  setInterval(() => { bar.hidden = !nd.activeSid(); }, 400);
})();
