'use strict';
// "path" mínimo (só POSIX) para o cofre.
module.exports = {
  sep: '/',
  dirname: (p) => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i); },
  basename: (p) => String(p).split('/').filter(Boolean).pop() || '',
  join: (...a) => a.join('/').replace(/\/{2,}/g, '/'),
  resolve: (...a) => a.join('/').replace(/\/{2,}/g, '/'),
};
