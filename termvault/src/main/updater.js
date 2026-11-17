'use strict';
// Aviso de versão nova: consulta a última página de downloads (Release) do projeto no GitHub.
// Só avisa e leva ao link; não instala nada sozinho. Se o repositório for privado ou estiver sem internet, fica quieto.
const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };

function isNewer(a, b) { // a é mais nova que b?
  const x = parse(a); const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

async function checkUpdate({ current, repo, fetchFn = globalThis.fetch, timeoutMs = 8000 }) {
  try {
    const r = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NetDeck' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { available: false };
    const j = await r.json();
    if (!j || !isNewer(j.tag_name, current)) return { available: false };
    return { available: true, version: String(j.tag_name).replace(/^v/, ''), notes: String(j.body || '').slice(0, 4000), url: String(j.html_url || '') };
  } catch { return { available: false }; }
}

// A atualização automática só funciona no instalador do Windows e no AppImage do Linux.
// Versão portátil e .deb continuam só avisando (com o link para baixar).
function canAutoUpdate({ platform = process.platform, env = process.env, packaged = false } = {}) {
  if (!packaged) return false;
  if (platform === 'win32') return !env.PORTABLE_EXECUTABLE_DIR;
  if (platform === 'linux') return !!env.APPIMAGE;
  return false;
}

module.exports = { isNewer, checkUpdate, parse, canAutoUpdate };
