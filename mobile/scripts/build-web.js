'use strict';
// Monta a pasta www/ do app Android: a interface do computador (src/renderer) + o pacote do celular (mobile.js).
// Rodar dentro de mobile/ depois de `npm install` aqui e na raiz do projeto (para o xterm).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const here = path.join(__dirname, '..');
const root = path.join(here, '..');
const www = path.join(here, 'www');
const pkg = require('../package.json');

const xtermDir = path.join(root, 'node_modules', '@xterm');
const need = [
  path.join(xtermDir, 'xterm', 'lib', 'xterm.js'),
  path.join(xtermDir, 'xterm', 'css', 'xterm.css'),
  path.join(xtermDir, 'addon-fit', 'lib', 'addon-fit.js'),
];
for (const f of need) if (!fs.existsSync(f)) throw new Error('Falta ' + f + ' — rode "npm install" na pasta raiz do projeto');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });
for (const f of need) fs.copyFileSync(f, path.join(www, 'vendor', path.basename(f)));
for (const f of ['styles.css', 'layout.js', 'renderer.js']) fs.copyFileSync(path.join(root, 'src', 'renderer', f), path.join(www, f));
for (const f of ['mobile.css', 'keybar.js']) fs.copyFileSync(path.join(here, 'web', f), path.join(www, f));
fs.writeFileSync(path.join(www, 'version.js'), `window.__NETDECK_VERSION__ = ${JSON.stringify(pkg.version)};\n`);

// o código do computador pede crypto/fs/path/net/keys do Node: no celular entram os substitutos
const shims = path.join(here, 'src', 'shims');
const alias = {
  name: 'netdeck-alias',
  setup(b) {
    const map = { crypto: 'crypto-runtime.js', fs: 'fs-runtime.js', path: 'path.js', net: 'net.js' };
    b.onResolve({ filter: /^(crypto|fs|path|net)$/ }, (a) => ({ path: path.join(shims, map[a.path]) }));
    b.onResolve({ filter: /^\.\/keys$/ }, (a) => (a.importer.includes(path.join('src', 'core')) ? { path: path.join(shims, 'keys.js') } : undefined));
  },
};

esbuild.build({
  entryPoints: [path.join(here, 'src', 'entry.js')],
  outfile: path.join(www, 'mobile.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2019', minify: true, legalComments: 'none',
  inject: [path.join(shims, 'buffer-global.js')],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  plugins: [alias],
  logLevel: 'info',
}).then(() => {
  let html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  const sub = (a, b) => { if (!html.includes(a)) throw new Error('index.html mudou: não achei ' + a.slice(0, 50)); html = html.replace(a, b); };
  // o Android injeta a ponte do Capacitor dentro da página: precisa de script inline
  sub(/<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html)[0],
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\'; connect-src \'self\'">');
  sub('../../node_modules/@xterm/xterm/css/xterm.css', 'vendor/xterm.css');
  sub('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="mobile.css">');
  sub('../../node_modules/@xterm/xterm/lib/xterm.js', 'vendor/xterm.js');
  sub('../../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'vendor/addon-fit.js');
  sub('<script src="layout.js"></script>', '<script src="version.js"></script>\n  <script src="mobile.js"></script>\n  <script src="layout.js"></script>');
  sub('<div class="topbar">', '<div class="topbar">\n        <button id="mMenu" title="Hosts">☰</button>');
  sub('<script src="renderer.js"></script>', '<script src="renderer.js"></script>\n  <script src="keybar.js"></script>');
  sub('<div id="status" class="status"></div>', '<div id="status" class="status"></div>\n      <div id="xkeys" class="xkeys" hidden></div>');
  fs.writeFileSync(path.join(www, 'index.html'), html);
  console.log('www pronto:', fs.readdirSync(www).join(', '));
}).catch((e) => { console.error(e); process.exit(1); });
