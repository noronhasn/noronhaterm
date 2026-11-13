'use strict';
// Árvore de painéis de uma aba. Folha = um terminal; divisão = dois filhos lado a lado ou empilhados.
// Lógica pura (sem DOM) para poder ser testada fora do Electron.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.Layout = lib;
}(typeof self !== 'undefined' ? self : this, () => {
  const SIDES = ['left', 'right', 'top', 'bottom'];

  const leaf = (pane) => ({ kind: 'pane', pane });

  function leaves(node, out = []) {
    if (!node) return out;
    if (node.kind === 'pane') out.push(node.pane);
    else { leaves(node.a, out); leaves(node.b, out); }
    return out;
  }

  function findLeaf(node, pane) {
    if (!node) return null;
    if (node.kind === 'pane') return node.pane === pane ? node : null;
    return findLeaf(node.a, pane) || findLeaf(node.b, pane);
  }

  // Devolve { parent, key } de quem aponta para `target`, ou null se `target` é a raiz.
  function findParent(node, target) {
    if (!node || node.kind === 'pane') return null;
    if (node.a === target) return { parent: node, key: 'a' };
    if (node.b === target) return { parent: node, key: 'b' };
    return findParent(node.a, target) || findParent(node.b, target);
  }

  // Divide o painel `target` e coloca `newPane` do lado `side`. Devolve a (possivelmente nova) raiz.
  function split(rootNode, target, side, newPane) {
    if (!SIDES.includes(side)) throw new Error('Lado inválido: ' + side);
    const tl = findLeaf(rootNode, target);
    if (!tl) throw new Error('Painel não encontrado');
    const nl = leaf(newPane);
    const first = side === 'left' || side === 'top';
    const node = {
      kind: 'split', dir: side === 'left' || side === 'right' ? 'row' : 'col', ratio: 0.5,
      a: first ? nl : tl, b: first ? tl : nl,
    };
    const p = findParent(rootNode, tl);
    if (!p) return node;
    p.parent[p.key] = node;
    return rootNode;
  }

  // Remove o painel; o irmão ocupa o lugar da divisão. Devolve a nova raiz (null se ficou vazio).
  function remove(rootNode, pane) {
    const l = findLeaf(rootNode, pane);
    if (!l) return rootNode;
    const p = findParent(rootNode, l);
    if (!p) return null;
    const sibling = p.key === 'a' ? p.parent.b : p.parent.a;
    const gp = findParent(rootNode, p.parent);
    if (!gp) return sibling;
    gp.parent[gp.key] = sibling;
    return rootNode;
  }

  const clampRatio = (r) => Math.min(0.9, Math.max(0.1, Number.isFinite(r) ? r : 0.5));

  // Em qual zona de um painel (largura w, altura h) o cursor (x, y) está? Centro = nova aba.
  function zoneFor(w, h, x, y) {
    if (w <= 0 || h <= 0) return 'center';
    const fx = x / w; const fy = y / h;
    const m = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (m > 0.25) return 'center';
    if (m === fx) return 'left';
    if (m === 1 - fx) return 'right';
    if (m === fy) return 'top';
    return 'bottom';
  }

  // Retângulo (frações do painel) que mostra onde o novo terminal vai entrar.
  function hintRect(zone) {
    switch (zone) {
      case 'left': return { x: 0, y: 0, w: 0.5, h: 1 };
      case 'right': return { x: 0.5, y: 0, w: 0.5, h: 1 };
      case 'top': return { x: 0, y: 0, w: 1, h: 0.5 };
      case 'bottom': return { x: 0, y: 0.5, w: 1, h: 0.5 };
      default: return { x: 0, y: 0, w: 1, h: 1 };
    }
  }

  return { leaf, leaves, findLeaf, findParent, split, remove, clampRatio, zoneFor, hintRect };
}));
