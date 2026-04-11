// ═══════════════════════════════════════════
// TABLEAU — helpers d'accès aux cases
// ═══════════════════════════════════════════
window.Tableau = (function() {

  /** Toutes les cases cliquables (ayant data-val) */
  function allSelectable() {
    return Array.from(document.querySelectorAll('#tableau .c[data-val]'));
  }

  /** Cases groupées par numéro de ligne (data-row) */
  function byRow() {
    const rows = {};
    allSelectable().forEach(el => {
      const r = parseInt(el.dataset.row || '0', 10);
      (rows[r] = rows[r] || []).push(el);
    });
    // Sort each row by horizontal position (grid column order)
    Object.keys(rows).forEach(r => {
      rows[r].sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.left - rb.left;
      });
    });
    return rows;
  }

  /** Ordre de lignes pour scan (0..9) */
  function rowOrder() {
    const rows = byRow();
    return Object.keys(rows).map(Number).sort((a, b) => a - b);
  }

  /** Trouve la case à partir d'un élément DOM (remonte les parents) */
  function cellFromElement(el) {
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.val) return el;
      el = el.parentElement;
    }
    return null;
  }

  return { allSelectable, byRow, rowOrder, cellFromElement };
})();
