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
    // Le bouton "✋ Pointer" (manuel) apparaît en même temps que "⚡ Auto"
    const m = document.getElementById('calib-manual-btn');
    if (m) m.style.display = visible ? '' : 'none';
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
      setCalibMsg('🔍 <b>Recherche du tableau…</b><br>Cadrez le tableau entier (avec son <b>cadre rouge</b>), bien éclairé. Le quadrilatère vert s\'affichera dès qu\'il est détecté.');
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
  // AUTO-DÉTECTION DES 4 COINS (Phase 3.8 — cadre rouge prioritaire)
  // ═══════════════════════════════════════════
  // Le tableau imprimé a un cadre rouge fin qui l'entoure : on s'en sert comme
  // référence prioritaire car c'est un repère beaucoup plus net que la masse
  // colorée des cases (qui peut "fuir" sur le fond ou inclure des objets).
  //
  // Algorithme :
  //   PRIORITÉ A — Cadre rouge :
  //     1. Masque "rouge dominant" (R nettement > G, R > B)
  //     2. Fermeture morphologique légère (rebouche les coupures du contour)
  //     3. Plus grande composante connexe rouge
  //     4. Validation spécifique cadre : bbox, AR, fillRatio FAIBLE (creux)
  //     5. Coins par percentile (TL/TR/BL/BR)
  //   FALLBACK B — Saturation globale (ancien algo, si pas de cadre rouge) :
  //     1. Masque saturation + fermeture morphologique
  //     2. Plus grande composante connexe colorée
  //     3. Coins par percentile + validations remplissage / convexité
  //   6. Lissage temporel (EMA) appliqué dans tous les cas

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
        setCalibMsg('🔍 <b>Recherche du tableau…</b><br>Cadrez-le entièrement (le <b>cadre rouge</b> doit être visible). Un quadrilatère vert s\'affichera dès qu\'il est détecté.');
        setActionEnabled(false);
      }
    }
  }

  /** Bouton "✋ Pointer" : reprend le contrôle manuel, efface la détection
   *  auto en cours, et demande à l'utilisateur de toucher les 4 coins.
   *  Nécessaire quand la détection auto place des coins imprécis ou erronés. */
  function startManualTap() {
    liveLockedByUser = true;
    stopLive();
    points = [];
    step = 0;
    state = 'tapping';
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('dot-' + i);
      if (d) d.className = 'step-dot';
    }
    const d0 = document.getElementById('dot-0');
    if (d0) d0.className = 'step-dot current';
    const canvas = document.getElementById('canvas-calib');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setCalibMsg(`👆 Touchez <b>${CORNERS[0]}</b> du tableau.`);
    setActionEnabled(false);
    const btn = document.getElementById('calib-action-btn');
    if (btn) btn.textContent = 'Utiliser →';
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

  /** Fermeture morphologique sur un masque binaire (Uint8Array) de taille W×H.
   *  Dilate puis érode avec un noyau carré de rayon `r` pixels.
   *  Comble les trous (cellules blanches entre cellules colorées). */
  function morphClose(mask, W, H, r) {
    const N = W * H;
    const tmp = new Uint8Array(N);
    // Dilatation : si au moins un voisin dans le carré (2r+1)×(2r+1) est à 1 → 1
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
        tmp[y * W + x] = found;
      }
    }
    // Érosion : si tous les voisins dans le carré (2r+1)×(2r+1) sont à 1 → 1
    const out = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let allOk = 1;
        for (let dy = -r; dy <= r && allOk; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) { allOk = 0; break; }
          for (let dx = -r; dx <= r && allOk; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) { allOk = 0; break; }
            if (!tmp[ny * W + nx]) allOk = 0;
          }
        }
        out[y * W + x] = allOk;
      }
    }
    return out;
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

  /** Calcule TL/TR/BL/BR par percentile sur une composante connexe.
   *  comp : tableau d'indices linéaires (y*W+x). Retourne 4 points en pixels. */
  function cornersByPercentile(comp, W, percentile) {
    const scores = new Array(comp.length);
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k];
      const x = p % W;
      const y = (p - x) / W;
      scores[k] = { x, y, xPy: x + y, xMy: x - y };
    }
    scores.sort((a, b) => a.xPy - b.xPy);
    const idxLow = Math.floor(scores.length * percentile);
    const idxHigh = Math.floor(scores.length * (1 - percentile));
    const tlPt = scores[Math.max(0, idxLow)];
    const brPt = scores[Math.min(scores.length - 1, idxHigh)];
    scores.sort((a, b) => a.xMy - b.xMy);
    const blPt = scores[Math.max(0, idxLow)];
    const trPt = scores[Math.min(scores.length - 1, idxHigh)];
    return { tlPt, trPt, blPt, brPt };
  }

  /** Bbox d'une composante connexe (en pixels). */
  function compBbox(comp, W) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k];
      const x = p % W;
      const y = (p - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Plus grande composante connexe (BFS itératif, 4-connectivité)
   *  d'un masque binaire Uint8Array de taille W×H. Retourne {comp, size}. */
  function largestComponent(mask, W, H) {
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
        if (x > 0)     { const q = p - 1; if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; } }
        if (x < W - 1) { const q = p + 1; if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; } }
        if (y > 0)     { const q = p - W; if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; } }
        if (y < H - 1) { const q = p + W; if (mask[q] && !visited[q]) { visited[q] = 1; stack[top++] = q; } }
      }
      if (comp.length > bestSize) { bestSize = comp.length; bestComp = comp; }
    }
    return { comp: bestComp, size: bestSize };
  }

  /** Ajuste une droite y = a*x + b par moindres carrés sur un ensemble de
   *  points. `trimIter` itérations d'élagage des outliers (> 2σ). */
  function fitLineYofX(pts, trimIter) {
    trimIter = trimIter || 0;
    let fitPts = pts;
    let line = null;
    for (let iter = 0; iter <= trimIter; iter++) {
      const n = fitPts.length;
      if (n < 2) return line;
      let sx = 0, sy = 0, sxy = 0, sx2 = 0;
      for (let i = 0; i < n; i++) {
        const p = fitPts[i];
        sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x;
      }
      const denom = n * sx2 - sx * sx;
      const a = Math.abs(denom) < 1e-6 ? 0 : (n * sxy - sx * sy) / denom;
      const b = Math.abs(denom) < 1e-6 ? sy / n : (sy - a * sx) / n;
      line = { a, b };
      if (iter < trimIter) {
        let sumR2 = 0;
        for (let i = 0; i < n; i++) {
          const r = fitPts[i].y - (a * fitPts[i].x + b);
          sumR2 += r * r;
        }
        const sigma = Math.sqrt(sumR2 / n);
        const thr = 2 * sigma + 0.5;
        const kept = [];
        for (let i = 0; i < n; i++) {
          if (Math.abs(fitPts[i].y - (a * fitPts[i].x + b)) < thr) kept.push(fitPts[i]);
        }
        if (kept.length < 2) break;
        fitPts = kept;
      }
    }
    return line;
  }

  /** Ajuste une droite x = a*y + b par moindres carrés (pour bords verticaux). */
  function fitLineXofY(pts, trimIter) {
    trimIter = trimIter || 0;
    let fitPts = pts;
    let line = null;
    for (let iter = 0; iter <= trimIter; iter++) {
      const n = fitPts.length;
      if (n < 2) return line;
      let sx = 0, sy = 0, sxy = 0, sy2 = 0;
      for (let i = 0; i < n; i++) {
        const p = fitPts[i];
        sx += p.x; sy += p.y; sxy += p.x * p.y; sy2 += p.y * p.y;
      }
      const denom = n * sy2 - sy * sy;
      const a = Math.abs(denom) < 1e-6 ? 0 : (n * sxy - sx * sy) / denom;
      const b = Math.abs(denom) < 1e-6 ? sx / n : (sx - a * sy) / n;
      line = { a, b };
      if (iter < trimIter) {
        let sumR2 = 0;
        for (let i = 0; i < n; i++) {
          const r = fitPts[i].x - (a * fitPts[i].y + b);
          sumR2 += r * r;
        }
        const sigma = Math.sqrt(sumR2 / n);
        const thr = 2 * sigma + 0.5;
        const kept = [];
        for (let i = 0; i < n; i++) {
          if (Math.abs(fitPts[i].x - (a * fitPts[i].y + b)) < thr) kept.push(fitPts[i]);
        }
        if (kept.length < 2) break;
        fitPts = kept;
      }
    }
    return line;
  }

  /** Intersection d'une droite "horizontale-ish" (y = a*x + b) et
   *  "verticale-ish" (x = c*y + d). Retourne null si parallèles. */
  function intersectHV(h, v) {
    const denom = 1 - h.a * v.a;
    if (Math.abs(denom) < 1e-6) return null;
    const y = (h.a * v.b + h.b) / denom;
    const x = v.a * y + v.b;
    return { x, y };
  }

  /** Ajuste 4 droites sur les bords d'une composante (bandes haut/bas/gauche/
   *  droite de la bbox, chacune = 25 % de la dimension correspondante) puis
   *  calcule les 4 intersections (= vrais coins géométriques du cadre).
   *  Beaucoup plus précis que la méthode percentile pour un cadre net.
   *  Retourne {tlPt,trPt,blPt,brPt} en pixels, ou null si fit impossible. */
  function fitFrameCorners(comp, W, bb) {
    const bandH = Math.max(4, Math.round(bb.h * 0.25));
    const bandW = Math.max(4, Math.round(bb.w * 0.25));
    const topMax = bb.minY + bandH;
    const botMin = bb.maxY - bandH;
    const leftMax = bb.minX + bandW;
    const rightMin = bb.maxX - bandW;

    const topPts = [], botPts = [], leftPts = [], rightPts = [];
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k];
      const x = p % W;
      const y = (p - x) / W;
      if (y <= topMax) topPts.push({ x, y });
      if (y >= botMin) botPts.push({ x, y });
      if (x <= leftMax) leftPts.push({ x, y });
      if (x >= rightMin) rightPts.push({ x, y });
    }
    if (topPts.length < 8 || botPts.length < 8 ||
        leftPts.length < 8 || rightPts.length < 8) return null;

    const topL = fitLineYofX(topPts, 2);
    const botL = fitLineYofX(botPts, 2);
    const leftL = fitLineXofY(leftPts, 2);
    const rightL = fitLineXofY(rightPts, 2);
    if (!topL || !botL || !leftL || !rightL) return null;

    const tl = intersectHV(topL, leftL);
    const tr = intersectHV(topL, rightL);
    const bl = intersectHV(botL, leftL);
    const br = intersectHV(botL, rightL);
    if (!tl || !tr || !bl || !br) return null;

    // Sanity : les intersections doivent rester proches de la bbox
    const margin = Math.max(bb.w, bb.h) * 0.15;
    const within = (pt) =>
      pt.x >= bb.minX - margin && pt.x <= bb.maxX + margin &&
      pt.y >= bb.minY - margin && pt.y <= bb.maxY + margin;
    if (!within(tl) || !within(tr) || !within(bl) || !within(br)) return null;

    return { tlPt: tl, trPt: tr, blPt: bl, brPt: br };
  }

  /** Couverture des 4 arêtes d'un quadrilatère par des pixels rouges.
   *  Échantillonne le long de chaque arête (TL→TR→BR→BL→TL) et vérifie
   *  qu'un pixel rouge est présent dans un rayon de `tolerance` pixels.
   *  Retourne un ratio [0,1]. Permet de rejeter les cas où certains coins
   *  sont "étirés" par des pixels parasites loin du vrai cadre. */
  function edgeCoverage(cornersPx, redMask, W, H, tolerance) {
    tolerance = tolerance || 3;
    // Parcours dans l'ordre : TL(0) → TR(1) → BR(3) → BL(2)
    const order = [cornersPx[0], cornersPx[1], cornersPx[3], cornersPx[2]];
    let total = 0, hits = 0;
    for (let e = 0; e < 4; e++) {
      const pA = order[e];
      const pB = order[(e + 1) % 4];
      const dist = Math.hypot(pB.x - pA.x, pB.y - pA.y);
      const nSamples = Math.max(20, Math.round(dist));
      for (let i = 0; i <= nSamples; i++) {
        const t = i / nSamples;
        const sx = Math.round(pA.x + t * (pB.x - pA.x));
        const sy = Math.round(pA.y + t * (pB.y - pA.y));
        let hit = 0;
        for (let dy = -tolerance; dy <= tolerance && !hit; dy++) {
          const ny = sy + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -tolerance; dx <= tolerance && !hit; dx++) {
            const nx = sx + dx;
            if (nx < 0 || nx >= W) continue;
            if (redMask[ny * W + nx]) hit = 1;
          }
        }
        total++;
        if (hit) hits++;
      }
    }
    return total === 0 ? 0 : hits / total;
  }

  /** Détecte le CADRE ROUGE qui entoure le tableau imprimé.
   *  Retourne [TL,TR,BL,BR] en coords normalisées [0,1], ou null. */
  function detectRedFrameCorners(W, H, data, debug) {
    // 1) Masque "rouge dominant" + SATURATION élevée.
    //    La saturation exclut les tons chair (peau, ankle) et les bruns chauds
    //    du sol qui passaient le simple test R>G+30.
    const redMask = new Uint8Array(W * H);
    let redCount = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      // R dominant (pur rouge → magenta), saturation élevée, R != max(G,B) peau
      if (r > 100
          && (r - g) > 40
          && (r - b) > 10
          && sat > 0.40) {
        redMask[i] = 1;
        redCount++;
      }
    }
    if (redCount < W * H * 0.002) {
      if (debug) console.log('[calib/red] mask trop fin', { redCount });
      return null;
    }

    // 2) Fermeture morphologique légère (r=2) : reconnecte les coupures du
    //    cadre dues au flou / bruit, sans coller des éléments rouges étrangers.
    const mask = morphClose(redMask, W, H, 2);

    // 3) Plus grande composante connexe rouge
    const { comp: bestComp, size: bestSize } = largestComponent(mask, W, H);
    if (!bestComp || bestSize < W * H * 0.002) {
      if (debug) console.log('[calib/red] composante trop petite', { bestSize });
      return null;
    }

    // 4) Bbox + sanity checks (taille, ratio, "creusité" du cadre)
    const bb = compBbox(bestComp, W);
    if (bb.w < W * 0.20 || bb.h < H * 0.20) {
      if (debug) console.log('[calib/red] bbox trop petite', { w: bb.w, h: bb.h });
      return null;
    }
    const ar = bb.w / bb.h;
    if (ar < 0.6 || ar > 5.0) {
      if (debug) console.log('[calib/red] AR hors plage', { ar: ar.toFixed(2) });
      return null;
    }
    // Un VRAI cadre est creux : la composante remplit peu sa bbox (typiquement
    // <25% pour un trait fin). Au-dessus, c'est probablement une zone rouge
    // pleine (objet rouge dans la scène) → on rejette.
    const fillRatio = bestSize / (bb.w * bb.h);
    if (fillRatio > 0.30) {
      if (debug) console.log('[calib/red] pas un cadre (rempli)', { fillRatio: fillRatio.toFixed(2) });
      return null;
    }
    // Doit avoir au moins ~60 % du périmètre attendu (sinon fragment isolé)
    const expectedPerim = 2 * (bb.w + bb.h);
    if (bestSize < expectedPerim * 0.6) {
      if (debug) console.log('[calib/red] composante trop courte vs périmètre', {
        bestSize, expectedPerim
      });
      return null;
    }

    // 5) Deux candidats de coins : (a) ajustement de 4 droites aux bords,
    //    (b) percentile. On calcule la couverture des arêtes pour chacun
    //    et on garde le meilleur. L'ajustement de droites est généralement
    //    plus précis (coins = intersections géométriques réelles) mais peut
    //    dériver si les bords sont trop bruités ; le percentile sert alors
    //    de filet de sécurité.
    const candidates = [];
    const pushCandidate = (corners4, label) => {
      const cornersPx = [corners4.tlPt, corners4.trPt, corners4.blPt, corners4.brPt];
      const cornersN = [
        { x: cornersPx[0].x / W, y: cornersPx[0].y / H },
        { x: cornersPx[1].x / W, y: cornersPx[1].y / H },
        { x: cornersPx[2].x / W, y: cornersPx[2].y / H },
        { x: cornersPx[3].x / W, y: cornersPx[3].y / H }
      ];
      if (!isConvexQuad(cornersN)) return;
      const cov = edgeCoverage(cornersPx, redMask, W, H, 3);
      candidates.push({ corners: cornersN, cov, label });
    };

    const lineFit = fitFrameCorners(bestComp, W, bb);
    if (lineFit) pushCandidate(lineFit, 'lineFit');
    pushCandidate(cornersByPercentile(bestComp, W, 0.01), 'percentile');

    if (candidates.length === 0) {
      if (debug) console.log('[calib/red] aucun candidat convexe');
      return null;
    }
    candidates.sort((a, b) => b.cov - a.cov);
    const best = candidates[0];

    // 6) VÉRIFICATION D'INTÉGRITÉ : les 4 arêtes du quadrilatère prédit
    //    doivent traverser des pixels rouges dans le masque ORIGINAL.
    //    C'est ce qui rejette le cas où le haut du cadre est bien détecté
    //    mais le bas est "tiré" vers des pixels parasites (ex. peau, sol chaud).
    if (best.cov < 0.55) {
      if (debug) console.log('[calib/red] couverture arêtes insuffisante', {
        cov: (best.cov * 100).toFixed(0) + '%',
        label: best.label,
        bbox: bb.w + 'x' + bb.h
      });
      return null;
    }

    if (debug) {
      console.log('[calib/red] ✓ CADRE ROUGE détecté', {
        method: best.label,
        size: bestSize,
        bbox: bb.w + 'x' + bb.h,
        ar: ar.toFixed(2),
        fill: (fillRatio * 100).toFixed(1) + '%',
        cov: (best.cov * 100).toFixed(0) + '%'
      });
    }
    return best.corners;
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

    const debug = (++_detectCounter % 10 === 0);

    // ─── PRIORITÉ A : cadre rouge ─────────────────────────────────────────
    const redCorners = detectRedFrameCorners(W, H, data, debug);
    if (redCorners) {
      return smoothCorners(redCorners);
    }

    // ─── FALLBACK B : saturation globale (ancien algorithme) ──────────────
    // 1) Masque de saturation : pixels colorés = probablement tableau.
    const rawMask = new Uint8Array(W * H);
    let rawMaskCount = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (maxC < 35) continue; // trop sombre (seuil légèrement abaissé)
      const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const sat = (maxC - minC) / maxC;
      if (sat > 0.18) {  // seuil abaissé pour mieux capter les couleurs pâles
        rawMask[i] = 1;
        rawMaskCount++;
      }
    }

    if (rawMaskCount < W * H * 0.012) {
      if (debug) console.log('[calib] no colorful pixels', { rawMaskCount, pct: (rawMaskCount / (W * H) * 100).toFixed(1) + '%' });
      return null;
    }

    // 2) Fermeture morphologique : comble les trous entre cellules colorées
    //    (cellules blanches, bordures, reflets). Rayon = 3px sur 320px ≈ 1%.
    const mask = morphClose(rawMask, W, H, 3);

    // 3) Plus grande composante connexe (BFS itératif, 4-connectivité)
    const { comp: bestComp, size: bestSize } = largestComponent(mask, W, H);
    if (!bestComp || bestSize < W * H * 0.008) {
      if (debug) console.log('[calib] component too small', { bestSize, pct: (bestSize / (W * H) * 100).toFixed(1) + '%' });
      return null;
    }

    // 4) Coins par percentile (2% au lieu de l'extrême pur → robuste aux outliers).
    const { tlPt, trPt, blPt, brPt } = cornersByPercentile(bestComp, W, 0.02);

    // 5) Sanity checks
    const bb = compBbox(bestComp, W);
    if (bb.w < W * 0.12 || bb.h < H * 0.12) {
      if (debug) console.log('[calib] bbox too small', { bboxW: bb.w, bboxH: bb.h });
      return null;
    }
    const ar = bb.w / bb.h;
    if (ar < 0.25 || ar > 4.5) {
      if (debug) console.log('[calib] aspect ratio off', { ar: ar.toFixed(2) });
      return null;
    }

    // Taux de remplissage : la composante doit remplir au moins 35% de sa bbox
    const fillRatio = bestSize / (bb.w * bb.h);
    if (fillRatio < 0.35) {
      if (debug) console.log('[calib] fill ratio too low', { fillRatio: fillRatio.toFixed(2) });
      return null;
    }

    const rawCorners = [
      { x: tlPt.x / W, y: tlPt.y / H },
      { x: trPt.x / W, y: trPt.y / H },
      { x: blPt.x / W, y: blPt.y / H },
      { x: brPt.x / W, y: brPt.y / H }
    ];

    // Validation de convexité
    if (!isConvexQuad(rawCorners)) {
      if (debug) console.log('[calib] non-convex quad, rejected');
      return null;
    }

    if (debug) {
      console.log('[calib] ✓ detected (saturation)', {
        size: (bestSize / (W * H) * 100).toFixed(1) + '%',
        bbox: bb.w + 'x' + bb.h,
        ar: ar.toFixed(2),
        fill: (fillRatio * 100).toFixed(0) + '%'
      });
    }

    // 6) Lissage temporel EMA
    return smoothCorners(rawCorners);
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
    load, getPoints, reset, startCam, action, auto, startManualTap, stopCam, save, isCalibrated,
    recordPair, getLearnedOffset, resetOffsetLearning, initLabel,
    cssToVideoNorm, videoNormToCss,
    listProfiles, getActiveProfileName, saveProfile, loadProfile, deleteProfile,
    renderProfilesUI, promptAndSaveProfile,
    setReturnToOnce
  };
})();
