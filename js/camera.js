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
  let dwellGraceEnd = 0;            // timestamp de fin de grâce (tolérance spasticité)
  let lastFootPos = null;           // {x,y} en coordonnées vidéo normalisées
  let lastFootUVBoard = null;       // {u,v} en coordonnées tableau (pour offset learning)
  let smoothedFootPos = null;       // EMA de la position pied (lissage spasticité)
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

  // ═══════════════════════════════════════════
  // ÉTAT DE CALIBRATION INLINE (flux vidéo chargée)
  // ═══════════════════════════════════════════
  // Quand l'utilisateur charge une vidéo, on affiche la PREMIÈRE FRAME
  // paused directement dans video-live et on lui demande de taper les
  // 4 coins du tableau sur cette même frame. Puis ▶ Démarrer relance
  // la lecture de la MÊME vidéo avec le tracking actif.
  const VCALIB_LABELS = ['HAUT-GAUCHE', 'HAUT-DROIT', 'BAS-GAUCHE', 'BAS-DROIT'];
  let videoCalibMode = false;
  let videoCalibPoints = [];
  let videoCalibStep = 0;

  function _waitForMetadata(v) {
    return new Promise((resolve) => {
      if (v.readyState >= 1 && v.duration && !isNaN(v.duration)) return resolve();
      const h = () => { v.removeEventListener('loadedmetadata', h); resolve(); };
      v.addEventListener('loadedmetadata', h);
      setTimeout(resolve, 3000);
    });
  }
  function _waitForSeek(v) {
    return new Promise((resolve) => {
      const h = () => { v.removeEventListener('seeked', h); resolve(); };
      v.addEventListener('seeked', h);
      setTimeout(resolve, 800);
    });
  }
  function _syncCanvasSize() {
    const v = document.getElementById('video-live');
    const c = document.getElementById('canvas-live');
    if (!v || !c) return;
    c.width = v.clientWidth || 320;
    c.height = v.clientHeight || 240;
  }

  async function start() {
    document.getElementById('camera-live-wrap').classList.add('visible');
    document.getElementById('dwell-wrap').classList.add('visible');

    try {
      const v = document.getElementById('video-live');
      const hasVideoFile = !!(window.VideoSource && VideoSource.has());

      if (hasVideoFile) {
        // ═══ FLUX VIDÉO CHARGÉE — tout sur le même élément video-live ═══
        v.srcObject = null;
        v.src = VideoSource.url();
        v.loop = false;
        v.muted = false;
        v.playsInline = true;
        // Quand la vidéo se termine, afficher la transcription (sauf training)
        v.onended = trainingMode ? null : onVideoEnded;

        // Attendre que les métadonnées soient prêtes, se positionner sur
        // une frame représentative et PAUSER pour la calibration manuelle.
        await _waitForMetadata(v);
        const seekT = Math.min(0.3, (v.duration || 1) * 0.05);
        try {
          v.currentTime = seekT;
          await _waitForSeek(v);
        } catch (e) {}
        try { v.pause(); } catch (e) {}

        if (!trainingMode) {
          if (window.VideoSource.resetTranscript) VideoSource.resetTranscript();
          if (window.App) App.clearAll && App.clearAll();
        }

        Calibration.load();
        if (Calibration.stopTracking) Calibration.stopTracking();

        await new Promise(r => requestAnimationFrame(r));
        _syncCanvasSize();

        if (!Calibration.isCalibrated()) {
          // Pas encore calibré pour cette vidéo → mode calibration inline
          // sur la frame paused. detectLoop ne démarre pas tant que
          // l'utilisateur n'a pas touché les 4 coins ET appuyé ▶ Démarrer.
          startVideoCalibMode();
          return;
        }
        // Déjà calibré → on peut commencer directement (mais on va rejouer
        // depuis le début pour une expérience cohérente)
        try { v.currentTime = 0; await _waitForSeek(v); } catch (e) {}
        await _beginVideoPlaybackInternal(v, /*fromCalib=*/false);
        return;
      }

      // ═══ FLUX CAMÉRA LIVE ═══
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      v.srcObject = stream;
      v.src = '';
      v.onended = null;
      await v.play();

      detectActive = true;
      setDetectionState('searching');

      setTimeout(() => { _syncCanvasSize(); }, 300);

      Calibration.load();
      if (Calibration.stopTracking) Calibration.stopTracking();
      if (!Calibration.isCalibrated()) {
        if (window.App) App.setStatus('orange', 'Pas de calibration — touchez 📐');
      }

      const source = getSource();
      console.log('[camera] source =', source);

      if (source === 'handheld') {
        if (window.App) App.setStatus('orange', 'Chargement MediaPipe Pose…');
        loadPose().then(() => {
          if (poseInstance && window.App) App.setStatus('green', '👣 Pose actif — cherche le pied');
        }).catch((e) => {
          console.warn('[camera] Pose load failed', e);
          if (window.App) App.setStatus('orange', 'Pose indisponible — bascule en mode fixe');
          usePoseModel = false;
        });
      } else {
        usePoseModel = false;
        if (window.App) App.setStatus('orange', 'Caméra fixe — cherche le pied');
        captureBackgroundAfter(1200);
      }

      detectLoop();

    } catch (e) {
      if (window.App) App.setStatus('red', 'Erreur caméra : ' + e.message);
    }
  }

  // ═══════════════════════════════════════════
  // CALIBRATION INLINE POUR VIDÉO CHARGÉE
  // ═══════════════════════════════════════════

  function startVideoCalibMode() {
    videoCalibMode = true;
    videoCalibPoints = [];
    videoCalibStep = 0;
    detectActive = false;

    const wrap = document.getElementById('camera-live-wrap');
    if (wrap) wrap.classList.add('video-calibrating');
    const overlay = document.getElementById('video-calib-overlay');
    if (overlay) overlay.style.display = 'flex';

    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('vcalib-dot-' + i);
      if (d) d.className = 'step-dot' + (i === 0 ? ' current' : '');
    }
    _updateVCalibMsg();

    const playBtn = document.getElementById('vcalib-play-btn');
    if (playBtn) playBtn.style.display = 'none';

    const canvas = document.getElementById('canvas-live');
    canvas.addEventListener('click', onVideoCalibTap, true);
    canvas.addEventListener('touchend', onVideoCalibTap, true);

    _drawVideoCalibOverlay();

    if (window.App) App.setStatus('blue', 'Touchez les 4 coins du tableau sur la vidéo paused');
  }

  function _updateVCalibMsg() {
    const msg = document.getElementById('vcalib-msg');
    if (!msg) return;
    if (videoCalibStep < 4) {
      msg.innerHTML = `👆 Touchez <b>${VCALIB_LABELS[videoCalibStep]}</b> du tableau`;
    } else {
      msg.innerHTML = '✅ <b>4 coins pointés</b> — touchez <b>▶ Démarrer</b>';
    }
  }

  function onVideoCalibTap(e) {
    if (!videoCalibMode) return;
    // Ne pas intercepter les clics sur les boutons de l'overlay
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'BUTTON' || tgt.closest('button'))) return;
    e.preventDefault();
    e.stopPropagation();
    if (videoCalibStep >= 4) return;

    const canvas = document.getElementById('canvas-live');
    const rect = canvas.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    const cssX = t.clientX - rect.left;
    const cssY = t.clientY - rect.top;

    const v = document.getElementById('video-live');
    const norm = Calibration.cssToVideoNorm(cssX, cssY, v);
    videoCalibPoints.push({ x: norm.x, y: norm.y });

    const dOld = document.getElementById('vcalib-dot-' + videoCalibStep);
    if (dOld) dOld.className = 'step-dot done';
    videoCalibStep++;

    if (videoCalibStep < 4) {
      const dNew = document.getElementById('vcalib-dot-' + videoCalibStep);
      if (dNew) dNew.className = 'step-dot current';
    } else {
      const playBtn = document.getElementById('vcalib-play-btn');
      if (playBtn) playBtn.style.display = '';
    }
    _updateVCalibMsg();
    _drawVideoCalibOverlay();
  }

  function resetVideoCalib() {
    if (!videoCalibMode) return;
    videoCalibPoints = [];
    videoCalibStep = 0;
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('vcalib-dot-' + i);
      if (d) d.className = 'step-dot' + (i === 0 ? ' current' : '');
    }
    const playBtn = document.getElementById('vcalib-play-btn');
    if (playBtn) playBtn.style.display = 'none';
    _updateVCalibMsg();
    _drawVideoCalibOverlay();
  }

  function _drawVideoCalibOverlay() {
    const c = document.getElementById('canvas-live');
    const v = document.getElementById('video-live');
    if (!c || !v) return;
    _syncCanvasSize();
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);

    // Dessiner les points déjà placés
    videoCalibPoints.forEach((p, i) => {
      const css = Calibration.videoNormToCss(p.x, p.y, v);
      ctx.beginPath();
      ctx.arc(css.x, css.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(29,158,117,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.font = 'bold 13px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), css.x, css.y);
    });

    // Quadrilatère une fois les 4 coins posés
    if (videoCalibPoints.length === 4) {
      const pxs = videoCalibPoints.map(p => Calibration.videoNormToCss(p.x, p.y, v));
      ctx.beginPath();
      ctx.moveTo(pxs[0].x, pxs[0].y);
      ctx.lineTo(pxs[1].x, pxs[1].y);
      ctx.lineTo(pxs[3].x, pxs[3].y);
      ctx.lineTo(pxs[2].x, pxs[2].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(29,158,117,0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = 'rgba(29,158,117,0.18)';
      ctx.fill();
    }
  }

  async function beginVideoPlayback() {
    if (!videoCalibMode || videoCalibPoints.length !== 4) return;
    const v = document.getElementById('video-live');
    // Sauvegarder les points dans Calibration
    if (Calibration.setPoints) Calibration.setPoints(videoCalibPoints);
    if (Calibration.save) Calibration.save();

    // Capturer les templates MAINTENANT sur la frame EXACTE calibrée
    // (vidéo toujours paused). Un premier appel à trackFrame fait init.
    if (Calibration.trackFrame) Calibration.trackFrame(v);

    // Revenir au début de la vidéo pour la lecture complète (transcription
    // depuis T=0). Le tableau n'a très probablement pas bougé entre T=0 et
    // la frame de calibration : les templates restent valides, le tracker
    // prend le relais pour suivre les petits mouvements éventuels.
    try {
      v.currentTime = 0;
      await _waitForSeek(v);
    } catch (e) {}

    await _beginVideoPlaybackInternal(v, /*fromCalib=*/true);
  }

  async function _beginVideoPlaybackInternal(v, fromCalib) {
    videoCalibMode = false;
    const wrap = document.getElementById('camera-live-wrap');
    if (wrap) wrap.classList.remove('video-calibrating');
    const overlay = document.getElementById('video-calib-overlay');
    if (overlay) overlay.style.display = 'none';

    const canvas = document.getElementById('canvas-live');
    canvas.removeEventListener('click', onVideoCalibTap, true);
    canvas.removeEventListener('touchend', onVideoCalibTap, true);

    _syncCanvasSize();

    const source = getSource();
    if (source === 'handheld') {
      if (window.App) App.setStatus('orange', 'Chargement MediaPipe Pose…');
      loadPose().then(() => {
        if (poseInstance && window.App) App.setStatus('green', '👣 Pose actif — cherche le pied');
      }).catch((e) => { usePoseModel = false; });
    } else {
      usePoseModel = false;
      if (window.App) App.setStatus('orange', 'Caméra fixe — cherche le pied');
    }

    detectActive = true;
    setDetectionState('searching');

    try { await v.play(); } catch (e) { console.warn('[camera] play failed', e); }

    detectLoop();
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
    // Nettoyer l'overlay de calibration vidéo (s'il était actif)
    videoCalibMode = false;
    videoCalibPoints = [];
    videoCalibStep = 0;
    const wrap = document.getElementById('camera-live-wrap');
    if (wrap) wrap.classList.remove('video-calibrating', 'visible');
    const overlay = document.getElementById('video-calib-overlay');
    if (overlay) overlay.style.display = 'none';
    const canvas = document.getElementById('canvas-live');
    if (canvas) {
      canvas.removeEventListener('click', onVideoCalibTap, true);
      canvas.removeEventListener('touchend', onVideoCalibTap, true);
    }
    document.getElementById('dwell-wrap').classList.remove('visible');
    if (window.App) App.setStatus('', 'Mode manuel');
    clearDwell();
    lastFootPos = null;
    lastFootUVBoard = null;
    smoothedFootPos = null;
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

      // SUIVI TEMPLATE : met à jour les 4 coins calibrés pour qu'ils
      // suivent le tableau même si la caméra bouge un peu (tremblements,
      // repositionnement léger). À faire AVANT de dessiner l'overlay.
      if (Calibration.isCalibrated() && Calibration.trackFrame) {
        try { Calibration.trackFrame(v); }
        catch (e) { console.warn('[camera] trackFrame error', e); }
      }

      // Overlay calibration : on ne dessine RIEN ici pour que la vidéo
      // reste propre. Seul le marqueur de pointe du pied sera affiché.

      // Détection pied
      if (usePoseModel && poseInstance && !pendingSend) {
        pendingSend = true;
        poseInstance.send({ image: v }).catch(() => { pendingSend = false; });
      } else if (!usePoseModel) {
        lastFootPos = detectFootFromPixels(v);
      }

      const rawFootPos = lastFootPos;
      if (!rawFootPos) {
        smoothedFootPos = null;
        clearDwell();
        lastFootUVBoard = null;
        setDetectionState('searching');
        return;
      }
      setDetectionState('detected');

      // ═══ LISSAGE TEMPOREL (EMA) ═══
      // Le pied spastique bouge sans arrêt → on lisse pour stabiliser.
      // Slider "lissage" dans ⚙ : 0 = pas de lissage, 0.9 = très lisse.
      const smoothSlider = document.getElementById('sl-smooth');
      const smoothing = smoothSlider ? parseFloat(smoothSlider.value) : 0.6;
      const alpha = 1 - smoothing; // alpha faible = plus de lissage
      if (!smoothedFootPos) {
        smoothedFootPos = { x: rawFootPos.x, y: rawFootPos.y };
      } else {
        smoothedFootPos.x += alpha * (rawFootPos.x - smoothedFootPos.x);
        smoothedFootPos.y += alpha * (rawFootPos.y - smoothedFootPos.y);
      }
      const footPos = smoothedFootPos;

      // ═══ MARQUEUR UNIQUE : pointe du pied ═══
      // Un seul marqueur sur la vidéo : un point précis à la position
      // lissée, avec halo + contour blanc pour lisibilité sur n'importe
      // quel fond, et une croix fine pour aider à juger la précision.
      const footCss = Calibration.videoNormToCss
        ? Calibration.videoNormToCss(footPos.x, footPos.y, v)
        : { x: footPos.x * c.width, y: footPos.y * c.height };
      const tx = footCss.x, ty = footCss.y;

      // Halo extérieur (visibilité)
      ctx.beginPath();
      ctx.arc(tx, ty, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(29,158,117,0.25)';
      ctx.fill();

      // Anneau blanc (contraste sur tous fonds)
      ctx.beginPath();
      ctx.arc(tx, ty, 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Point central plein (position précise)
      ctx.beginPath();
      ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#1d9e75';
      ctx.fill();

      // Croix fine (4 petits traits blancs) : aide à viser précisément
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx - 11, ty); ctx.lineTo(tx - 7, ty);
      ctx.moveTo(tx + 7, ty);  ctx.lineTo(tx + 11, ty);
      ctx.moveTo(tx, ty - 11); ctx.lineTo(tx, ty - 7);
      ctx.moveTo(tx, ty + 7);  ctx.lineTo(tx, ty + 11);
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

      // Pas de marqueur rouge de cible : le feedback de sélection se fait
      // via le surlignage de la case active + la barre de dwell.
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
      // On sauvegarde les pixels de la plus grande pour calculer la pointe.
      const visited = new Uint8Array(w * h);
      const stack = new Int32Array(w * h);
      let bestPixels = null;
      let bestSize = 0;
      let bestCx = 0, bestCy = 0;

      for (let start = 0; start < w * h; start++) {
        if (!mask[start] || visited[start]) continue;
        let top = 0;
        stack[top++] = start;
        visited[start] = 1;
        const pixels = [];
        let sumX = 0, sumY = 0;
        while (top > 0) {
          const p = stack[--top];
          pixels.push(p);
          const x = p % w;
          const y = (p - x) / w;
          sumX += x;
          sumY += y;
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
        if (pixels.length > bestSize) {
          bestSize = pixels.length;
          bestPixels = pixels;
          bestCx = sumX / pixels.length;
          bestCy = sumY / pixels.length;
        }
      }

      if (!bestPixels || bestSize < 15) return null;

      // ═══ DÉTECTION DE LA POINTE DU PIED ═══
      // Le pied entre dans le quadrilatère calibré depuis un bord (le pied
      // vient de la jambe). La pointe (gros orteil) est le point du blob
      // le PLUS ÉLOIGNÉ de tous les bords du quad. Ça fonctionne quelle que
      // soit l'orientation du pied.
      if (pts) {
        const quad = [pts[0], pts[1], pts[3], pts[2]]; // TL, TR, BR, BL
        let maxDist = 0;
        const dists = new Float32Array(bestPixels.length);
        for (let i = 0; i < bestPixels.length; i++) {
          const p = bestPixels[i];
          const nx = (p % w) / w;
          const ny = ((p - (p % w)) / w) / h;
          dists[i] = minDistToQuadEdges(nx, ny, quad);
          if (dists[i] > maxDist) maxDist = dists[i];
        }
        if (maxDist > 0.001) {
          // Centroïde pondéré du top 18% de profondeur : les pixels les
          // plus proches de l'apex contribuent davantage → précision
          // sous-pixel sur la pointe même.
          const threshold = maxDist * 0.82;
          let tipSumX = 0, tipSumY = 0, tipSumW = 0;
          for (let i = 0; i < bestPixels.length; i++) {
            if (dists[i] >= threshold) {
              const p = bestPixels[i];
              const wt = dists[i] - threshold + 1e-4; // poids > 0
              tipSumX += (p % w) * wt;
              tipSumY += ((p - (p % w)) / w) * wt;
              tipSumW += wt;
            }
          }
          if (tipSumW > 0) {
            return { x: tipSumX / tipSumW / w, y: tipSumY / tipSumW / h };
          }
        }
      }
      // Fallback : centroïde (si pas de calibration ou blob trop petit)
      return { x: bestCx / w, y: bestCy / h };
    } catch (e) {
      console.warn('[camera] pixel detect error', e);
      return null;
    }
  }

  /** Distance minimale d'un point aux 4 segments d'un quadrilatère.
   *  Plus la valeur est grande, plus le point est "profond à l'intérieur". */
  function minDistToQuadEdges(px, py, quad) {
    let minD = Infinity;
    for (let i = 0; i < quad.length; i++) {
      const a = quad[i], b = quad[(i + 1) % quad.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      let d;
      if (lenSq < 1e-10) {
        d = Math.hypot(px - a.x, py - a.y);
      } else {
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
        d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
      }
      if (d < minD) minD = d;
    }
    return minD;
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
    const videoEl = document.getElementById('video-live');
    const rawPts = Calibration.getPoints();
    const pts = rawPts.map(p => Calibration.videoNormToCss(p.x, p.y, videoEl));
    if (!drawCalibOverlay._logged) {
      drawCalibOverlay._logged = true;
      console.log('[camera] drawCalibOverlay', {
        rawPts,
        cssPts: pts.map(p => [p.x.toFixed(1), p.y.toFixed(1)]),
        canvas: [canvas.width, canvas.height],
        video: [videoEl.clientWidth, videoEl.clientHeight],
        videoNative: [videoEl.videoWidth, videoEl.videoHeight]
      });
    }
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

  /** Dwell selection avec tolérance pour la spasticité.
   *  - Le pied peut brièvement glisser vers une case voisine ou quitter
   *    la détection sans réinitialiser le compteur (grâce de 400 ms).
   *  - Seul un déplacement vers une case DISTANTE ou une absence prolongée
   *    réinitialise le dwell. */
  function handleDwell(cell) {
    const now = Date.now();
    const GRACE_MS = 400; // tolérance spasticité

    if (!cell) {
      // Pied perdu : vérifier si on est dans la période de grâce
      if (dwellCell && now < dwellGraceEnd) {
        // En grâce → on continue d'afficher la barre mais on ne progresse pas
        return;
      }
      clearDwell();
      return;
    }

    if (cell === dwellCell) {
      // Même case → accumuler le dwell et rafraîchir la grâce
      dwellGraceEnd = now + GRACE_MS;
      const target = parseFloat(document.getElementById('sl-dwell').value) * 1000;
      const elapsed = now - dwellStart;
      const ratio = Math.min(elapsed / target, 1);
      document.getElementById('dwell-bar').style.width = (ratio * 100) + '%';
      if (elapsed >= target) {
        cell.classList.remove('c-loading');
        if (window.App) App.sel(cell, { fromCamera: true });
        clearDwell();
        // Cooldown post-sélection : empêcher re-sélection immédiate
        dwellGraceEnd = 0;
      }
      return;
    }

    // Case DIFFÉRENTE de la case en dwell
    if (dwellCell && now < dwellGraceEnd) {
      // On est dans la période de grâce → ignorer ce glissement
      // (le pied a bougé par spasticité, pas par volonté)
      return;
    }

    // Hors grâce ou pas de dwell en cours → commencer un nouveau dwell
    clearDwell();
    dwellCell = cell;
    dwellStart = now;
    dwellGraceEnd = now + GRACE_MS;
    cell.classList.add('c-loading');
  }

  function clearDwell() {
    if (dwellCell) {
      dwellCell.classList.remove('c-loading');
      dwellCell = null;
    }
    dwellStart = null;
    dwellGraceEnd = 0;
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
    startTraining, stopTrainingAndGetTrace,
    beginVideoPlayback, resetVideoCalib
  };
})();
