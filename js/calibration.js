// ═══════════════════════════════════════════
// CALIBRATION 4 coins + APPRENTISSAGE OFFSET
// ═══════════════════════════════════════════
window.Calibration = (function() {
  const POINTS_KEY = 'calibPoints';
  const PAIRS_KEY = 'aac_offset_pairs';
  const LEARNED_KEY = 'aac_learned_offset';
  const MAX_PAIRS = 20;
  const CORNERS = ['HAUT-GAUCHE', 'HAUT-DROIT', 'BAS-GAUCHE', 'BAS-DROIT'];

  // ═══════════════════════════════════════════
  // UTILITAIRES object-fit:contain
  // ═══════════════════════════════════════════
  // Avec object-fit:contain, la vidéo est inscrite dans le conteneur
  // (barres noires possibles). Les coordonnées CSS ne correspondent pas
  // directement aux coordonnées vidéo natives. Ces fonctions font la conversion.

  /** Calcule le mapping object-fit:contain entre un élément vidéo et son contenu.
   *  Avec contain, la vidéo est inscrite dans le conteneur (barres noires possibles).
   *  Retourne la taille rendue (rw,rh) et l'offset (ox,oy) des barres. */
  function containMapping(videoEl) {
    const cw = videoEl.clientWidth;
    const ch = videoEl.clientHeight;
    const vw = videoEl.videoWidth || cw;
    const vh = videoEl.videoHeight || ch;
    if (cw === 0 || ch === 0 || vw === 0 || vh === 0) {
      return { rw: cw, rh: ch, ox: 0, oy: 0, cw, ch };
    }
    const containerAR = cw / ch;
    const videoAR = vw / vh;
    let rw, rh;
    if (videoAR > containerAR) {
      // Vidéo plus large → largeur cale, barres en haut/bas
      rw = cw;
      rh = cw / videoAR;
    } else {
      // Vidéo plus haute → hauteur cale, barres à gauche/droite
      rh = ch;
      rw = ch * videoAR;
    }
    const ox = (cw - rw) / 2;
    const oy = (ch - rh) / 2;
    return { rw, rh, ox, oy, cw, ch };
  }

  /** Position CSS (pixels dans l'élément) → coordonnées vidéo normalisées [0,1]. */
  function cssToVideoNorm(cssPxX, cssPxY, videoEl) {
    const m = containMapping(videoEl);
    return {
      x: (cssPxX - m.ox) / m.rw,
      y: (cssPxY - m.oy) / m.rh
    };
  }

  /** Coordonnées vidéo normalisées [0,1] → position CSS (pixels dans l'élément). */
  function videoNormToCss(normX, normY, videoEl) {
    const m = containMapping(videoEl);
    return {
      x: normX * m.rw + m.ox,
      y: normY * m.rh + m.oy
    };
  }

  // État du wizard
  let stream = null;
  let points = [];
  let step = 0;
  let state = 'idle'; // idle | streaming | tapping | done
  // Détection automatique continue
  let liveActive = false;
  let liveTimer = null;
  let liveLockedByUser = false; // true dès que l'utilisateur tap manuellement
  // Destination one-shot après "Utiliser →" (sinon : main en mode caméra)
  let returnToOnce = null;

  function setReturnToOnce(dest) { returnToOnce = dest; }

  // Marqueur de format : les anciennes calibrations (sans _fmt) étaient en
  // coordonnées CSS-normalisées. Les nouvelles (_fmt=2) sont en coordonnées
  // vidéo natives. On invalide automatiquement les anciennes.
  const CALIB_FORMAT = 3;
  const FORMAT_KEY = 'calibPoints_fmt';

  function load() {
    try {
      const fmt = parseInt(localStorage.getItem(FORMAT_KEY) || '0', 10);
      if (fmt < CALIB_FORMAT) {
        // Ancien format détecté → invalider
        console.warn('[calib] ancien format de calibration détecté (v' + fmt + '), réinitialisation');
        localStorage.removeItem(POINTS_KEY);
        localStorage.setItem(FORMAT_KEY, String(CALIB_FORMAT));
        points = [];
        return points;
      }
      const raw = localStorage.getItem(POINTS_KEY);
      if (raw) points = JSON.parse(raw) || [];
    } catch (e) { points = []; }
    return points;
  }

  function getPoints() { return points; }

  // ═══════════════════════════════════════════
  // PROFILS DE CALIBRATION (multiples, nommés)
  // ═══════════════════════════════════════════
  const PROFILES_KEY = 'aac_calib_profiles';
  const ACTIVE_PROFILE_KEY = 'aac_active_profile';

  function listProfiles() {
    try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function getActiveProfileName() {
    return localStorage.getItem(ACTIVE_PROFILE_KEY) || '';
  }

  function saveProfile(name) {
    if (!name || !name.trim()) return false;
    name = name.trim();
    if (!isCalibrated()) return false;
    const profiles = listProfiles().filter(p => p.name !== name);
    profiles.push({ name, points: points.slice(), createdAt: Date.now() });
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    localStorage.setItem(ACTIVE_PROFILE_KEY, name);
    return true;
  }

  function loadProfile(name) {
    const profiles = listProfiles();
    const p = profiles.find(x => x.name === name);
    if (!p) return false;
    points = p.points.slice();
    localStorage.setItem(POINTS_KEY, JSON.stringify(points));
    localStorage.setItem(ACTIVE_PROFILE_KEY, name);
    return true;
  }

  function deleteProfile(name) {
    const profiles = listProfiles().filter(p => p.name !== name);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    if (getActiveProfileName() === name) {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  }

  function renderProfilesUI() {
    const list = document.getElementById('profiles-list');
    if (!list) return;
    const profiles = listProfiles();
    const active = getActiveProfileName();
    if (profiles.length === 0) {
      list.innerHTML = '<div class="setting-hint">Aucun profil enregistré. Calibrez, puis touchez "Sauvegarder sous…" ci-dessus.</div>';
      return;
    }
    list.innerHTML = '';
    profiles.forEach(p => {
      const row = document.createElement('div');
      row.className = 'profile-row' + (p.name === active ? ' active' : '');
      row.innerHTML = `
        <span class="profile-name"></span>
        <button class="fav-btn" data-act="load">Charger</button>
        <button class="fav-btn del" data-act="del">🗑</button>
      `;
      row.querySelector('.profile-name').textContent = p.name + (p.name === active ? ' ✓' : '');
      row.querySelector('[data-act="load"]').onclick = () => {
        if (loadProfile(p.name) && window.App) {
          App.setStatus('blue', `Profil "${p.name}" chargé`);
          renderProfilesUI();
        }
      };
      row.querySelector('[data-act="del"]').onclick = () => {
        if (confirm(`Supprimer le profil "${p.name}" ?`)) {
          deleteProfile(p.name);
          renderProfilesUI();
        }
      };
      list.appendChild(row);
    });
  }

  function promptAndSaveProfile() {
    if (!isCalibrated()) {
      alert('Calibrez d\'abord les 4 coins du tableau avant de sauvegarder un profil.');
      return;
    }
    const name = prompt('Nom du profil (ex: "Caméra fixe", "iPhone") :', getActiveProfileName() || '');
    if (name && saveProfile(name)) {
      renderProfilesUI();
      if (window.App) App.setStatus('blue', `Profil "${name}" sauvegardé`);
    }
  }

  function reset() {
    stopLive();
    points = [];
    step = 0;
    state = 'idle';
    liveLockedByUser = false;
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
      const v = document.getElementById('video-calib');
      // Source : fichier vidéo chargé OU caméra live
      if (window.VideoSource && VideoSource.has()) {
        v.srcObject = null;
        v.src = VideoSource.url();
        v.loop = false;
        v.muted = true;
        v.playsInline = true;
        await v.play();
        // Avancer de 0.5s pour avoir un vrai frame à analyser
        try {
          v.currentTime = Math.min(0.5, v.duration * 0.1 || 0.5);
        } catch (e) {}
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        v.srcObject = stream;
        v.src = '';
        await v.play();
      }
      state = 'streaming';
      liveLockedByUser = false;
      setCalibMsg('🔍 <b>Recherche du tableau…</b><br>Cadrez le tableau entier, bien éclairé. Le cadre vert s\'affichera dès qu\'il est détecté.');
      const btn = document.getElementById('calib-action-btn');
      if (btn) { btn.textContent = 'Utiliser →'; btn.disabled = true; btn.style.opacity = '0.5'; }
      showAutoBtn(true);

      // Dimensionner le canvas pour qu'il corresponde à la taille CSS affichée
      await new Promise(r => requestAnimationFrame(r));
      sizeCanvasToVideo();

      // Dès que la vidéo est dimensionnée, re-dimensionner le canvas
      if (v && !v._resizeHooked) {
        v._resizeHooked = true;
        v.addEventListener('loadedmetadata', sizeCanvasToVideo);
        window.addEventListener('resize', sizeCanvasToVideo);
      }

      // Armer le tap manuel comme fallback (mais il ne s'active que sur tap réel)
      armManual();

      // Démarrer la détection en continu
      startLive();

    } catch (e) {
      console.error('[calib] camera error', e);
      setCalibMsg(`<span style="color:#e74c3c">Erreur caméra : ${e.message}. Vérifiez les permissions.</span>`);
    }
  }

  function sizeCanvasToVideo() {
    const v = document.getElementById('video-calib');
    const c = document.getElementById('canvas-calib');
    if (!v || !c) return;
    const rect = v.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      c.width = Math.round(rect.width);
      c.height = Math.round(rect.height);
    }
  }

  function setCalibMsg(html) {
    const m = document.getElementById('calib-msg');
    if (m) m.innerHTML = html;
  }

  function setActionEnabled(enabled) {
    const btn = document.getElementById('calib-action-btn');
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.5';
  }

  function action() {
    if (state === 'idle') { startCam(); return; }
    if (state === 'done') {
      stopLive();
      stopCam();
      save();
      // Routage : si un retour one-shot est défini, on y va ; sinon, main caméra.
      const dest = returnToOnce;
      returnToOnce = null;
      if (dest === 'training') {
        if (window.App) App.showScreen('training');
      } else if (window.App) {
        App.goMain('camera');
      }
      return;
    }
    // streaming / tapping : forcer une nouvelle tentative auto
    auto();
  }

  // État du drag des poignées de coin (pour ajustement fin post-détection)
  let draggingHandle = -1; // index du coin en cours de drag (0-3), -1 sinon
  const HANDLE_GRAB_RADIUS = 30; // rayon en CSS px pour grab une poignée

  /** Arme l'écoute tap + drag sur le canvas.
   *  - Si 4 coins déjà présents : le tap près d'un coin lance un drag
   *    pour ajuster sa position, n'importe où ailleurs n'a pas d'effet.
   *  - Sinon : le tap ajoute le prochain coin manuellement (flux original). */
  function armManual() {
    const canvas = document.getElementById('canvas-calib');
    if (!canvas) return;
    canvas.style.cursor = 'crosshair';
    canvas.ontouchstart = onCanvasDown;
    canvas.ontouchmove = onCanvasMove;
    canvas.ontouchend = onCanvasUp;
    canvas.onmousedown = onCanvasDown;
    canvas.onmousemove = onCanvasMove;
    canvas.onmouseup = onCanvasUp;
    canvas.onmouseleave = onCanvasUp;
    canvas.onclick = null; // on remplace par mousedown/up
  }

  function getEventCss(e) {
    const canvas = document.getElementById('canvas-calib');
    const rect = canvas.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return {
      rect,
      x: t.clientX - rect.left,
      y: t.clientY - rect.top
    };
  }

  /** Trouve la poignée de coin la plus proche (si dans le rayon), sinon -1 */
  function findHandleAt(cssPxX, cssPxY) {
    if (points.length !== 4) return -1;
    const v = document.getElementById('video-calib');
    let closest = -1;
    let minDist = HANDLE_GRAB_RADIUS;
    for (let i = 0; i < 4; i++) {
      const css = videoNormToCss(points[i].x, points[i].y, v);
      const d = Math.hypot(cssPxX - css.x, cssPxY - css.y);
      if (d < minDist) { minDist = d; closest = i; }
    }
    return closest;
  }

  function onCanvasDown(e) {
    e.preventDefault();
    const { x, y } = getEventCss(e);

    // Si on a déjà 4 coins (auto ou manuel complet), tenter le drag
    if (points.length === 4) {
      const h = findHandleAt(x, y);
      if (h >= 0) {
        // Grab une poignée : stop live auto, passer en mode ajustement
        liveLockedByUser = true;
        stopLive();
        draggingHandle = h;
        state = 'done';
        return;
      }
      // Tap hors d'une poignée en état done → ignore (évite les reset accidentels)
      return;
    }

    // Moins de 4 coins : flux tap manuel séquentiel (original)
    handleTap(e);
  }

  function onCanvasMove(e) {
    if (draggingHandle < 0) return;
    e.preventDefault();
    const { x, y } = getEventCss(e);
    const v = document.getElementById('video-calib');
    const norm = cssToVideoNorm(x, y, v);
    points[draggingHandle] = { x: norm.x, y: norm.y };
    drawPreviewQuad(points);
  }

  function onCanvasUp(e) {
    if (draggingHandle < 0) return;
    e.preventDefault();
    draggingHandle = -1;
    drawPreviewQuad(points);
  }

  function handleTap(e) {
    e.preventDefault();
    // Dès qu'on tape manuellement, on reprend le contrôle : stop live auto
    liveLockedByUser = true;
    stopLive();

    const canvas = document.getElementById('canvas-calib');
    const ctx = canvas.getContext('2d');

    // Si on était en état 'done' (via live auto), repartir de zéro en manuel
    if (state === 'done' || step === 4) {
      points = [];
      step = 0;
      for (let i = 0; i < 4; i++) {
        const d = document.getElementById('dot-' + i);
        if (d) d.className = 'step-dot';
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setActionEnabled(false);
    }
    state = 'tapping';

    const { rect } = getEventCss(e);
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const cssPxX = t.clientX - rect.left;
    const cssPxY = t.clientY - rect.top;

    // Convertir la position CSS → coordonnées vidéo natives [0,1]
    // pour tenir compte de object-fit:cover (zoom/crop)
    const videoEl = document.getElementById('video-calib');
    const norm = cssToVideoNorm(cssPxX, cssPxY, videoEl);

    points.push({ x: norm.x, y: norm.y });
    drawPoint(ctx, cssPxX, cssPxY, step + 1);

    document.getElementById('dot-' + step).className = 'step-dot done';
    step++;

    if (step < 4) {
      setCalibMsg(`✅ Coin ${step}/4 enregistré. Touchez <b>${CORNERS[step]}</b> à l'écran.`);
      const d = document.getElementById('dot-' + step);
      if (d) d.className = 'step-dot current';
    } else {
      state = 'done';
      setCalibMsg('✅ <b>4 coins enregistrés</b>. Vous pouvez <b>glisser chaque coin</b> pour affiner, puis toucher <b>Utiliser →</b>.');
      const btn = document.getElementById('calib-action-btn');
      if (btn) btn.textContent = 'Utiliser →';
      setActionEnabled(true);
      drawPreviewQuad(points);
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
    stopLive();
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    // Si on était sur un fichier vidéo, pause (mais ne clear pas la source)
    const v = document.getElementById('video-calib');
    if (v && v.src && !v.srcObject) {
      try { v.pause(); } catch (e) {}
    }
  }

  function save() {
    localStorage.setItem(POINTS_KEY, JSON.stringify(points));
    localStorage.setItem(FORMAT_KEY, String(CALIB_FORMAT));
    console.log('[calib] save() points =', JSON.stringify(points));
  }

  function isCalibrated() {
    return points && points.length === 4;
  }

  // ═══════════════════════════════════════════
  // AUTO-DÉTECTION DES 4 COINS (Phase 3.8 — hull + multi-candidats)
  // ═══════════════════════════════════════════
  // Algorithme amélioré :
  //   1. Masque saturation + ouverture (enlève bruit) + fermeture morphologique
  //   2. Extraction de TOUTES les composantes (pas seulement la plus grande)
  //   3. Pour chaque candidate : convex hull + quadrilatère inscrit de max aire
  //   4. Score de forme (rectangularité × fill × taille × AR raisonnable)
  //   5. Sélection du meilleur candidat selon son score global
  //   6. Validation finale : convexité, remplissage du quad, rectangularité
  //   7. Lissage temporel (EMA) pour stabiliser les coins entre frames

  // Historique pour lissage temporel des coins détectés
  let _smoothedCorners = null;  // [TL,TR,BL,BR] lissé
  const EMA_ALPHA = 0.35;       // poids de la nouvelle frame (0=stable, 1=réactif)
  const MAX_JUMP = 0.12;        // saut max toléré entre frames (en coords normalisées)

  function resetSmoothing() { _smoothedCorners = null; }

  /** Lance la boucle de détection continue (~400 ms) */
  function startLive() {
    stopLive();
    liveActive = true;
    resetSmoothing();
    tickLive();
  }

  function stopLive() {
    liveActive = false;
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  }

  function tickLive() {
    if (!liveActive) return;
    try { runLiveFrame(); }
    catch (e) { console.warn('[calib] live frame error', e); }
    liveTimer = setTimeout(tickLive, 400);
  }

  function runLiveFrame() {
    if (liveLockedByUser) return;
    const v = document.getElementById('video-calib');
    if (!v || v.readyState < 2 || !v.videoWidth) {
      setCalibMsg('⏳ <b>Initialisation de la caméra…</b>');
      return;
    }
    const detected = detectBoardCorners(v);
    if (detected) {
      points = detected;
      step = 4;
      state = 'done';
      for (let i = 0; i < 4; i++) {
        const d = document.getElementById('dot-' + i);
        if (d) d.className = 'step-dot done';
      }
      drawPreviewQuad(detected);
      setCalibMsg('✅ <b>Tableau détecté !</b> Vous pouvez <b>glisser chaque coin au doigt</b> pour affiner précisément, puis toucher <b>Utiliser →</b>.');
      const btn = document.getElementById('calib-action-btn');
      if (btn) btn.textContent = 'Utiliser →';
      setActionEnabled(true);
    } else {
      // Pas trouvé : on garde une détection précédente si elle existe
      if (state !== 'done') {
        setCalibMsg('🔍 <b>Recherche du tableau…</b><br>Cadrez-le entièrement. Un cadre vert s\'affichera dès qu\'il est détecté.');
        setActionEnabled(false);
      }
    }
  }

  /** Bouton "⚡ Auto" : force une nouvelle analyse immédiate (one-shot) */
  function auto() {
    liveLockedByUser = false;
    resetSmoothing();
    if (!liveActive) startLive();
    // Et on déclenche une frame tout de suite
    try { runLiveFrame(); } catch (e) { console.warn('[calib] auto manual trigger error', e); }
  }

  // Compteur pour debug (affiche dans la console toutes les N frames)
  let _detectCounter = 0;

  /** Dilatation : tout pixel dont au moins un voisin dans le carré (2r+1)² est à 1 → 1 */
  function morphDilate(mask, W, H, r) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let found = 0;
        for (let dy = -r; dy <= r && !found; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -r; dx <= r && !found; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (mask[ny * W + nx]) found = 1;
          }
        }
        out[y * W + x] = found;
      }
    }
    return out;
  }

  /** Érosion : tout pixel dont tous les voisins dans le carré (2r+1)² sont à 1 → 1 */
  function morphErode(mask, W, H, r) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let allOk = 1;
        for (let dy = -r; dy <= r && allOk; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) { allOk = 0; break; }
          for (let dx = -r; dx <= r && allOk; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) { allOk = 0; break; }
            if (!mask[ny * W + nx]) allOk = 0;
          }
        }
        out[y * W + x] = allOk;
      }
    }
    return out;
  }

  /** Fermeture morphologique : dilatation puis érosion. Comble les trous. */
  function morphClose(mask, W, H, r) {
    return morphErode(morphDilate(mask, W, H, r), W, H, r);
  }

  /** Ouverture morphologique : érosion puis dilatation. Supprime les petits bruits. */
  function morphOpen(mask, W, H, r) {
    return morphDilate(morphErode(mask, W, H, r), W, H, r);
  }

  /** Produit vectoriel 2D : (A-O) × (B-O). > 0 : CCW, < 0 : CW, = 0 : colinéaire. */
  function crossProd(O, A, B) {
    return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  }

  /** Convex hull par algorithme d'Andrew (monotone chain). O(n log n).
   *  Retourne les sommets dans l'ordre CCW (y pointant vers le bas → visuellement CW). */
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && crossProd(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && crossProd(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /** Aire d'un triangle (valeur absolue). */
  function triArea(A, B, C) {
    return Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) * 0.5;
  }

  /** Aire d'un quadrilatère convexe [p0, p1, p2, p3] (dans l'ordre du parcours). */
  function quadAreaOrdered(p0, p1, p2, p3) {
    return triArea(p0, p1, p2) + triArea(p0, p2, p3);
  }

  /** Trouve le quadrilatère inscrit de surface maximale sur le convex hull.
   *  Approche : pour chaque diagonale (i,k), chercher le meilleur j (côté 1)
   *  et le meilleur l (côté 2). Exploite la monotonie via rotation en O(n²).
   *  Retourne les 4 points dans l'ordre du hull (CCW). */
  function maxAreaInscribedQuad(hull) {
    const n = hull.length;
    if (n < 4) return null;
    if (n === 4) return hull.slice();

    let bestArea = -Infinity;
    let best = null;

    // Pour chaque paire (i, k) diagonale, chercher j entre i+1..k-1 et l entre k+1..i-1
    for (let i = 0; i < n; i++) {
      let j = (i + 1) % n;
      for (let kk = 2; kk <= n - 2; kk++) {
        const k = (i + kk) % n;
        // Avancer j tant que l'aire du triangle (i,j,k) augmente
        let jNext = (j + 1) % n;
        while (jNext !== k &&
               triArea(hull[i], hull[jNext], hull[k]) >= triArea(hull[i], hull[j], hull[k])) {
          j = jNext;
          jNext = (j + 1) % n;
        }
        // Chercher le meilleur l de l'autre côté (k+1..i-1) — linéaire mais borné
        let bestL = -1;
        let bestLArea = -1;
        for (let ll = 1; ll < n - kk; ll++) {
          const l = (k + ll) % n;
          if (l === i) break;
          const a = triArea(hull[k], hull[l], hull[i]);
          if (a > bestLArea) { bestLArea = a; bestL = l; }
        }
        if (j !== i && j !== k && bestL !== -1 && bestL !== i && bestL !== k) {
          const area = triArea(hull[i], hull[j], hull[k]) + bestLArea;
          if (area > bestArea) {
            bestArea = area;
            best = [hull[i], hull[j], hull[k], hull[bestL]];
          }
        }
      }
    }
    return best;
  }

  /** Ordonne 4 coins dans l'ordre [TL, TR, BL, BR] selon leur position
   *  relative au centroïde. Retourne null si une position est dégénérée. */
  function orderCornersTLTRBLBR(quad) {
    if (!quad || quad.length !== 4) return null;
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    let tl = null, tr = null, bl = null, br = null;
    for (const p of quad) {
      if (p.x <= cx && p.y <= cy)      tl = tl === null ? p : (p.x + p.y < tl.x + tl.y ? p : tl);
      else if (p.x > cx && p.y <= cy)  tr = tr === null ? p : (p.y - p.x < tr.y - tr.x ? p : tr);
      else if (p.x <= cx && p.y > cy)  bl = bl === null ? p : (p.x - p.y < bl.x - bl.y ? p : bl);
      else                              br = br === null ? p : (p.x + p.y > br.x + br.y ? p : br);
    }
    // Fallback : si un quadrant manque, utiliser un tri par score diagonal
    if (!tl || !tr || !bl || !br) {
      const byTL  = quad.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y))[0];
      const byBR  = quad.slice().sort((a, b) => (b.x + b.y) - (a.x + a.y))[0];
      const byTR  = quad.slice().sort((a, b) => (b.x - b.y) - (a.x - a.y))[0];
      const byBL  = quad.slice().sort((a, b) => (a.x - a.y) - (b.x - b.y))[0];
      if (byTL === byTR || byTL === byBL || byBR === byTR || byBR === byBL) return null;
      return [byTL, byTR, byBL, byBR];
    }
    return [tl, tr, bl, br];
  }

  /** Vérifie que 4 coins forment un quadrilatère convexe.
   *  Ordre attendu : [TL, TR, BL, BR] → parcours TL→TR→BR→BL. */
  function isConvexQuad(pts) {
    // Parcours dans l'ordre : TL(0) → TR(1) → BR(3) → BL(2)
    const order = [pts[0], pts[1], pts[3], pts[2]];
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = order[i];
      const b = order[(i + 1) % 4];
      const c = order[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross === 0) continue;
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  /** Lissage temporel EMA des coins. Retourne les coins lissés ou null si
   *  le saut est trop grand (la caméra a bougé → on réinitialise). */
  function smoothCorners(raw) {
    if (!_smoothedCorners) {
      _smoothedCorners = raw.map(p => ({ x: p.x, y: p.y }));
      return _smoothedCorners.map(p => ({ x: p.x, y: p.y }));
    }
    // Vérifier si le saut est trop grand (caméra déplacée)
    let maxDist = 0;
    for (let i = 0; i < 4; i++) {
      const dx = raw[i].x - _smoothedCorners[i].x;
      const dy = raw[i].y - _smoothedCorners[i].y;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy));
    }
    if (maxDist > MAX_JUMP) {
      // Grand saut : accepter la nouvelle position directement
      _smoothedCorners = raw.map(p => ({ x: p.x, y: p.y }));
      return _smoothedCorners.map(p => ({ x: p.x, y: p.y }));
    }
    // EMA : new = alpha * raw + (1-alpha) * old
    for (let i = 0; i < 4; i++) {
      _smoothedCorners[i].x = EMA_ALPHA * raw[i].x + (1 - EMA_ALPHA) * _smoothedCorners[i].x;
      _smoothedCorners[i].y = EMA_ALPHA * raw[i].y + (1 - EMA_ALPHA) * _smoothedCorners[i].y;
    }
    return _smoothedCorners.map(p => ({ x: p.x, y: p.y }));
  }

  /** Extrait les pixels de la frontière (boundary) d'une composante.
   *  Un pixel appartient à la frontière si au moins un de ses 4-voisins n'est pas dans mask. */
  function extractBoundary(comp, W, H, mask) {
    const pts = [];
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k];
      const x = p % W;
      const y = (p - x) / W;
      const left  = x > 0       ? mask[p - 1] : 0;
      const right = x < W - 1   ? mask[p + 1] : 0;
      const up    = y > 0       ? mask[p - W] : 0;
      const down  = y < H - 1   ? mask[p + W] : 0;
      if (!left || !right || !up || !down) pts.push({ x, y });
    }
    return pts;
  }

  /** BFS/DFS pour extraire toutes les composantes connexes de mask.
   *  Retourne un tableau de composantes (chaque comp = tableau d'indices). */
  function extractComponents(mask, W, H) {
    const comps = [];
    const visited = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
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
      comps.push(comp);
    }
    return comps;
  }

  /** Évalue une composante et retourne { score, quadNorm, metrics } ou null si invalide.
   *  quadNorm : [TL,TR,BL,BR] en coords normalisées pixel (0..W, 0..H) du canvas de travail. */
  function evalComponent(comp, W, H, mask, debug) {
    const size = comp.length;

    // Bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < size; k++) {
      const p = comp[k];
      const x = p % W;
      const y = (p - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const bboxArea = bboxW * bboxH;

    // Filtres durs : taille minimale
    if (bboxW < W * 0.15 || bboxH < H * 0.10) return null;
    const ar = bboxW / bboxH;
    if (ar < 0.35 || ar > 4.5) return null;
    const fillBbox = size / bboxArea;
    if (fillBbox < 0.30) return null;

    // Extraire la frontière et calculer le convex hull
    const boundary = extractBoundary(comp, W, H, mask);
    if (boundary.length < 4) return null;
    const hull = convexHull(boundary);
    if (hull.length < 4) return null;

    // Quadrilatère inscrit de max aire
    const quad = maxAreaInscribedQuad(hull);
    if (!quad) return null;

    // Ordonner [TL, TR, BL, BR]
    const ordered = orderCornersTLTRBLBR(quad);
    if (!ordered) return null;

    // Convexité (en normalisé [0,1])
    const norm = ordered.map(p => ({ x: p.x / W, y: p.y / H }));
    if (!isConvexQuad(norm)) return null;

    // Rectangularité : rapport entre l'aire du quad et l'aire de sa bbox.
    // Un vrai rectangle axé donne 1.0 ; un losange donne ~0.5.
    const qArea = quadAreaOrdered(ordered[0], ordered[1], ordered[3], ordered[2]);
    const rectangularity = qArea / bboxArea;

    // Taux de remplissage du quad : combien de pixels de la composante tombent
    // à l'intérieur du quad → proche de 1 pour un vrai rectangle.
    const fillQuad = qArea > 0 ? Math.min(1, size / qArea) : 0;

    // Filtres durs post-quad
    // Rectangularity peut être basse (~0.5) pour un tableau tilté à ~45°,
    // mais reste élevée pour un tableau raisonnablement cadré.
    if (rectangularity < 0.48) return null;
    if (fillQuad < 0.55) return null;

    // Score de forme : on favorise
    //   - la taille (log pour ne pas trop écraser les gros outliers)
    //   - la rectangularité (proche de 1)
    //   - le remplissage du quad
    //   - un ratio d'aspect raisonnable (~1.0 à 2.5 pour un tableau AAC)
    const arScore = 1.0 / (1.0 + Math.abs(Math.log(Math.max(ar, 1 / ar) / 1.6)));
    const score = Math.log(1 + size) * rectangularity * fillQuad * arScore;

    if (debug) {
      console.log('[calib] candidate', {
        size: size,
        bbox: bboxW + 'x' + bboxH,
        ar: ar.toFixed(2),
        fillBbox: fillBbox.toFixed(2),
        rect: rectangularity.toFixed(2),
        fillQuad: fillQuad.toFixed(2),
        score: score.toFixed(3)
      });
    }

    return {
      score,
      quadPx: ordered,
      quadNorm: norm,
      metrics: { size, bboxW, bboxH, ar, rectangularity, fillQuad }
    };
  }

  /** Détecte les 4 coins du tableau à partir d'une frame vidéo.
   *  Retourne un tableau [TL,TR,BL,BR] en coordonnées normalisées [0,1],
   *  ou null si la détection échoue. */
  function detectBoardCorners(video) {
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const W = 320;
    const H = Math.max(120, Math.round(W * vh / vw));

    const cvs = document.createElement('canvas');
    cvs.width = W;
    cvs.height = H;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(video, 0, 0, W, H);
    } catch (e) { console.warn('[calib] drawImage failed', e); return null; }
    let data;
    try { data = ctx.getImageData(0, 0, W, H).data; }
    catch (e) { console.warn('[calib] getImageData failed', e); return null; }

    // 1) Masque de saturation : pixels colorés = probablement tableau.
    const rawMask = new Uint8Array(W * H);
    let rawMaskCount = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (maxC < 35) continue; // trop sombre
      const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const sat = (maxC - minC) / maxC;
      if (sat > 0.18) {
        rawMask[i] = 1;
        rawMaskCount++;
      }
    }

    const debug = (++_detectCounter % 10 === 0);
    if (rawMaskCount < W * H * 0.012) {
      if (debug) console.log('[calib] no colorful pixels', { rawMaskCount, pct: (rawMaskCount / (W * H) * 100).toFixed(1) + '%' });
      return null;
    }

    // 2) Ouverture (supprime bruit isolé et ponts fins entre blobs distincts)
    //    puis fermeture (comble trous entre cellules colorées). L'ouverture
    //    r=1 sépare les blobs reliés par des ponts <= 2px ; la fermeture r=2
    //    rebouche les gaps internes entre cellules (~1-2px) sans rebâtir des
    //    ponts plus larges vers les éléments voisins.
    const opened = morphOpen(rawMask, W, H, 1);
    const mask = morphClose(opened, W, H, 2);

    // 3) Toutes les composantes connexes (pas seulement la plus grande)
    const components = extractComponents(mask, W, H);
    if (components.length === 0) {
      if (debug) console.log('[calib] no components');
      return null;
    }

    // Ne garder que les N plus grandes pour limiter le coût d'évaluation
    components.sort((a, b) => b.length - a.length);
    const MIN_COMP_SIZE = Math.max(60, Math.floor(W * H * 0.006));
    const candidates = components
      .filter(c => c.length >= MIN_COMP_SIZE)
      .slice(0, 5);

    if (candidates.length === 0) {
      if (debug) console.log('[calib] all components too small');
      return null;
    }

    // 4) Évaluer chaque candidat, garder le meilleur score
    let best = null;
    for (const comp of candidates) {
      const res = evalComponent(comp, W, H, mask, debug);
      if (res && (!best || res.score > best.score)) best = res;
    }

    if (!best) {
      if (debug) console.log('[calib] no valid candidate');
      return null;
    }

    if (debug) {
      console.log('[calib] ✓ detected', {
        score: best.score.toFixed(3),
        ar: best.metrics.ar.toFixed(2),
        rect: best.metrics.rectangularity.toFixed(2),
        fill: best.metrics.fillQuad.toFixed(2)
      });
    }

    // 5) Lissage temporel EMA
    return smoothCorners(best.quadNorm);
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

    // Convertir coords vidéo natives [0,1] → pixels CSS dans le canvas
    const pxs = pts.map(p => videoNormToCss(p.x, p.y, video));

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

    // Poignées de coin (draggables après détection/tap complet)
    const labels = ['HG', 'HD', 'BG', 'BD'];
    pxs.forEach((p, i) => {
      const isActive = (draggingHandle === i);
      // Cercle extérieur "halo" pour indiquer que c'est draggable
      ctx.beginPath();
      ctx.arc(p.x, p.y, isActive ? 28 : 22, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? 'rgba(240,192,48,0.3)' : 'rgba(29,158,117,0.25)';
      ctx.fill();
      // Poignée principale
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? 'rgba(240,192,48,0.95)' : 'rgba(29,158,117,0.95)';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2.5;
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
    recordPair, getLearnedOffset, resetOffsetLearning, initLabel,
    cssToVideoNorm, videoNormToCss,
    listProfiles, getActiveProfileName, saveProfile, loadProfile, deleteProfile,
    renderProfilesUI, promptAndSaveProfile,
    setReturnToOnce
  };
})();
