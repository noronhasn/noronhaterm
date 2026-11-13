'use strict';
// Ajusta o projeto Android gerado por `npx cap add android`: coloca o plugin nativo (SSH/TCP), a biblioteca JSch,
// o ícone e a versão. Pode rodar várias vezes (idempotente). Rodar dentro de mobile/.
const fs = require('fs');
const path = require('path');

const here = path.join(__dirname, '..');
const android = path.join(here, 'android');
const overlay = path.join(here, 'android-overlay');
const pkg = require('../package.json');
if (!fs.existsSync(android)) throw new Error('Não existe mobile/android — rode "npx cap add android" antes');

const read = (f) => fs.readFileSync(f, 'utf8');
const edit = (f, fn) => { const a = read(f); const b = fn(a); if (a !== b) fs.writeFileSync(f, b); return a !== b; };

// 1) código nativo
const javaDir = path.join(android, 'app', 'src', 'main', 'java', 'com', 'netdeck', 'app');
fs.mkdirSync(javaDir, { recursive: true });
for (const f of fs.readdirSync(overlay).filter((x) => x.endsWith('.java'))) fs.copyFileSync(path.join(overlay, f), path.join(javaDir, f));

// 2) JSch (SSH com algoritmos antigos), versão do app
const [maj, min, pat] = pkg.version.split('.').map(Number);
edit(path.join(android, 'app', 'build.gradle'), (g) => {
  if (!g.includes('com.github.mwiede:jsch')) {
    if (!/^dependencies\s*\{/m.test(g)) throw new Error('app/build.gradle sem bloco dependencies');
    g = g.replace(/^dependencies\s*\{/m, (m) => `${m}\n    implementation 'com.github.mwiede:jsch:0.2.20'`);
  }
  return g.replace(/versionCode\s+\d+/, `versionCode ${maj * 10000 + min * 100 + pat}`).replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
});
// CompletableFuture (confirmação da chave do servidor) exige Android 7.0+
const vars = path.join(android, 'variables.gradle');
if (fs.existsSync(vars)) edit(vars, (v) => v.replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 24'));

// 3) manifesto: teclado redimensiona a tela; sem backup automático do Google (o cofre fica só no aparelho)
const manifest = path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml');
edit(manifest, (m) => {
  if (!m.includes('windowSoftInputMode')) m = m.replace('<activity', '<activity\n            android:windowSoftInputMode="adjustResize"');
  return m.replace('android:allowBackup="true"', 'android:allowBackup="false"');
});

// 4) ícone e tela de abertura
const res = path.join(android, 'app', 'src', 'main', 'res');
fs.rmSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true }); // ícone adaptativo do modelo (logo do Capacitor)
for (const d of fs.readdirSync(path.join(overlay, 'res')).filter((x) => x.startsWith('mipmap-'))) {
  fs.mkdirSync(path.join(res, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(overlay, 'res', d))) fs.copyFileSync(path.join(overlay, 'res', d, f), path.join(res, d, f));
}
const splash = path.join(overlay, 'res', 'splash.png');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(res)) if (path.basename(f) === 'splash.png') fs.copyFileSync(splash, f);

console.log('projeto Android ajustado (versão ' + pkg.version + ')');
