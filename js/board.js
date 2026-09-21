// ═══════════════════════════════════════════════════════════════
// TABLEAU — géométrie du tableau physique, en coordonnées normalisées
// (u = 0..1 de gauche à droite, v = 0..1 de haut en bas).
// Chaque case connaît sa position et sa valeur.
// ═══════════════════════════════════════════════════════════════
window.Board = (function () {

  // Largeur relative des 5 colonnes principales :
  // [numéro de ligne, colonne gauche, zone centrale, colonne 4, colonne 5]
  const COLS = [0.05, 0.10, 0.60, 0.13, 0.12];
  // Hauteur relative des 10 lignes (la ligne 0 est un peu plus haute)
  const ROWS = [0.115, 0.0983, 0.0983, 0.0983, 0.0983, 0.0983, 0.0983, 0.0983, 0.0983, 0.0985];

  const colX = [0];
  COLS.forEach((w, i) => colX.push(colX[i] + w));
  const rowY = [0];
  ROWS.forEach((h, i) => rowY.push(rowY[i] + h));

  const cells = [];

  // Case simple occupant une ou plusieurs colonnes/lignes principales
  function big(label, value, r0, r1, c0, c1, kind) {
    cells.push({
      id: cells.length, label, value, kind: kind || 'word',
      x0: colX[c0], x1: colX[c1], y0: rowY[r0], y1: rowY[r1]
    });
  }

  // Ligne de sous-cases dans la zone centrale (colonne 2)
  // items : [label, value, kind] ; widths : poids relatifs (optionnel)
  function inner(row, items, widths) {
    const x0 = colX[2], x1 = colX[3], total = x1 - x0;
    const ws = widths || items.map(() => 1);
    const sum = ws.reduce((a, b) => a + b, 0);
    let x = x0;
    items.forEach((it, i) => {
      const w = total * ws[i] / sum;
      if (it) {
        cells.push({
          id: cells.length, label: it[0], value: it[1], kind: it[2] || 'sound',
          x0: x, x1: x + w, y0: rowY[row], y1: rowY[row + 1]
        });
      }
      x += w;
    });
  }

  const S = 'sound', W = 'word';

  // Ligne 0
  inner(0, [['non', 'non', 'non'], ['est-ce que ?', 'est-ce que', W], ['ça va', 'ça va', W], ['il y a', 'il y a', W]], [1.3, 1, 1, 1]);
  big('oui', 'oui', 0, 2, 3, 5, W);
  // Ligne 1
  big('s.v.p.', "s'il vous plaît", 1, 4, 1, 2, W);
  inner(1, [['p', 'p', S], ['t', 't', S], ['k', 'k', S], ['r', 'r', S], ['f', 'f', S], ['s', 's', S], ['ch', 'ch', S]]);
  big('n', 'n', 1, 2, 3, 4, S);
  // Ligne 2
  inner(2, [['b', 'b', S], ['d', 'd', S], ['g', 'g', S], ['l', 'l', S], ['v', 'v', S], ['z', 'z', S], ['j', 'j', S]]);
  big('gn', 'gn', 2, 4, 3, 4, S);
  big('pardon', 'pardon', 2, 3, 4, 5, W);
  // Ligne 3
  inner(3, [null, null, null, null, null, null, ['m', 'm', S]]);
  // Ligne 4
  inner(4, [['vous', 'vous', W], ['il', 'il', W], ['je', 'je', W], ['tu', 'tu', W], ['elle', 'elle', W], ['nous', 'nous', W]]);
  // Ligne 5
  big('merci', 'merci', 5, 6, 1, 2, W);
  inner(5, [['e', 'e', S], ['u', 'u', S], ['a', 'a', S], ['o', 'o', S], ['é', 'é', S], ['i', 'i', S]]);
  big('salut', 'salut', 5, 6, 4, 5, W);
  // Ligne 6
  inner(6, [['oe', 'oe', S], ['ou', 'ou', S], ['an', 'an', S], ['on', 'on', S], ['è', 'è', S], ['in', 'in', S]]);
  // Ligne 8
  big('tu as compris ?', 'tu as compris ?', 8, 9, 1, 2, W);
  inner(8, [['ieu', 'ieu', S], ['ui', 'ui', S], ['oi', 'oi', S], ['ill', 'ill', S], ['oin', 'oin', S], ['un', 'un', S], ['ien', 'ien', S]]);
  big('au revoir', 'au revoir', 8, 10, 4, 5, W);
  // Ligne 9
  inner(9, [['pourquoi', 'pourquoi', W], ['quand', 'quand', W], ['où', 'où', W], ['comment', 'comment', W], ['combien', 'combien', W]]);

  /** Case contenant le point (u,v), sinon la case la plus proche si elle est à moins de `tol`. */
  function cellAt(u, v, tol) {
    tol = tol == null ? 0.025 : tol;
    let best = null, bestD = Infinity;
    for (const c of cells) {
      if (u >= c.x0 && u < c.x1 && v >= c.y0 && v < c.y1) return c;
      const dx = Math.max(c.x0 - u, 0, u - c.x1);
      const dy = Math.max(c.y0 - v, 0, v - c.y1);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = c; }
    }
    return bestD <= tol ? best : null;
  }

  return { cells, cellAt, colX, rowY };
})();
