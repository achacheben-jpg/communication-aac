// ═══════════════════════════════════════════════════════════════
// TABLEAU — géométrie du tableau physique, mesurée sur la photo
// redressée (cadre rouge extérieur = repère 0..1).
// u = 0..1 de gauche à droite, v = 0..1 de haut en bas.
// ═══════════════════════════════════════════════════════════════
window.Board = (function () {

  const PW = 1200, PH = 735;   // taille de la photo redressée utilisée pour mesurer
  const cells = [];
  const S = 'sound', W = 'word';

  // Ajoute une case mesurée en pixels de la photo redressée
  function add(label, value, kind, x0, y0, x1, y1) {
    cells.push({ id: cells.length, label, value, kind, x0: x0 / PW, y0: y0 / PH, x1: x1 / PW, y1: y1 / PH });
  }
  // Ligne de cases côte à côte : xs = frontières, items = [label, value, kind]
  function row(y0, y1, xs, items) {
    items.forEach((it, i) => { if (it) add(it[0], it[1], it[2], xs[i], y0, xs[i + 1], y1); });
  }

  // Ligne 0
  row(0, 90, [0, 190, 520, 735, 1000, 1200],
    [['non', 'non', 'non'], ['est-ce que ?', 'est-ce que', W], ['ça va', 'ça va', W], ['il y a', 'il y a', W], ['oui', 'oui', W]]);

  // Colonne de gauche
  add('s.v.p.', "s'il vous plaît", W, 0, 90, 140, 290);
  add('merci', 'merci', W, 0, 290, 140, 465);
  add('tu as compris ?', 'tu as compris ?', W, 0, 465, 140, 635);

  // Lignes p / b (7 colonnes)
  const X7 = [140, 262, 368, 500, 620, 740, 840, 960];
  row(90, 205, X7, [['p', 'p', S], ['t', 't', S], ['k', 'k', S], ['r', 'r', S], ['f', 'f', S], ['s', 's', S], ['ch', 'ch', S]]);
  row(205, 290, X7, [['b', 'b', S], ['d', 'd', S], ['g', 'g', S], ['l', 'l', S], ['v', 'v', S], ['z', 'z', S], ['j', 'j', S]]);
  // Colonne n / gn / m
  add('n', 'n', S, 960, 90, 1105, 165);
  add('gn', 'gn', S, 960, 165, 1105, 230);
  add('m', 'm', S, 960, 230, 1105, 290);
  // Colonne de droite
  add('pardon', 'pardon', W, 1105, 90, 1200, 290);
  add('salut', 'salut', W, 1105, 290, 1200, 465);
  add('au revoir', 'au revoir', W, 1105, 465, 1200, 635);

  // Lignes à 6 colonnes
  const X6 = [140, 295, 455, 620, 780, 945, 1105];
  row(290, 380, X6, [['vous', 'vous', W], ['il', 'il', W], ['je', 'je', W], ['tu', 'tu', W], ['elle', 'elle', W], ['nous', 'nous', W]]);
  row(380, 465, X6, [['e', 'e', S], ['u', 'u', S], ['a', 'a', S], ['o', 'o', S], ['é', 'é', S], ['i', 'i', S]]);
  row(465, 550, X6, [['oe', 'oe', S], ['ou', 'ou', S], ['an', 'an', S], ['on', 'on', S], ['è', 'è', S], ['in', 'in', S]]);
  // Ligne ieu (7 colonnes, "ill" est une petite case ajoutée entre oi et oin)
  row(550, 635, [140, 295, 455, 560, 690, 800, 945, 1105],
    [['ieu', 'ieu', S], ['ui', 'ui', S], ['oi', 'oi', S], ['ill', 'ill', S], ['oin', 'oin', S], ['un', 'un', S], ['ien', 'ien', S]]);

  // Dernière ligne
  row(635, 735, [0, 275, 500, 735, 975, 1200],
    [['pourquoi', 'pourquoi', W], ['quand', 'quand', W], ['où', 'où', W], ['comment', 'comment', W], ['combien', 'combien', W]]);

  /** Case contenant le point (u,v), sinon la case la plus proche si elle est à moins de `tol`. */
  function cellAt(u, v, tol) {
    tol = tol == null ? 0.03 : tol;
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

  return { cells, cellAt, aspect: PW / PH };
})();
