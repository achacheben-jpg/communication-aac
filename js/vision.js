// ═══════════════════════════════════════════════════════════════
// VISION — détection de la pointe du pied sur le tableau.
//
// Principe : après calibration (4 coins du tableau), on "redresse" le
// tableau dans une petite image (W×H). On mémorise une image de
// référence du tableau vide. À chaque image de la caméra, on compare
// avec la référence : ce qui a changé, c'est le pied (ou sa jambe).
// La pointe = l'extrémité de cette zone la plus éloignée du côté par
// lequel le pied entre sur le tableau.
// ═══════════════════════════════════════════════════════════════
window.Vision = (function () {

  const W = 128, H = 96;          // résolution du tableau redressé
  const FW = 640, FH = 360;       // résolution d'analyse de la caméra

  const frame = document.createElement('canvas');
  frame.width = FW; frame.height = FH;
  const fctx = frame.getContext('2d', { willReadFrequently: true });

  let corners = null;             // 4 coins en coordonnées normalisées vidéo (0..1)
  let lut = null;                 // index pixel source pour chaque point du tableau
  let ref = null;                 // Float32Array RGB de référence (W*H*3)
  const cur = new Float32Array(W * H * 3);
  const mask = new Uint8Array(W * H);
  const mask2 = new Uint8Array(W * H);

  // ── Homographie carré unité → quadrilatère (Heckbert) ──
  function squareToQuad(p) {
    const [p0, p1, p2, p3] = p; // HG, HD, BD, BG
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
    let g, h;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) { g = 0; h = 0; }
    else {
      const den = dx1 * dy2 - dx2 * dy1;
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
    const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
    const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
    return (u, v) => {
      const w = g * u + h * v + 1;
      return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
    };
  }

  function setCorners(c) {
    corners = c.map(p => ({ x: p.x, y: p.y }));
    const map = squareToQuad(corners);
    lut = new Int32Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const q = map((i + 0.5) / W, (j + 0.5) / H);
        const x = Math.min(FW - 1, Math.max(0, Math.round(q.x * FW)));
        const y = Math.min(FH - 1, Math.max(0, Math.round(q.y * FH)));
        lut[j * W + i] = (y * FW + x) * 4;
      }
    }
    ref = null;
  }

  function getCorners() { return corners; }
  function hasReference() { return !!ref; }

  /** Lit l'image vidéo et remplit `cur` (tableau redressé). */
  function grab(video) {
    fctx.drawImage(video, 0, 0, FW, FH);
    const d = fctx.getImageData(0, 0, FW, FH).data;
    for (let k = 0; k < W * H; k++) {
      const s = lut[k];
      cur[k * 3] = d[s]; cur[k * 3 + 1] = d[s + 1]; cur[k * 3 + 2] = d[s + 2];
    }
  }

  /** Mémorise l'image actuelle comme tableau vide. */
  function captureReference(video) {
    if (!lut) return false;
    grab(video);
    ref = new Float32Array(cur);
    return true;
  }

  /**
   * Analyse une image. Options :
   *  threshold : sensibilité (différence de couleur minimale, 10..120)
   *  entry     : côté par lequel le pied entre ('bottom'|'top'|'left'|'right')
   *  offset    : décalage de la pointe (en fraction du tableau, ± 0.1)
   *  adapt     : mettre à jour lentement la référence quand rien ne bouge
   * Retour : { present, u, v, area, mask }
   */
  function analyze(video, opt) {
    if (!lut || !ref) return { present: false };
    grab(video);
    const thr = opt.threshold;
    // Mode "chaussette sombre" : en plus d'avoir changé par rapport à la
    // référence, le point doit être sombre (le tableau est jaune/bleu clair,
    // les ombres restent plus claires qu'une chaussette noire).
    const dark = opt.darkSock ? (opt.darkLevel || 80) : 999;
    let count = 0;
    for (let k = 0; k < W * H; k++) {
      const r = cur[k * 3], g = cur[k * 3 + 1], b = cur[k * 3 + 2];
      const d = Math.max(Math.abs(r - ref[k * 3]), Math.abs(g - ref[k * 3 + 1]), Math.abs(b - ref[k * 3 + 2]));
      mask[k] = (d > thr && Math.max(r, g, b) < dark) ? 1 : 0;
    }
    // Nettoyage : un pixel n'est gardé que s'il a au moins 5 voisins actifs
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!mask[k] || i === 0 || j === 0 || i === W - 1 || j === H - 1) { mask2[k] = 0; continue; }
        let n = 0;
        n += mask[k - 1] + mask[k + 1] + mask[k - W] + mask[k + W];
        n += mask[k - W - 1] + mask[k - W + 1] + mask[k + W - 1] + mask[k + W + 1];
        mask2[k] = n >= 5 ? 1 : 0;
        count += mask2[k];
      }
    }
    const minArea = W * H * 0.004; // ~50 points
    if (count < minArea) {
      if (opt.adapt) adaptReference(0.03);
      return { present: false, area: count, mask: mask2 };
    }

    // Recherche de la pointe : on parcourt les lignes/colonnes depuis le
    // bord opposé à l'entrée ; la pointe est la 1re "tranche" contenant
    // assez de points (≥ 2), puis la position médiane dans cette tranche
    // et les 2 suivantes.
    let tipU = 0, tipV = 0;
    const along = (opt.entry === 'bottom' || opt.entry === 'top');
    const n1 = along ? H : W, n2 = along ? W : H;
    const dir = (opt.entry === 'bottom' || opt.entry === 'right') ? 1 : -1;
    const start = dir === 1 ? 0 : n1 - 1;
    // Une tranche compte si elle a ≥ 3 points ET que la tranche suivante
    // (vers l'entrée du pied) en a aussi : évite les points isolés.
    const sliceCount = a => {
      let c = 0;
      for (let b = 0; b < n2; b++) { c += along ? mask2[a * W + b] : mask2[b * W + a]; }
      return c;
    };
    let found = -1;
    for (let s = 0; s < n1 - 1; s++) {
      const a = start + dir * s;
      if (sliceCount(a) >= 3 && sliceCount(a + dir) >= 3) { found = a; break; }
    }
    if (found < 0) return { present: false, area: count, mask: mask2 };
    const pos = [];
    for (let t = 0; t < 3; t++) {
      const a = found + dir * t;
      if (a < 0 || a >= n1) break;
      for (let b = 0; b < n2; b++) { if (along ? mask2[a * W + b] : mask2[b * W + a]) pos.push(b); }
    }
    pos.sort((x, y) => x - y);
    const med = pos[Math.floor(pos.length / 2)];
    if (along) { tipV = (found + 0.5) / H; tipU = (med + 0.5) / W; }
    else { tipU = (found + 0.5) / W; tipV = (med + 0.5) / H; }

    // Décalage réglable dans le sens de la pointe
    const off = opt.offset || 0;
    if (opt.entry === 'bottom') tipV -= off;
    else if (opt.entry === 'top') tipV += off;
    else if (opt.entry === 'right') tipU -= off;
    else tipU += off;

    return { present: true, u: tipU, v: tipV, area: count, mask: mask2 };
  }

  /** Fait glisser doucement la référence vers l'image actuelle (lumière qui change). */
  function adaptReference(alpha) {
    for (let k = 0; k < W * H * 3; k++) ref[k] += (cur[k] - ref[k]) * alpha;
  }

  return { W, H, setCorners, getCorners, captureReference, hasReference, analyze, squareToQuad };
})();
