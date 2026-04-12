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

// ═══════════════════════════════════════════
// VIDEO COORDS — conversion display ↔ vidéo intrinsèque
// ═══════════════════════════════════════════
// Les éléments <video> avec object-fit:cover rognent l'image différemment
// selon leur taille CSS. Toutes les coordonnées de calibration et de
// détection doivent être en "vidéo-normalisé" (0-1 du frame intrinsèque)
// pour être cohérentes entre différents éléments vidéo.
window.VideoCoords = (function() {

  /** Paramètres de rendu d'un element <video> avec object-fit */
  function params(videoEl) {
    if (!videoEl) return null;
    const vw = videoEl.videoWidth || 1;
    const vh = videoEl.videoHeight || 1;
    const cw = videoEl.clientWidth || 1;
    const ch = videoEl.clientHeight || 1;
    const videoAR = vw / vh;
    const containerAR = cw / ch;
    const style = window.getComputedStyle(videoEl);
    const fit = style.objectFit || 'cover';
    let scale, offX, offY;

    if (fit === 'cover') {
      if (videoAR > containerAR) {
        scale = ch / vh;
        offX = (vw * scale - cw) / 2;
        offY = 0;
      } else {
        scale = cw / vw;
        offX = 0;
        offY = (vh * scale - ch) / 2;
      }
    } else if (fit === 'contain') {
      if (videoAR > containerAR) {
        scale = cw / vw;
        offX = 0;
        offY = -(vh * scale - ch) / 2;
      } else {
        scale = ch / vh;
        offX = -(vw * scale - cw) / 2;
        offY = 0;
      }
    } else {
      // fill / none → direct mapping
      return { scale: 1, offX: 0, offY: 0, vw, vh, cw, ch };
    }
    return { scale, offX, offY, vw, vh, cw, ch };
  }

  /** Display-normalized (0-1 de l'élément CSS) → video-normalized (0-1 du frame intrinsèque) */
  function displayToVideo(nx, ny, videoEl) {
    const p = params(videoEl);
    if (!p) return { x: nx, y: ny };
    const dx = nx * p.cw;
    const dy = ny * p.ch;
    const vx = (dx + p.offX) / p.scale;
    const vy = (dy + p.offY) / p.scale;
    return { x: vx / p.vw, y: vy / p.vh };
  }

  /** Video-normalized (0-1 du frame) → display-normalized (0-1 de l'élément CSS) */
  function videoToDisplay(nx, ny, videoEl) {
    const p = params(videoEl);
    if (!p) return { x: nx, y: ny };
    const vx = nx * p.vw;
    const vy = ny * p.vh;
    const dx = vx * p.scale - p.offX;
    const dy = vy * p.scale - p.offY;
    return { x: dx / p.cw, y: dy / p.ch };
  }

  return { displayToVideo, videoToDisplay };
})();
