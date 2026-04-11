// ═══════════════════════════════════════════
// CAMÉRA LIVE + DÉTECTION PIED (MediaPipe Pose)
// ═══════════════════════════════════════════
window.Camera = (function() {

  const MEDIAPIPE_POSE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js';
  const MEDIAPIPE_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose';

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

  async function start() {
    document.getElementById('camera-live-wrap').classList.add('visible');
    document.getElementById('dwell-wrap').classList.add('visible');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } },
        audio: false
      });
      const v = document.getElementById('video-live');
      v.srcObject = stream;
      await v.play();

      if (window.App) App.setStatus('green', 'Caméra active — chargement détecteur…');
      detectActive = true;

      setTimeout(() => {
        const c = document.getElementById('canvas-live');
        c.width = v.clientWidth;
        c.height = v.clientHeight;
      }, 300);

      Calibration.load();
      if (!Calibration.isCalibrated()) {
        if (window.App) App.setStatus('orange', 'Pas de calibration — recalibrez via 📐');
      }

      // Charger MediaPipe Pose en tâche de fond ; fallback sur analyse pixels si échec
      loadPose().then(() => {
        if (poseInstance && window.App) App.setStatus('green', 'Caméra + Pose actif');
      }).catch(() => {
        if (window.App) App.setStatus('green', 'Caméra active (détection pixels)');
      });

      detectLoop();

    } catch (e) {
      if (window.App) App.setStatus('red', 'Erreur caméra : ' + e.message);
    }
  }

  function stop() {
    detectActive = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    document.getElementById('camera-live-wrap').classList.remove('visible');
    document.getElementById('dwell-wrap').classList.remove('visible');
    if (window.App) App.setStatus('', 'Mode manuel');
    clearDwell();
    lastFootPos = null;
    lastFootUVBoard = null;
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
        return;
      }

      // Dessin curseur
      ctx.beginPath();
      ctx.arc(footPos.x * c.width, footPos.y * c.height, 16, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(29,158,117,0.6)';
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
      handleDwell(cell);
    } finally {
      if (detectActive) animFrame = requestAnimationFrame(detectLoop);
    }
  }

  /** Analyse pixels fallback (comme l'original) */
  function detectFootFromPixels(video) {
    try {
      const offscreen = document.createElement('canvas');
      const scale = 0.25;
      offscreen.width = (video.videoWidth || 640) * scale;
      offscreen.height = (video.videoHeight || 360) * scale;
      const octx = offscreen.getContext('2d');
      octx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
      const data = octx.getImageData(0, 0, offscreen.width, offscreen.height).data;
      let sumX = 0, sumY = 0, count = 0;
      for (let y = 0; y < offscreen.height; y++) {
        for (let x = 0; x < offscreen.width; x++) {
          const i = (y * offscreen.width + x) * 4;
          const b = (data[i] + data[i+1] + data[i+2]) / 3;
          const ny = y / offscreen.height;
          if (b < 80 && ny > 0.3) {
            sumX += x / offscreen.width;
            sumY += ny;
            count++;
          }
        }
      }
      if (count > 20) return { x: sumX / count, y: sumY / count };
    } catch (e) {}
    return null;
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

  return { start, stop, getLastFootUVBoard, cellCenterUV };
})();
