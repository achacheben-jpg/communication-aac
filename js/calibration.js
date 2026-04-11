// ═══════════════════════════════════════════
// CALIBRATION 4 coins + APPRENTISSAGE OFFSET
// ═══════════════════════════════════════════
window.Calibration = (function() {
  const POINTS_KEY = 'calibPoints';
  const PAIRS_KEY = 'aac_offset_pairs';
  const LEARNED_KEY = 'aac_learned_offset';
  const MAX_PAIRS = 20;
  const CORNERS = ['HAUT-GAUCHE', 'HAUT-DROIT', 'BAS-GAUCHE', 'BAS-DROIT'];

  // État du wizard
  let stream = null;
  let points = [];
  let step = 0;
  let state = 'idle'; // idle | streaming | tapping | done

  function load() {
    try {
      const raw = localStorage.getItem(POINTS_KEY);
      if (raw) points = JSON.parse(raw) || [];
    } catch (e) { points = []; }
    return points;
  }

  function getPoints() { return points; }

  function reset() {
    points = [];
    step = 0;
    state = 'idle';
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('dot-' + i);
      if (d) d.className = 'step-dot';
    }
    const msg = document.getElementById('calib-msg');
    if (msg) msg.innerHTML = 'Appuyez sur <b>Démarrer</b> pour ouvrir la caméra.';
    const btn = document.getElementById('calib-action-btn');
    if (btn) btn.textContent = 'Démarrer caméra';
    showAutoBtn(false);
    const c = document.getElementById('canvas-calib');
    if (c) { const ctx = c.getContext('2d'); ctx && ctx.clearRect(0, 0, c.width, c.height); }
  }

  function showAutoBtn(visible) {
    const b = document.getElementById('calib-auto-btn');
    if (b) b.style.display = visible ? '' : 'none';
  }

  async function startCam() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      const v = document.getElementById('video-calib');
      v.srcObject = stream;
      await v.play();
      state = 'streaming';
      document.getElementById('calib-msg').innerHTML =
        'Caméra active. Cadrez le tableau entier.<br>L\'<b>auto-détection</b> va tenter de trouver les 4 coins. En cas d\'échec, touchez directement chaque coin sur l\'écran.';
      document.getElementById('calib-action-btn').textContent = '⚡ Auto-détecter';
      showAutoBtn(true);

      // Dimensionner le canvas pour qu'il corresponde à la taille CSS affichée
      // (important : on dessine en coordonnées CSS, pas en pixels vidéo intrinsèques)
      await new Promise(r => requestAnimationFrame(r));
      const c = document.getElementById('canvas-calib');
      const rect = v.getBoundingClientRect();
      c.width = Math.max(1, Math.round(rect.width));
      c.height = Math.max(1, Math.round(rect.height));

      arm();

      // Tentative automatique 1.2 s après le démarrage pour laisser l'exposition
      // se stabiliser. L'utilisateur peut toujours re-déclencher ou taper manuellement.
      setTimeout(() => {
        if (state === 'streaming' || state === 'tapping') auto();
      }, 1200);

    } catch (e) {
      document.getElementById('calib-msg').innerHTML =
        `<span style="color:#e74c3c">Erreur caméra : ${e.message}</span>`;
    }
  }

  function action() {
    if (state === 'idle') { startCam(); return; }
    if (state === 'done') {
      stopCam();
      save();
      if (window.App) App.goMain('camera');
      return;
    }
    // streaming / tapping : le bouton principal déclenche l'auto-détection
    auto();
  }

  function arm() {
    const canvas = document.getElementById('canvas-calib');
    if (!canvas) return;
    canvas.style.cursor = 'crosshair';
    canvas.ontouchend = canvas.onclick = handleTap;
    state = 'tapping';
    document.getElementById('dot-' + step).className = 'step-dot current';
  }

  function handleTap(e) {
    e.preventDefault();
    const canvas = document.getElementById('canvas-calib');
    const rect = canvas.getBoundingClientRect();
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;

    points.push({ x: nx, y: ny });
    const ctx = canvas.getContext('2d');
    drawPoint(ctx, clientX - rect.left, clientY - rect.top, step + 1);

    document.getElementById('dot-' + step).className = 'step-dot done';
    step++;

    canvas.ontouchend = canvas.onclick = null;
    canvas.style.cursor = 'default';

    if (step < 4) {
      document.getElementById('calib-msg').innerHTML =
        `✅ Coin ${step} enregistré !<br>Maintenant : <b>${CORNERS[step]}</b> — touchez ce coin.`;
      document.getElementById('calib-action-btn').textContent = `Coin ${step + 1} : ${CORNERS[step]}`;
      arm();
    } else {
      state = 'done';
      document.getElementById('calib-msg').innerHTML =
        '✅ <b>Calibration terminée !</b> Les 4 coins sont enregistrés.';
      document.getElementById('calib-action-btn').textContent = 'Utiliser le tableau →';
    }
  }

  function drawPoint(ctx, x, y, n) {
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(29,158,117,0.7)';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n, x, y);
  }

  function stopCam() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  function save() {
    localStorage.setItem(POINTS_KEY, JSON.stringify(points));
  }

  function isCalibrated() {
    return points && points.length === 4;
  }

  // ═══════════════════════════════════════════
  // AUTO-DÉTECTION DES 4 COINS (Phase 3.7)
  // ═══════════════════════════════════════════
  // Algorithme : on cherche la plus grande composante connexe de pixels
  // saturés (le tableau est coloré — bleu/jaune/rouge — sur un fond
  // typiquement peu saturé). On extrait ensuite les 4 coins par les
  // extrêmes de (x+y) et (x-y), ce qui fonctionne aussi quand le tableau
  // est légèrement incliné.

  function auto() {
    const v = document.getElementById('video-calib');
    if (!v || v.readyState < 2) {
      flashMsg('Caméra non prête, réessayez dans un instant.', true);
      return;
    }
    const detected = detectBoardCorners(v);
    if (!detected) {
      flashMsg('Tableau non détecté — vérifiez l\'éclairage et le cadrage, ou touchez les 4 coins manuellement.', true);
      return;
    }

    // Appliquer la détection
    points = detected;
    step = 4;
    state = 'done';
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('dot-' + i);
      if (d) d.className = 'step-dot done';
    }

    // Désarmer le tap manuel (mais laisser le bouton Auto disponible pour ré-essayer)
    const canvas = document.getElementById('canvas-calib');
    if (canvas) {
      canvas.ontouchend = canvas.onclick = null;
      canvas.style.cursor = 'default';
    }

    drawPreviewQuad(detected);

    const msg = document.getElementById('calib-msg');
    if (msg) msg.innerHTML =
      '✅ <b>Auto-détection réussie</b> — 4 coins trouvés. Vérifiez la superposition verte et touchez <b>Utiliser →</b>. Relancez <b>⚡ Auto</b> pour re-détecter.';
    const btn = document.getElementById('calib-action-btn');
    if (btn) btn.textContent = 'Utiliser →';
  }

  function flashMsg(text, isError) {
    const msg = document.getElementById('calib-msg');
    if (!msg) return;
    msg.innerHTML = isError
      ? `<span style="color:var(--orange)">${text}</span>`
      : text;
  }

  /** Détecte les 4 coins du tableau à partir d'une frame vidéo.
   *  Retourne un tableau [TL,TR,BL,BR] en coordonnées normalisées [0,1],
   *  ou null si la détection échoue. */
  function detectBoardCorners(video) {
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const W = 240;
    const H = Math.max(90, Math.round(W * vh / vw));

    const cvs = document.createElement('canvas');
    cvs.width = W;
    cvs.height = H;
    const ctx = cvs.getContext('2d');
    try {
      ctx.drawImage(video, 0, 0, W, H);
    } catch (e) { return null; }
    let data;
    try { data = ctx.getImageData(0, 0, W, H).data; }
    catch (e) { return null; }

    // 1) Masque de saturation : pixels colorés = probablement tableau
    const mask = new Uint8Array(W * H);
    let maskCount = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const maxC = Math.max(r, g, b);
      if (maxC < 45) continue; // trop sombre
      const minC = Math.min(r, g, b);
      const sat = (maxC - minC) / maxC;
      if (sat > 0.3) {
        mask[i] = 1;
        maskCount++;
      }
    }
    if (maskCount < W * H * 0.02) return null;

    // 2) Plus grande composante connexe (BFS itératif, 4-connectivité)
    const visited = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    let bestComp = null;
    let bestSize = 0;
    for (let start = 0; start < W * H; start++) {
      if (!mask[start] || visited[start]) continue;
      let top = 0;
      stack[top++] = start;
      visited[start] = 1;
      const comp = [];
      while (top > 0) {
        const p = stack[--top];
        comp.push(p);
        const x = p % W;
        const y = (p - x) / W;
        if (x > 0) {
          const q = p - 1;
          if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
        }
        if (x < W - 1) {
          const q = p + 1;
          if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
        }
        if (y > 0) {
          const q = p - W;
          if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
        }
        if (y < H - 1) {
          const q = p + W;
          if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
        }
      }
      if (comp.length > bestSize) { bestSize = comp.length; bestComp = comp; }
    }

    if (!bestComp || bestSize < W * H * 0.015) return null;

    // 3) Extraire les 4 coins extrêmes
    let tlS = Infinity, brS = -Infinity, trS = -Infinity, blS = Infinity;
    let tlX = 0, tlY = 0, trX = 0, trY = 0, blX = 0, blY = 0, brX = 0, brY = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < bestComp.length; k++) {
      const p = bestComp[k];
      const x = p % W;
      const y = (p - x) / W;
      const xPy = x + y;
      const xMy = x - y;
      if (xPy < tlS) { tlS = xPy; tlX = x; tlY = y; }
      if (xPy > brS) { brS = xPy; brX = x; brY = y; }
      if (xMy > trS) { trS = xMy; trX = x; trY = y; }
      if (xMy < blS) { blS = xMy; blX = x; blY = y; }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // 4) Sanity checks
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < W * 0.18 || bboxH < H * 0.18) return null;
    const ar = bboxW / bboxH;
    if (ar < 0.4 || ar > 3.0) return null;

    // Les 4 coins doivent être distincts (au moins 4 px d'écart deux à deux)
    const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
    if (dist(tlX, tlY, trX, trY) < 4) return null;
    if (dist(blX, blY, brX, brY) < 4) return null;

    return [
      { x: tlX / W, y: tlY / H },
      { x: trX / W, y: trY / H },
      { x: blX / W, y: blY / H },
      { x: brX / W, y: brY / H }
    ];
  }

  function drawPreviewQuad(pts) {
    const canvas = document.getElementById('canvas-calib');
    const video = document.getElementById('video-calib');
    if (!canvas || !video) return;
    const rect = video.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pxs = pts.map(p => ({ x: p.x * canvas.width, y: p.y * canvas.height }));

    // Quadrilatère rempli
    ctx.beginPath();
    ctx.moveTo(pxs[0].x, pxs[0].y); // TL
    ctx.lineTo(pxs[1].x, pxs[1].y); // TR
    ctx.lineTo(pxs[3].x, pxs[3].y); // BR
    ctx.lineTo(pxs[2].x, pxs[2].y); // BL
    ctx.closePath();
    ctx.fillStyle = 'rgba(29,158,117,0.18)';
    ctx.fill();
    ctx.strokeStyle = '#1D9E75';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Marqueurs de coin
    const labels = ['HG', 'HD', 'BG', 'BD'];
    pxs.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(29,158,117,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.font = 'bold 11px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], p.x, p.y);
    });
  }

  // ═══════════════════════════════════════════
  // APPRENTISSAGE OFFSET (3.4)
  // ═══════════════════════════════════════════
  // Quand l'utilisateur clique manuellement sur une case alors que la caméra
  // détecte un pied, on enregistre l'écart (foot, cellCenter) en coordonnées
  // normalisées du tableau (u,v ∈ [0,1]). Après MAX_PAIRS paires, on calcule
  // la moyenne du dy et on la propose comme offset automatique.

  function loadPairs() {
    try { return JSON.parse(localStorage.getItem(PAIRS_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function savePairs(pairs) {
    localStorage.setItem(PAIRS_KEY, JSON.stringify(pairs.slice(-MAX_PAIRS * 2)));
  }

  function getLearnedOffset() {
    const raw = localStorage.getItem(LEARNED_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /** Enregistrer une paire (foot, cell-center) en UV normalisé du tableau.
   *  footUV : {u,v} position du pied en coordonnées tableau (pas caméra).
   *  cellUV : {u,v} centre de la case cliquée en coordonnées tableau.
   */
  function recordPair(footUV, cellUV) {
    if (!footUV || !cellUV) return;
    const pairs = loadPairs();
    pairs.push({
      fu: footUV.u, fv: footUV.v,
      cu: cellUV.u, cv: cellUV.v,
      t: Date.now()
    });
    savePairs(pairs);
    updateLabel(pairs.length);
    if (pairs.length >= MAX_PAIRS) {
      computeAndSaveOffset(pairs);
    }
  }

  function computeAndSaveOffset(pairs) {
    if (!pairs || pairs.length === 0) return;
    let sumDu = 0, sumDv = 0;
    pairs.forEach(p => {
      sumDu += (p.cu - p.fu);
      sumDv += (p.cv - p.fv);
    });
    const offset = {
      du: sumDu / pairs.length,
      dv: sumDv / pairs.length,
      samples: pairs.length
    };
    localStorage.setItem(LEARNED_KEY, JSON.stringify(offset));
    if (window.App) App.setStatus('blue', `Calibration auto: offset appris (${pairs.length} paires)`);
  }

  function resetOffsetLearning() {
    localStorage.removeItem(PAIRS_KEY);
    localStorage.removeItem(LEARNED_KEY);
    updateLabel(0);
    if (window.App) App.setStatus('', 'Apprentissage offset réinitialisé');
  }

  function updateLabel(count) {
    const el = document.getElementById('lbl-offset-learning');
    if (!el) return;
    const c = (count !== undefined) ? count : loadPairs().length;
    el.textContent = `${Math.min(c, MAX_PAIRS)}/${MAX_PAIRS} paires pied↔case`;
  }

  function initLabel() {
    updateLabel();
  }

  return {
    load, getPoints, reset, startCam, action, auto, stopCam, save, isCalibrated,
    recordPair, getLearnedOffset, resetOffsetLearning, initLabel
  };
})();
