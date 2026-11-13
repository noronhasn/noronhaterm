'use strict';
// Ponto de entrada do app Android: monta o `window.api` que a interface usa (no computador isso é o preload do Electron).
const { registerPlugin } = require('@capacitor/core');
const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
const { Share } = require('@capacitor/share');
const { Vault } = require('../../src/core/vault');
const { Store } = require('../../src/core/store');
const { TelnetSession } = require('../../src/main/telnet');
const netShim = require('./shims/net');
const { createApp } = require('./appcore');

// __NETDECK_NATIVE__: só o teste do pacote (scripts/smoke-bundle.js) usa, para trocar o código nativo por um de mentira
const plugin = window.__NETDECK_NATIVE__ || registerPlugin('NetDeckNet');

// ponte para o código nativo: chamadas (promessas) + eventos
const native = { on: (ev, cb) => { plugin.addListener(ev, cb); } };
for (const m of ['sshOpen', 'sshWrite', 'sshResize', 'sshClose', 'hostKeyAnswer', 'tcpOpen', 'tcpWrite', 'tcpClose']) native[m] = (a) => plugin[m](a);
netShim.setNative(native);

// arquivos: salvar = gravar no cache do app e abrir a folha de compartilhar (Drive, WhatsApp, e-mail...); escolher = seletor do Android
const files = {
  async save(name, text) {
    await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
    await Share.share({ title: name, text: name, url: uri, dialogTitle: 'Salvar ou enviar ' + name });
  },
  pick() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      document.body.append(input);
      let done = false;
      const finish = (v) => { if (!done) { done = true; input.remove(); resolve(v); } };
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        finish(f ? { name: f.name, text: await f.text() } : null);
      });
      input.addEventListener('cancel', () => finish(null));
      input.click();
    });
  },
};

// Ctrl "grudado" da barra de teclas: a próxima letra digitada vira Ctrl+letra
const ctrl = { armed: false, listeners: [] };
function transformInput(data) {
  if (!ctrl.armed || data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  ctrl.armed = false; ctrl.listeners.forEach((f) => f(false));
  return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : data;
}

const api = createApp({
  Vault, Store, TelnetSession, native, files, fs: require('fs'),
  uuid: () => globalThis.crypto.randomUUID(),
  version: (window.__NETDECK_VERSION__ || ''),
  transformInput,
});
window.api = api;
window.__ndCtrl = ctrl;
