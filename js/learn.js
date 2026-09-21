// ═══════════════════════════════════════════════════════════════
// APPRENTISSAGE — mémorise les corrections faites à la main et
// s'en sert pour s'améliorer tout seul :
//  1. phrases corrigées → exemples donnés à l'IA + réponse directe si
//     la même suite de cases revient ;
//  2. cases corrigées → décalage moyen entre la pointe détectée et la
//     case réellement visée, appliqué automatiquement à la détection.
// Tout reste sur le téléphone (localStorage).
// ═══════════════════════════════════════════════════════════════
window.Learn = (function () {

  const KEY = 'aac_learn';
  let data = { examples: [], cellFixes: [] };
  try { Object.assign(data, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { } }

  const seqKey = items => items.map(it => it.label).join('|');

  // ── 1. Phrases corrigées ──
  /** Enregistre « cette suite de cases voulait dire cette phrase ». */
  function addExample(items, phrase) {
    phrase = (phrase || '').trim();
    if (!items.length || !phrase) return;
    const key = seqKey(items);
    data.examples = data.examples.filter(e => e.key !== key);
    data.examples.push({ key, labels: items.map(it => it.label), phrase, at: Date.now() });
    if (data.examples.length > 300) data.examples.shift();
    save();
  }
  /** Phrase déjà connue pour exactement cette suite de cases (ou null). */
  function knownPhrase(items) {
    const key = seqKey(items);
    const e = data.examples.find(x => x.key === key);
    return e ? e.phrase : null;
  }
  /** Exemples récents pour l'IA (les plus récents en dernier). */
  function examplesForIA(max) {
    return data.examples.slice(-(max || 40)).map(e => ({ labels: e.labels, phrase: e.phrase }));
  }

  // ── 2. Cases corrigées ──
  /** Enregistre « la pointe était en (u,v), case détectée A, mais c'était la case B ». */
  function addCellFix(u, v, fromCell, toCell) {
    if (u == null || v == null || !toCell) return;
    data.cellFixes.push({
      u, v, from: fromCell ? fromCell.label : null, to: toCell.label,
      du: (toCell.x0 + toCell.x1) / 2 - u,   // écart vers le centre de la bonne case
      dv: (toCell.y0 + toCell.y1) / 2 - v,
      at: Date.now()
    });
    if (data.cellFixes.length > 60) data.cellFixes.shift();
    save();
  }
  /**
   * Décalage appris à appliquer à la pointe détectée : médiane des écarts
   * des 20 dernières corrections. Prudent : rien tant qu'il y a moins de
   * 3 corrections, et jamais plus d'une demi-case.
   */
  function learnedOffset() {
    const fx = data.cellFixes.slice(-20);
    if (fx.length < 3) return { u: 0, v: 0, n: fx.length };
    const med = arr => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const clamp = x => Math.max(-0.06, Math.min(0.06, x));
    return { u: clamp(med(fx.map(f => f.du))), v: clamp(med(fx.map(f => f.dv))), n: fx.length };
  }

  // ── Divers ──
  function stats() { return { examples: data.examples.length, cellFixes: data.cellFixes.length, offset: learnedOffset() }; }
  function exportJSON() { return JSON.stringify(data, null, 1); }
  function importJSON(txt) {
    const obj = JSON.parse(txt);
    if (!obj || typeof obj !== 'object') throw new Error('format inattendu');
    data = { examples: obj.examples || [], cellFixes: obj.cellFixes || [] };
    save();
  }
  function resetCellFixes() { data.cellFixes = []; save(); }
  function resetAll() { data = { examples: [], cellFixes: [] }; save(); }

  return { addExample, knownPhrase, examplesForIA, addCellFix, learnedOffset, stats, exportJSON, importJSON, resetCellFixes, resetAll };
})();
