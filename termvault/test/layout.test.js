'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/layout');

const P = (n) => ({ name: n });
const names = (root) => L.leaves(root).map((p) => p.name).join(',');

test('layout: dividir um painel único cria uma divisão lado a lado', () => {
  const a = P('a'), b = P('b');
  let root = L.leaf(a);
  root = L.split(root, a, 'right', b);
  assert.equal(root.kind, 'split');
  assert.equal(root.dir, 'row');
  assert.equal(names(root), 'a,b');
  root = L.split(L.leaf(a), a, 'left', b);
  assert.equal(names(root), 'b,a', 'esquerda coloca o novo antes');
});

test('layout: top/bottom empilham', () => {
  const a = P('a'), b = P('b'), c = P('c');
  let root = L.split(L.leaf(a), a, 'bottom', b);
  assert.equal(root.dir, 'col');
  assert.equal(names(root), 'a,b');
  root = L.split(root, a, 'top', c);
  assert.equal(names(root), 'c,a,b');
});

test('layout: grade 2x2 (dividir os dois lados) mantém todos os painéis', () => {
  const a = P('a'), b = P('b'), c = P('c'), d = P('d');
  let root = L.split(L.leaf(a), a, 'right', b);
  root = L.split(root, a, 'bottom', c);
  root = L.split(root, b, 'bottom', d);
  assert.equal(L.leaves(root).length, 4);
  assert.deepEqual(new Set(L.leaves(root).map((p) => p.name)), new Set(['a', 'b', 'c', 'd']));
});

test('layout: remover devolve o espaço ao irmão e a raiz some se for o último', () => {
  const a = P('a'), b = P('b'), c = P('c');
  let root = L.split(L.leaf(a), a, 'right', b);
  root = L.split(root, b, 'bottom', c);
  assert.equal(names(root), 'a,b,c');
  root = L.remove(root, b);
  assert.equal(names(root), 'a,c');
  root = L.remove(root, a);
  assert.equal(root.kind, 'pane');
  assert.equal(root.pane, c);
  assert.equal(L.remove(root, c), null);
});

test('layout: remover painel inexistente não altera nada e dividir inexistente falha', () => {
  const a = P('a'), x = P('x');
  const root = L.leaf(a);
  assert.equal(L.remove(root, x), root);
  assert.throws(() => L.split(root, x, 'right', P('n')), /não encontrado/);
  assert.throws(() => L.split(root, a, 'meio', P('n')), /Lado inválido/);
});

test('layout: zoneFor identifica bordas e centro', () => {
  assert.equal(L.zoneFor(1000, 600, 500, 300), 'center');
  assert.equal(L.zoneFor(1000, 600, 50, 300), 'left');
  assert.equal(L.zoneFor(1000, 600, 960, 300), 'right');
  assert.equal(L.zoneFor(1000, 600, 500, 20), 'top');
  assert.equal(L.zoneFor(1000, 600, 500, 590), 'bottom');
  assert.equal(L.zoneFor(0, 0, 0, 0), 'center');
});

test('layout: hintRect cobre a metade certa e clampRatio limita o divisor', () => {
  assert.deepEqual(L.hintRect('right'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(L.hintRect('top'), { x: 0, y: 0, w: 1, h: 0.5 });
  assert.equal(L.clampRatio(0.01), 0.1);
  assert.equal(L.clampRatio(0.99), 0.9);
  assert.equal(L.clampRatio(NaN), 0.5);
  assert.equal(L.clampRatio(0.3), 0.3);
});

test('css: classes de direção das divisões não colidem com a ".row" da lista de hosts', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.match(css, /^\.row \{/m, 'a classe .row da lista continua existindo');
  assert.doesNotMatch(css, /\.(split|gutter)\.(row|col)\b/, 'divisões não podem usar .row/.col (herdariam o estilo da lista)');
  assert.match(css, /\.split\.dir-row/);
  assert.match(js, /'split dir-' \+ node\.dir/);
  assert.match(js, /'gutter dir-' \+ node\.dir/);
});
