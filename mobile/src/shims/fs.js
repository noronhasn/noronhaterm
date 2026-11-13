'use strict';
// "Sistema de arquivos" mínimo para o cofre no Android: guarda os arquivos num armazenamento chave/valor
// (no app é o localStorage do WebView, que fica na área privada do aplicativo). Só texto.
const err = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });

function createFsShim(store, prefix = 'nd:fs:') {
  const key = (p) => prefix + String(p);
  const names = () => { const out = []; for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length)); } return out; };
  const norm = (d) => String(d).replace(/\/+$/, '');
  return {
    constants: { W_OK: 2 },
    existsSync: (p) => store.getItem(key(p)) !== null,
    readFileSync(p) { const v = store.getItem(key(p)); if (v === null) throw err('ENOENT', 'arquivo não encontrado ' + p); return v; },
    writeFileSync(p, data) { store.setItem(key(p), typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); },
    renameSync(a, b) { const v = store.getItem(key(a)); if (v === null) throw err('ENOENT', 'arquivo não encontrado ' + a); store.setItem(key(b), v); store.removeItem(key(a)); },
    unlinkSync(p) { store.removeItem(key(p)); },
    rmSync(p) { store.removeItem(key(p)); },
    mkdirSync() { /* diretórios são só prefixos */ },
    readdirSync(dir) { const d = norm(dir) + '/'; return names().filter((n) => n.startsWith(d) && !n.slice(d.length).includes('/')).map((n) => n.slice(d.length)).sort(); },
    copyFileSync(a, b) { this.writeFileSync(b, this.readFileSync(a)); },
  };
}

module.exports = { createFsShim };
