'use strict';
// IPv4 digitado com zero à esquerda (ex.: 198.19.0.07) não é reconhecido pelo sistema e vira "ENOTFOUND".
// Aqui os zeros são tirados (198.19.0.7); qualquer outra coisa (nome, IPv6) passa como está.
function normalizeAddress(a) {
  if (typeof a !== 'string') return a;
  const s = a.trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return s;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o.join('.') : s;
}
module.exports = { normalizeAddress };
