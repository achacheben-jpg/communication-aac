// ═══════════════════════════════════════════
// CAMÉRA LIVE + DÉTECTION PIED
// ═══════════════════════════════════════════
// Deux modes de source :
//   - 'fixed'    : caméra fixe au niveau des pieds. Seul le pied est visible.
//                  → détection par pixels (plus grande tache sombre dans le
//                  quadrilatère calibré, avec soustraction de fond).
//   - 'handheld' : iPhone tenu à hauteur d'homme, corps visible.
//                  → détection via MediaPipe Pose (landmarks 31/32 = pieds).
window.Camera = (function() {

  const MEDIAPIPE_POSE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js';
  const MEDIAPIPE_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose';
  const SOURCE_KEY = 'aac_camera_source';

  let stream = null;
  let detectActive = false;
  let animFrame = null;
  let dwellCell = null;
  let dwellStart = null;
  let lastFootPos = null;          // {x,y} en coordonnées vidéo normalisées
  let lastFootUVBoard = null;      // {u,v} en coordonnées tableau (pour offset learning)
  let poseInstance = null;
  let poseLoading = false;
  let usePoseModel = false;
  let pendingSend = false;
  // Détection pixels (mode fixed)
  let bgFrame = null;              // Uint8ClampedArray (R,G,B,R,G,B,...)
  let bgFrameW = 0, bgFrameH = 0;
  let framesSinceBgRefresh = 0;
  // Indicateur visuel
  let detectionState = 'idle';     // 'idle' | 'searching' | 'detected'

  function getSource() {
    return localStorage.getItem(SOURCE_KEY) || 'fixed';
  }

  function setSource(v) {
    if (v !== 'fixed' && v !== 'handheld') return;
    localStorage.setItem(SOURCE_KEY, v);
    // Si la caméra tourne, redémarrer pour appliquer le nouveau mode
    if (detectActive) { stop(); start(); }
  }

  async function start() {
    document.getElementById('camera-live-wrap').classList.add('visible');
    document.getElementById('dwell-wrap').classList.add('visible');

    try {
      const v = document.getElementById('video-live');
      // Source : fichier vidéo chargé OU caméra live
      if (window.VideoSource && VideoSource.has()) {
        v.srcObject = null;
        v.src = VideoSource.url();
        v.loop = false;
        v.muted = false;          // garder le son de la vidéo si présent
        v.playsInline = true;
        v.currentTime = 0;
        // Quand la vidéo se termine, afficher la transcription
        // SAUF en mode entraînement : Training pose son propre handler.
        v.onended = trainingMode ? null : onVideoEnded;
        await v.play();
        if (!trainingMode) {
          if (window.VideoSource.resetTranscript) VideoSource.resetTranscript();
          if (window.App) App.clearAll && App.clearAll();
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false
        });
        v.srcObject = stream;
        v.src = '';
        v.onended = null;
        await v.play();
      }

      detectActive = true;
      setDetectionState('searching');

      setTimeout(() => {
        const c = document.getElementById('canvas-live');
        c.width = v.clientWidth;
        c.height = v.clientHeight;
      }, 300);

      Calibration.load();
      if (!Calibration.isCalibrated()) {
        if (window.App) App.setStatus('orange', 'Pas de calibration — touchez 📐');
      }

      const source = getSource();
      console.log('[camera] source =', source);

      if (source === 'handheld') {
        // MediaPipe Pose pour corps entier
        if (window.App) App.setStatus('orange', 'Chargement MediaPipe Pose…');
        loadPose().then(() => {
          if (poseInstance && window.App) App.setStatus('green', '👣 Pose actif — cherche le pied');
        }).catch((e) => {
          console.warn('[camera] Pose load failed', e);
          if (window.App) App.setStatus('orange', 'Pose indisponible — bascule en mode fixe');
          usePoseModel = false;
        });
      } else {
        // Mode caméra fixe : pixels uniquement, pas besoin de MediaPipe
        usePoseModel = false;
        if (window.App) App.setStatus('orange', 'Caméra fixe — cherche le pied');
        // Capturer une image de fond (sans pied) après 1s pour background subtraction
        // On ne fait ça QUE pour une vraie caméra live : pour une vidéo chargée,
        // le premier frame contient probablement déjà le pied en action.
        if (!(window.VideoSource && VideoSource.has())) {
          captureBackgroundAfter(1200);
        }
      }

      detectLoop();

    } catch (e) {
      if (window.App) App.setStatus('red', 'Erreur caméra : ' + e.message);
    }
  }

  function stop() {
    detectActive = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    const v = document.getElementById('video-live');
    if (v) {
      try { v.pause(); } catch (e) {}
      v.onended = null;
    }
    document.getElementById('camera-live-wrap').classList.remove('visible');
    document.getElementById('dwell-wrap').classList.remove('visible');
    if (window.App) App.setStatus('', 'Mode manuel');
    clearDwell();
    lastFootPos = null;
    lastFootUVBoard = null;
    bgFrame = null;
    setDetectionState('idle');
  }

  function onVideoEnded() {
    console.log('[camera] video ended, showing transcription');
    detectActive = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    clearDwell();
    if (window.App && App.showTranscriptResult) {
      App.showTranscriptResult();
    }
  }

  // Mode entraînement : enregistre une trace des UV détectées pendant
  // toute la lecture, SANS déclencher de dwell/sélection.
  let trainingMode = false;
  let trainingTrace = [];

  function startTraining() {
    trainingMode = true;
    trainingTrace = [];
    console.log('[camera] training mode ON');
  }

  function stopTrainingAndGetTrace() {
    trainingMode = false;
    const trace = trainingTrace;
    trainingTrace = [];
    console.log('[camera] training mode OFF, trace length:', trace.length);
    return trace;
  }

  function setDetectionState(s) {
    if (s === detectionState) return;
    detectionState = s;
    const badge = document.getElementById('foot-badge');
    const txt = document.getElementById('foot-badge-text');
    if (badge) {
      badge.classList.remove('detected', 'lost');
      if (s === 'detected') badge.classList.add('detected');
      else if (s === 'searching') {/* default orange */}
      else if (s === 'lost') badge.classList.add('lost');
    }
    if (txt) {
      if (s === 'detected') txt.textContent = '✓ pied détecté';
      else if (s === 'searching') txt.textContent = 'cherche le pied…';
      else if (s === 'lost') txt.textContent = 'pied perdu';
      else txt.textContent = 'inactif';
    }
    if (window.App) {
      if (s === 'detected') App.setStatus('green', '👣 Pied détecté');
      else if (s === 'searching') App.setStatus('orange', '🔍 Cherche le pied');
    }
  }

  /** Capturer une frame de référence (pour background subtraction en mode fixe) */
  function captureBackgroundAfter(ms) {
    setTimeout(() => {
      if (!detectActive || getSource() !== 'fixed') return;
      captureBackground();
      // Rafraîchir périodiquement (tous les 20s) pour s'adapter à l'éclairage
      setInterval(() => {
        if (!detectActive || getSource() !== 'fixed') return;
        // Ne pas rafraîchir si on est en plein dwell
        if (!dwellCell) captureBackground();
      }, 20000);
    }, ms);
  }

  function captureBackground() {
    const v = document.getElementById('video-live');
    if (!v || v.readyState < 2) return;
    try {
      const scale = 0.25;
      const w = Math.round((v.videoWidth || 640) * scale);
      const h = Math.round((v.videoHeight || 360) * scale);
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      bgFrame = new Uint8ClampedArray(d);
      bgFrameW = w; bgFrameH = h;
      console.log('[camera] background frame captured', w, 'x', h);
    } catch (e) { console.warn('[camera] bg capture failed', e); }
  }

  /** ═══ MediaPipe Pose loader ═══ */
  function loadPose() {
    if (poseInstance) return Promise.resolve(poseInstance);
    if (poseLoading) return Promise.reject(new Error('loading'));
    poseLoading = true;

    return new Promise((resolve, reject) => {
      // Déjà chargé ?
      if (typeof Pose !== 'undefined') {
        try { initPose(); resolve(poseInstance); }
        catch (e) { reject(e); }
        return;
      }
      const s = document.createElement('script');
      s.src = MEDIAPIPE_POSE_URL;
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        try { initPose(); resolve(poseInstance); }
        catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('pose load failed'));
      document.head.appendChild(s);
    });
  }

  function initPose() {
    if (typeof Pose === 'undefined') throw new Error('Pose undefined');
    poseInstance = new Pose({
      locateFile: (file) => `${MEDIAPIPE_BASE}/${file}`
    });
    poseInstance.setOptions({
      modelComplexity: 0,       // léger pour mobile
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    poseInstance.onResults(onPoseResults);
    usePoseModel = true;
  }

  function onPoseResults(results) {
    pendingSend = false;
    if (!results.poseLandmarks || results.poseLandmarks.length === 0) {
      lastFootPos = null;
      return;
    }
    const lm = results.poseLandmarks;
    // 31 = left_foot_index, 32 = right_foot_index
    const left = lm[31];
    const right = lm[32];
    const candidates = [];
    if (left && (left.visibility ?? 1) > 0.3) candidates.push(left);
    if (right && (right.visibility ?? 1) > 0.3) candidates.push(right);
    if (candidates.length === 0) {
      // fallback sur les chevilles
      const ankle = (lm[27]?.visibility ?? 0) > (lm[28]?.visibility ?? 0) ? lm[27] : lm[28];
      if (ankle) candidates.push(ankle);
    }
    if (candidates.length === 0) { lastFootPos = null; return; }
    // Prendre le landmark le plus bas (plus grand y)
    const best = candidates.reduce((a, b) => (a.y > b.y ? a : b));
    lastFootPos = { x: best.x, y: best.y };
  }

  /** ═══ BOUCLE DE DÉTECTION ═══ */
  function detectLoop() {
    if (!detectActive) return;
    try {
      const v = document.getElementById('video-live');
      const c = document.getElementById('canvas-live');
      if (!c || !v || v.readyState < 2) return;

      c.width = v.clientWidth;
      c.height = v.clientHeight;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);

      // Overlay calibration
      if (Calibration.isCalibrated()) drawCalibOverlay(ctx, c);

      // Détection pied
      if (usePoseModel && poseInstance && !pendingSend) {
        pendingSend = true;
        poseInstance.send({ image: v }).catch(() => { pendingSend = false; });
      } else if (!usePoseModel) {
        lastFootPos = detectFootFromPixels(v);
      }

      const footPos = lastFootPos;
      if (!footPos) {
        clearDwell();
        lastFootUVBoard = null;
        setDetectionState('searching');
        return;
      }
      setDetectionState('detected');

      // Dessin curseur vert = position brute du pied détecté
      ctx.beginPath();
      ctx.arc(footPos.x * c.width, footPos.y * c.height, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(29,158,117,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();

      if (!Calibration.isCalibrated()) return;

      const uv = camToBoardUV(footPos);
      if (!uv) return;

      const offsetRows = parseFloat(document.getElementById('sl-offset').value || '2');
      const tbRows = 10;
      let offsetV = offsetRows / tbRows;
      let offsetU = 0;
      const learned = Calibration.getLearnedOffset();
      if (learned) {
        // learned.dv = moy(cellV - footV). Négatif si le pied est sous la case.
        if (typeof learned.dv === 'number') offsetV -= learned.dv;
        if (typeof learned.du === 'number') offsetU -= learned.du;
      }
      const corrected = {
        u: Math.max(0, Math.min(1, uv.u - offsetU)),
        v: Math.max(0, uv.v - offsetV)
      };
      lastFootUVBoard = uv;
      const cell = getCellAtBoardUV(corrected);

      // Mode entraînement : on enregistre la trace BRUTE (avant offset)
      // et on n'appelle PAS handleDwell (pas de sélection pendant training).
      if (trainingMode) {
        const t = (v.currentTime !== undefined && !isNaN(v.currentTime)) ? v.currentTime : (Date.now() / 1000);
        trainingTrace.push({ t, u: uv.u, v: uv.v });
        return; // saute le dessin de la cible rouge et le dwell
      }

      // ═══ POINT ROUGE : endroit réellement sélectionné ═══
      // On mappe le UV corrigé (dans le tableau) vers la caméra via
      // bilinéaire forward, pour visualiser exactement où le système
      // pense que le pied pointe (après application de l'offset vertical).
      const targetCam = boardUVToCam(corrected);
      if (targetCam) {
        // Ligne pointillée entre pied brut et point de sélection
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(231,76,60,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(footPos.x * c.width, footPos.y * c.height);
        ctx.lineTo(targetCam.x * c.width, targetCam.y * c.height);
        ctx.stroke();
        ctx.restore();

        // Point rouge pulsant + croix centrale
        const tx = targetCam.x * c.width;
        const ty = targetCam.y * c.height;
        ctx.beginPath();
        ctx.arc(tx, ty, 18, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(231,76,60,0.3)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(tx, ty, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(231,76,60,0.9)';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // Petite croix blanche au centre
        ctx.beginPath();
        ctx.moveTo(tx - 5, ty);
        ctx.lineTo(tx + 5, ty);
        ctx.moveTo(tx, ty - 5);
        ctx.lineTo(tx, ty + 5);
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      handleDwell(cell);
    } finally {
      if (detectActive) animFrame = requestAnimationFrame(detectLoop);
    }
  }

  /** Mapping forward : UV tableau → position caméra normalisée [0,1].
   *  Inverse du camToBoardUV (interpolation bilinéaire directe). */
  function boardUVToCam(uv) {
    const pts = Calibration.getPoints();
    if (!pts || pts.length < 4) return null;
    const [TL, TR, BL, BR] = pts;
    const u = uv.u, v = uv.v;
    return {
      x: (1 - v) * ((1 - u) * TL.x + u * TR.x) + v * ((1 - u) * BL.x + u * BR.x),
      y: (1 - v) * ((1 - u) * TL.y + u * TR.y) + v * ((1 - u) * BL.y + u * BR.y)
    };
  }

  /** Détection par pixels : trouve la plus grande zone qui "diffère de l'arrière-plan"
   *  (soustraction de fond si disponible) OU la plus grande tache sombre.
   *  Ne cherche que DANS le polygone calibré (le tableau) pour éviter les faux
   *  positifs sur le fond de la scène. */
  function detectFootFromPixels(video) {
    try {
      const scale = 0.25;
      const w = Math.round((video.videoWidth || 640) * scale);
      const h = Math.round((video.videoHeight || 360) * scale);
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const octx = cvs.getContext('2d', { willReadFrequently: true });
      octx.drawImage(video, 0, 0, w, h);
      const data = octx.getImageData(0, 0, w, h).data;

      // Pré-calculer le masque "dans le polygone calibré"
      const inPoly = new Uint8Array(w * h);
      const pts = Calibration.isCalibrated() ? Calibration.getPoints() : null;
      if (pts) {
        const poly = [pts[0], pts[1], pts[3], pts[2]]; // TL, TR, BR, BL
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const nx = x / w, ny = y / h;
            if (pointInQuad(nx, ny, poly)) inPoly[y * w + x] = 1;
          }
        }
      } else {
        // Pas de calibration : chercher dans toute l'image (partie basse)
        for (let y = Math.floor(h * 0.3); y < h; y++) {
          for (let x = 0; x < w; x++) inPoly[y * w + x] = 1;
        }
      }

      // Construire un masque "pixel qui est probablement le pied"
      const mask = new Uint8Array(w * h);
      let maskCount = 0;

      if (bgFrame && bgFrameW === w && bgFrameH === h) {
        // Background subtraction : le pied est ce qui diffère du fond
        for (let i = 0; i < w * h; i++) {
          if (!inPoly[i]) continue;
          const j = i * 4;
          const dr = Math.abs(data[j] - bgFrame[j]);
          const dg = Math.abs(data[j + 1] - bgFrame[j + 1]);
          const db = Math.abs(data[j + 2] - bgFrame[j + 2]);
          const diff = dr + dg + db;
          if (diff > 90) { mask[i] = 1; maskCount++; }
        }
      } else {
        // Fallback : chercher pixels sombres (le pied est typiquement plus
        // sombre que le tableau coloré)
        for (let i = 0; i < w * h; i++) {
          if (!inPoly[i]) continue;
          const j = i * 4;
          const b = (data[j] + data[j + 1] + data[j + 2]) / 3;
          if (b < 90) { mask[i] = 1; maskCount++; }
        }
      }

      if (maskCount < 15) return null;

      // Trouver la plus grande composante connexe (BFS)
      const visited = new Uint8Array(w * h);
      const stack = new Int32Array(w * h);
      let bestCx = 0, bestCy = 0, bestSize = 0;

      for (let start = 0; start < w * h; start++) {
        if (!mask[start] || visited[start]) continue;
        let top = 0;
        stack[top++] = start;
        visited[start] = 1;
        let sumX = 0, sumY = 0, size = 0;
        while (top > 0) {
          const p = stack[--top];
          const x = p % w;
          const y = (p - x) / w;
          sumX += x;
          sumY += y;
          size++;
          if (x > 0) {
            const q = p - 1;
            if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
          }
          if (x < w - 1) {
            const q = p + 1;
            if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
          }
          if (y > 0) {
            const q = p - w;
            if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
          }
          if (y < h - 1) {
            const q = p + w;
            if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; }
          }
        }
        if (size > bestSize) {
          bestSize = size;
          bestCx = sumX / size;
          bestCy = sumY / size;
        }
      }

      if (bestSize < 15) return null;
      return { x: bestCx / w, y: bestCy / h };
    } catch (e) {
      console.warn('[camera] pixel detect error', e);
      return null;
    }
  }

  /** Point-in-quad test (crossing number) */
  function pointInQuad(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function drawCalibOverlay(ctx, canvas) {
    const pts = Calibration.getPoints().map(p => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(41,128,185,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(41,128,185,0.08)';
    ctx.fill();
  }

  /** Convertit une position normalisée caméra (x,y) en UV tableau (u,v) via
   *  interpolation bilinéaire inverse des 4 coins calibrés. */
  function camToBoardUV(cam) {
    const pts = Calibration.getPoints();
    if (pts.length < 4) return null;
    const [TL, TR, BL, BR] = pts;
    let u = 0.5, v = 0.5;
    for (let i = 0; i < 20; i++) {
      const px = (1-v)*((1-u)*TL.x + u*TR.x) + v*((1-u)*BL.x + u*BR.x);
      const py = (1-v)*((1-u)*TL.y + u*TR.y) + v*((1-u)*BL.y + u*BR.y);
      const dpx = cam.x - px;
      const dpy = cam.y - py;
      const dx_du = (1-v)*(TR.x-TL.x) + v*(BR.x-BL.x);
      const dy_du = (1-v)*(TR.y-TL.y) + v*(BR.y-BL.y);
      const dx_dv = (1-u)*(BL.x-TL.x) + u*(BR.x-TR.x);
      const dy_dv = (1-u)*(BL.y-TL.y) + u*(BR.y-TR.y);
      const det = dx_du*dy_dv - dy_du*dx_dv;
      if (Math.abs(det) < 1e-10) break;
      u = Math.max(-0.2, Math.min(1.2, u + (dpx*dy_dv - dpy*dx_dv)/det));
      v = Math.max(-0.2, Math.min(1.2, v + (dpy*dx_du - dpx*dy_du)/det));
    }
    return { u, v };
  }

  /** Trouve la case DOM correspondant à un UV dans le tableau */
  function getCellAtBoardUV(uv) {
    if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return null;
    const tb = document.getElementById('tableau');
    const tbRect = tb.getBoundingClientRect();
    const sx = tbRect.left + uv.u * tbRect.width;
    const sy = tbRect.top + uv.v * tbRect.height;
    let el = document.elementFromPoint(sx, sy);
    return Tableau.cellFromElement(el);
  }

  /** Dwell selection */
  function handleDwell(cell) {
    if (!cell) { clearDwell(); return; }
    if (cell !== dwellCell) {
      clearDwell();
      dwellCell = cell;
      dwellStart = Date.now();
      cell.classList.add('c-loading');
      return;
    }
    const target = parseFloat(document.getElementById('sl-dwell').value) * 1000;
    const elapsed = Date.now() - dwellStart;
    const ratio = Math.min(elapsed / target, 1);
    document.getElementById('dwell-bar').style.width = (ratio * 100) + '%';
    if (elapsed >= target) {
      cell.classList.remove('c-loading');
      if (window.App) App.sel(cell, { fromCamera: true });
      clearDwell();
    }
  }

  function clearDwell() {
    if (dwellCell) {
      dwellCell.classList.remove('c-loading');
      dwellCell = null;
    }
    dwellStart = null;
    const b = document.getElementById('dwell-bar');
    if (b) b.style.width = '0%';
  }

  /** Retourne la dernière position pied en UV tableau (pour offset learning) */
  function getLastFootUVBoard() { return lastFootUVBoard; }

  /** Retourne le centre UV (dans le tableau) d'une case */
  function cellCenterUV(cellEl) {
    const tb = document.getElementById('tableau');
    if (!tb || !cellEl) return null;
    const tbR = tb.getBoundingClientRect();
    const cR = cellEl.getBoundingClientRect();
    return {
      u: (cR.left + cR.width / 2 - tbR.left) / tbR.width,
      v: (cR.top + cR.height / 2 - tbR.top) / tbR.height
    };
  }

  return {
    start, stop, getLastFootUVBoard, cellCenterUV,
    getSource, setSource, captureBackground,
    startTraining, stopTrainingAndGetTrace
  };
})();
