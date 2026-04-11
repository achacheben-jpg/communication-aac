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
  // Détection automatique continue
  let liveActive = false;
  let liveTimer = null;
  let liveLockedByUser = false; // true dès que l'utilisateur tap manuellement

  function load() {
    try {
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
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      const v = document.getElementById('video-calib');
      v.srcObject = stream;
      await v.play();
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
      if (window.App) App.goMain('camera');
      return;
    }
    // streaming / tapping : forcer une nouvelle tentative auto
    auto();
  }

  /** Arme uniquement l'écoute du tap manuel comme fallback.
   *  N'enclenche pas l'état 'tapping' : cela se fera au premier tap réel. */
  function armManual() {
    const canvas = document.getElementById('canvas-calib');
    if (!canvas) return;
    canvas.style.cursor = 'crosshair';
    canvas.ontouchend = canvas.onclick = handleTap;
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

    const rect = canvas.getBoundingClientRect();
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;

    points.push({ x: nx, y: ny });
    drawPoint(ctx, clientX - rect.left, clientY - rect.top, step + 1);

    document.getElementById('dot-' + step).className = 'step-dot done';
    step++;

    if (step < 4) {
      setCalibMsg(`✅ Coin ${step}/4 enregistré. Touchez <b>${CORNERS[step]}</b> à l'écran.`);
      const d = document.getElementById('dot-' + step);
      if (d) d.className = 'step-dot current';
    } else {
      state = 'done';
      setCalibMsg('✅ <b>4 coins enregistrés manuellement</b>. Touchez <b>Utiliser →</b>.');
      const btn = document.getElementById('calib-action-btn');
      if (btn) btn.textContent = 'Utiliser →';
      setActionEnabled(true);
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

  /** Lance la boucle de détection continue (~400 ms) */
  function startLive() {
    stopLive();
    liveActive = true;
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
      setCalibMsg('✅ <b>Tableau détecté !</b> Vérifiez la zone verte et touchez <b>Utiliser →</b>. Bougez la caméra pour re-détecter si besoin.');
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
    if (!liveActive) startLive();
    // Et on déclenche une frame tout de suite
    try { runLiveFrame(); } catch (e) { console.warn('[calib] auto manual trigger error', e); }
  }

  // Compteur pour debug (affiche dans la console toutes les N frames)
  let _detectCounter = 0;

  /** Détecte les 4 coins du tableau à partir d'une frame vidéo.
   *  Retourne un tableau [TL,TR,BL,BR] en coordonnées normalisées [0,1],
   *  ou null si la détection échoue. */
  function detectBoardCorners(video) {
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const W = 200;
    const H = Math.max(80, Math.round(W * vh / vw));

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
    //    Seuil à 0.22 (plus permissif) pour attraper des couleurs atténuées.
    const mask = new Uint8Array(W * H);
    let maskCount = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (maxC < 40) continue; // trop sombre
      const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const sat = (maxC - minC) / maxC;
      if (sat > 0.22) {
        mask[i] = 1;
        maskCount++;
      }
    }

    const debug = (++_detectCounter % 10 === 0);
    if (maskCount < W * H * 0.015) {
      if (debug) console.log('[calib] no colorful pixels', { maskCount, pct: (maskCount / (W * H) * 100).toFixed(1) + '%' });
      return null;
    }

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

    if (!bestComp || bestSize < W * H * 0.008) {
      if (debug) console.log('[calib] component too small', { bestSize, pct: (bestSize / (W * H) * 100).toFixed(1) + '%' });
      return null;
    }

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

    // 4) Sanity checks (plus permissifs)
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < W * 0.12 || bboxH < H * 0.12) {
      if (debug) console.log('[calib] bbox too small', { bboxW, bboxH });
      return null;
    }
    const ar = bboxW / bboxH;
    if (ar < 0.25 || ar > 4.5) {
      if (debug) console.log('[calib] aspect ratio off', { ar: ar.toFixed(2) });
      return null;
    }

    if (debug) {
      console.log('[calib] ✓ detected', {
        size: (bestSize / (W * H) * 100).toFixed(1) + '%',
        bbox: bboxW + 'x' + bboxH,
        ar: ar.toFixed(2)
      });
    }

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
    recordPair, getLearnedOffset, resetOffsetLearning, initLabel,
    listProfiles, getActiveProfileName, saveProfile, loadProfile, deleteProfile,
    renderProfilesUI, promptAndSaveProfile
  };
})();
