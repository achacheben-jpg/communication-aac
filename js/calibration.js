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
        'Caméra active. Cadrez le tableau entier.<br>Touchez le <b>coin 1 (HAUT-GAUCHE)</b> directement sur l\'écran.';
      document.getElementById('calib-action-btn').textContent = 'Coin 1 : HAUT-GAUCHE';

      setTimeout(() => {
        const c = document.getElementById('canvas-calib');
        c.width = v.videoWidth || v.clientWidth;
        c.height = v.videoHeight || v.clientHeight;
      }, 500);

      arm();

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
    // En cours de calibration : juste afficher l'instruction
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
    load, getPoints, reset, startCam, action, stopCam, save, isCalibrated,
    recordPair, getLearnedOffset, resetOffsetLearning, initLabel
  };
})();
