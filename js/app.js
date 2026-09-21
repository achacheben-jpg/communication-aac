// ═══════════════════════════════════════════════════════════════
// APP — écran, calibration, sélection par maintien (dwell), phrase, voix
// ═══════════════════════════════════════════════════════════════
window.App = (function () {

  const $ = id => document.getElementById(id);

  // ── Réglages (sauvegardés sur le téléphone) ──
  const DEFAULTS = {
    dwell: 1.2,          // secondes de maintien pour valider une case
    threshold: 40,       // sensibilité (différence de couleur)
    entry: 'bottom',     // côté par lequel le pied arrive sur le tableau
    offset: 0,           // décalage de la pointe
    adapt: true,         // référence qui suit la lumière
    darkSock: true,      // le pied porte une chaussette sombre
    darkLevel: 80,       // niveau de luminosité max de la chaussette
    showMask: true,      // afficher la zone détectée
    announce: true,      // dire chaque case à voix haute
    autoIA: true,        // reconstitution automatique
    nonErases: true      // "non" efface la dernière case
  };
  let S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(localStorage.getItem('aac_settings') || '{}')); } catch (e) { }
  function saveSettings() { try { localStorage.setItem('aac_settings', JSON.stringify(S)); } catch (e) { } }

  // ── État ──
  const video = $('video');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  let stream = null;
  let usingFile = false;
  let calibrating = false;
  let corners = null;          // [{x,y}] normalisés 0..1 (HG, HD, BD, BG)
  let mapFn = null;            // (u,v) tableau → (x,y) vidéo
  const seq = [];              // cases sélectionnées
  let phrase = '';
  let lastSelectionAt = 0;
  let iaTimer = null;
  let running = false;

  // Sélection par maintien
  const hist = [];             // dernières cases candidates
  let hoverCell = null, hoverSince = 0, armed = true, absentSince = 0;

  try { corners = JSON.parse(localStorage.getItem('aac_corners') || 'null'); } catch (e) { }

  // ═════════ Caméra ═════════
  async function startCamera() {
    stopVideoSource();
    usingFile = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      setStatus('Caméra active');
    } catch (e) {
      setStatus('Caméra refusée : ' + e.message, true);
    }
  }

  function stopVideoSource() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (usingFile && video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); }
    video.srcObject = null;
  }

  function useVideoFile(file) {
    stopVideoSource();
    usingFile = true;
    video.src = URL.createObjectURL(file);
    video.loop = true;
    video.play().catch(() => { });
    setStatus('Vidéo de test : ' + file.name);
    closeSettings();
  }

  video.addEventListener('loadedmetadata', () => {
    const box = $('cambox');
    box.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    requestAnimationFrame(resizeOverlay);
  });

  function resizeOverlay() {
    const box = $('cambox');
    overlay.width = box.clientWidth * (window.devicePixelRatio || 1);
    overlay.height = box.clientHeight * (window.devicePixelRatio || 1);
    overlay.style.width = box.clientWidth + 'px';
    overlay.style.height = box.clientHeight + 'px';
    placeHandles();
  }
  window.addEventListener('resize', resizeOverlay);

  // ═════════ Calibration ═════════
  function startCalibration() {
    calibrating = true;
    running = false;
    if (!corners) corners = [{ x: 0.15, y: 0.15 }, { x: 0.85, y: 0.15 }, { x: 0.85, y: 0.85 }, { x: 0.15, y: 0.85 }];
    $('calibbar').classList.remove('hidden');
    $('handles').classList.remove('hidden');
    placeHandles();
    unlockAudio();
    setStatus('Placez les 4 points sur les coins du tableau (le pied hors du tableau)');
  }

  function placeHandles() {
    if (!corners) return;
    const box = $('cambox');
    document.querySelectorAll('.handle').forEach((h, i) => {
      h.style.left = (corners[i].x * box.clientWidth) + 'px';
      h.style.top = (corners[i].y * box.clientHeight) + 'px';
    });
    if (calibrating) drawOverlay(null);
  }

  function initHandles() {
    const box = $('cambox');
    document.querySelectorAll('.handle').forEach((h, i) => {
      let dragging = false;
      h.addEventListener('pointerdown', e => { dragging = true; h.setPointerCapture(e.pointerId); e.preventDefault(); });
      h.addEventListener('pointermove', e => {
        if (!dragging) return;
        const r = box.getBoundingClientRect();
        corners[i] = {
          x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
          y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
        };
        placeHandles();
      });
      h.addEventListener('pointerup', () => { dragging = false; });
      h.addEventListener('pointercancel', () => { dragging = false; });
    });
  }

  function validateCalibration() {
    Vision.setCorners(corners);
    mapFn = Vision.squareToQuad(corners);
    try { localStorage.setItem('aac_corners', JSON.stringify(corners)); } catch (e) { }
    calibrating = false;
    $('calibbar').classList.add('hidden');
    $('handles').classList.add('hidden');
    captureReference();
    running = true;
  }

  function cancelCalibration() {
    calibrating = false;
    $('calibbar').classList.add('hidden');
    $('handles').classList.add('hidden');
    try { corners = JSON.parse(localStorage.getItem('aac_corners') || 'null'); } catch (e) { }
    if (corners) { Vision.setCorners(corners); mapFn = Vision.squareToQuad(corners); }
    running = !!mapFn;
  }

  function captureReference() {
    if (!mapFn) { setStatus('Calibrez d’abord le tableau', true); return; }
    if (video.readyState < 2) { setStatus('Vidéo pas encore prête', true); return; }
    Vision.captureReference(video);
    setStatus('Référence prise : le tableau vide est mémorisé');
    resetHover();
  }

  // ═════════ Boucle d’analyse ═════════
  let lastT = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    if (t - lastT < 60) return;       // ~16 images / seconde
    lastT = t;
    if (calibrating) { drawOverlay(null); return; }
    if (!running || !mapFn || !Vision.hasReference() || video.readyState < 2 || video.paused) return;
    const r = Vision.analyze(video, { threshold: S.threshold, entry: S.entry, offset: S.offset, adapt: S.adapt, darkSock: S.darkSock, darkLevel: S.darkLevel });
    let cell = null;
    if (r.present) cell = Board.cellAt(r.u, r.v);
    updateDwell(cell, r.present, t);
    drawOverlay(r);
  }

  function resetHover() { hist.length = 0; hoverCell = null; hoverSince = 0; armed = true; }

  function updateDwell(cell, present, t) {
    // Lissage : case majoritaire sur les 6 dernières images
    hist.push(cell ? cell.id : -1);
    if (hist.length > 6) hist.shift();
    const counts = {};
    let bestId = -1, bestN = 0;
    for (const id of hist) { counts[id] = (counts[id] || 0) + 1; if (counts[id] > bestN) { bestN = counts[id]; bestId = id; } }
    const stable = bestId >= 0 ? Board.cells[bestId] : null;

    if (!present) {
      if (!absentSince) absentSince = t;
      if (t - absentSince > 400) { armed = true; hoverCell = null; hoverSince = 0; }
    } else absentSince = 0;

    if (stable !== hoverCell) {
      hoverCell = stable;
      hoverSince = t;
      armed = true;
    }
    let progress = 0;
    if (hoverCell && armed) {
      progress = Math.min(1, (t - hoverSince) / (S.dwell * 1000));
      if (progress >= 1) { select(hoverCell); armed = false; }
    }
    showHover(hoverCell, armed ? progress : 1);
  }

  // ═════════ Sélection, phrase, voix ═════════
  function select(cell) {
    if (cell.kind === 'non' && S.nonErases && seq.length) {
      seq.pop();
      beep(300);
      if (S.announce) speak('effacé');
    } else {
      seq.push(cell);
      beep(880);
      if (S.announce) speak(cell.value);
    }
    lastSelectionAt = Date.now();
    phrase = '';
    renderSeq();
    flashMini(cell);
    scheduleIA();
  }

  function addManual(cell) { unlockAudio(); select(cell); }

  function eraseLast() { seq.pop(); phrase = ''; renderSeq(); scheduleIA(); }
  function eraseAll() { seq.length = 0; phrase = ''; $('alts').innerHTML = ''; renderSeq(); }

  function renderSeq() {
    const el = $('seq');
    el.innerHTML = '';
    seq.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'chip ' + c.kind;
      chip.textContent = c.label;
      el.appendChild(chip);
    });
    el.scrollLeft = el.scrollWidth;
    $('phrase').textContent = phrase || IA.naive(seq) || '…';
    $('phrase').classList.toggle('raw', !phrase);
  }

  function scheduleIA() {
    clearTimeout(iaTimer);
    if (!S.autoIA || !IA.getKey() || !seq.length) return;
    iaTimer = setTimeout(() => runIA(), 2500);
  }

  async function runIA() {
    if (!seq.length) return;
    const btn = $('btn-ia');
    btn.disabled = true; btn.textContent = '… IA en cours';
    try {
      const r = await IA.reconstruct(seq.slice());
      phrase = r.phrase;
      $('phrase').textContent = phrase;
      $('phrase').classList.remove('raw');
      const alts = $('alts');
      alts.innerHTML = '';
      r.alternatives.forEach(a => {
        const b = document.createElement('button');
        b.className = 'alt'; b.textContent = a;
        b.onclick = () => { phrase = a; $('phrase').textContent = a; };
        alts.appendChild(b);
      });
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = '✨ Reconstituer';
    }
  }

  function readAloud() {
    unlockAudio();
    const txt = phrase || IA.naive(seq);
    if (txt) speak(txt);
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; u.rate = 0.95;
    const v = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('fr'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  let actx = null;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      if ('speechSynthesis' in window) speechSynthesis.getVoices();
    } catch (e) { }
  }
  function beep(freq) {
    if (!actx) return;
    try {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.2, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.15);
      o.start(); o.stop(actx.currentTime + 0.15);
    } catch (e) { }
  }

  // ═════════ Affichage ═════════
  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
  }

  function showHover(cell, progress) {
    const el = $('hover');
    const bar = $('hoverbar');
    if (!cell) { el.textContent = 'Pied hors du tableau'; bar.style.width = '0%'; }
    else { el.textContent = cell.label; bar.style.width = Math.round(progress * 100) + '%'; }
    document.querySelectorAll('#mini .mc').forEach(m => m.classList.toggle('hov', !!cell && +m.dataset.id === cell.id));
  }

  function drawOverlay(r) {
    const w = overlay.width, h = overlay.height;
    octx.clearRect(0, 0, w, h);
    const c = corners;
    if (!c) return;
    const map = calibrating ? Vision.squareToQuad(c) : mapFn;
    if (!map) return;
    const P = (u, v) => { const q = map(u, v); return [q.x * w, q.y * h]; };

    // Zone détectée
    if (r && r.mask && S.showMask) {
      octx.fillStyle = 'rgba(255,80,0,0.45)';
      const W = Vision.W, H = Vision.H;
      for (let j = 0; j < H; j += 2) for (let i = 0; i < W; i += 2) {
        if (!r.mask[j * W + i]) continue;
        const [x, y] = P((i + 1) / W, (j + 1) / H);
        octx.fillRect(x - 2, y - 2, 4, 4);
      }
    }
    // Grille des cases
    octx.lineWidth = 1; octx.strokeStyle = 'rgba(255,255,255,0.55)';
    for (const cell of Board.cells) {
      octx.beginPath();
      octx.moveTo(...P(cell.x0, cell.y0)); octx.lineTo(...P(cell.x1, cell.y0));
      octx.lineTo(...P(cell.x1, cell.y1)); octx.lineTo(...P(cell.x0, cell.y1)); octx.closePath();
      if (hoverCell && cell.id === hoverCell.id && !calibrating) { octx.fillStyle = 'rgba(46,204,113,0.45)'; octx.fill(); }
      octx.stroke();
    }
    // Contour du tableau
    octx.lineWidth = 3; octx.strokeStyle = calibrating ? '#f1c40f' : '#2ecc71';
    octx.beginPath();
    octx.moveTo(...P(0, 0)); octx.lineTo(...P(1, 0)); octx.lineTo(...P(1, 1)); octx.lineTo(...P(0, 1)); octx.closePath();
    octx.stroke();
    // Pointe
    if (r && r.present) {
      const [x, y] = P(r.u, r.v);
      octx.fillStyle = '#e74c3c'; octx.strokeStyle = '#fff'; octx.lineWidth = 2;
      octx.beginPath(); octx.arc(x, y, 8 * (window.devicePixelRatio || 1), 0, Math.PI * 2); octx.fill(); octx.stroke();
    }
  }

  // Mini tableau (tap = ajouter à la main)
  function buildMini() {
    const mini = $('mini');
    Board.cells.forEach(c => {
      const d = document.createElement('div');
      d.className = 'mc ' + c.kind;
      d.dataset.id = c.id;
      d.textContent = c.label;
      d.style.left = (c.x0 * 100) + '%'; d.style.top = (c.y0 * 100) + '%';
      d.style.width = ((c.x1 - c.x0) * 100) + '%'; d.style.height = ((c.y1 - c.y0) * 100) + '%';
      d.addEventListener('click', () => addManual(c));
      mini.appendChild(d);
    });
  }
  function flashMini(cell) {
    const m = document.querySelector(`#mini .mc[data-id="${cell.id}"]`);
    if (!m) return;
    m.classList.add('sel'); setTimeout(() => m.classList.remove('sel'), 500);
  }

  // ═════════ Réglages ═════════
  function openSettings() {
    $('s-dwell').value = S.dwell; $('s-dwell-v').textContent = S.dwell + ' s';
    $('s-thr').value = S.threshold; $('s-thr-v').textContent = S.threshold;
    $('s-off').value = S.offset; $('s-off-v').textContent = S.offset;
    $('s-entry').value = S.entry;
    $('s-adapt').checked = S.adapt; $('s-mask').checked = S.showMask;
    $('s-dark').checked = S.darkSock; $('s-darklvl').value = S.darkLevel; $('s-darklvl-v').textContent = S.darkLevel;
    $('s-announce').checked = S.announce; $('s-auto').checked = S.autoIA; $('s-non').checked = S.nonErases;
    $('s-key').value = IA.getKey();
    $('settings').classList.remove('hidden');
  }
  function closeSettings() { $('settings').classList.add('hidden'); }
  function bindSettings() {
    $('s-dwell').oninput = e => { S.dwell = +e.target.value; $('s-dwell-v').textContent = S.dwell + ' s'; saveSettings(); };
    $('s-thr').oninput = e => { S.threshold = +e.target.value; $('s-thr-v').textContent = S.threshold; saveSettings(); };
    $('s-off').oninput = e => { S.offset = +e.target.value; $('s-off-v').textContent = S.offset; saveSettings(); };
    $('s-entry').onchange = e => { S.entry = e.target.value; saveSettings(); };
    $('s-adapt').onchange = e => { S.adapt = e.target.checked; saveSettings(); };
    $('s-dark').onchange = e => { S.darkSock = e.target.checked; saveSettings(); };
    $('s-darklvl').oninput = e => { S.darkLevel = +e.target.value; $('s-darklvl-v').textContent = S.darkLevel; saveSettings(); };
    $('s-mask').onchange = e => { S.showMask = e.target.checked; saveSettings(); };
    $('s-announce').onchange = e => { S.announce = e.target.checked; saveSettings(); };
    $('s-auto').onchange = e => { S.autoIA = e.target.checked; saveSettings(); };
    $('s-non').onchange = e => { S.nonErases = e.target.checked; saveSettings(); };
    $('s-key').onchange = e => IA.setKey(e.target.value.trim());
    $('s-file').onchange = e => { if (e.target.files[0]) useVideoFile(e.target.files[0]); };
    $('s-camera').onclick = () => { startCamera(); closeSettings(); };
    $('s-reset').onclick = () => {
      if (!confirm('Effacer la calibration du tableau ?')) return;
      try { localStorage.removeItem('aac_corners'); } catch (e) { }
      corners = null; mapFn = null; running = false; closeSettings(); startCalibration();
    };
  }

  // ═════════ Démarrage ═════════
  async function init() {
    buildMini();
    initHandles();
    bindSettings();
    $('btn-calib').onclick = startCalibration;
    $('btn-ref').onclick = () => { unlockAudio(); captureReference(); };
    $('btn-ok').onclick = validateCalibration;
    $('btn-cancel').onclick = cancelCalibration;
    $('btn-settings').onclick = openSettings;
    $('btn-close').onclick = closeSettings;
    $('btn-ia').onclick = () => { unlockAudio(); runIA(); };
    $('btn-read').onclick = readAloud;
    $('btn-erase').onclick = eraseLast;
    $('btn-clear').onclick = () => { if (!seq.length || confirm('Tout effacer ?')) eraseAll(); };
    $('btn-mini').onclick = () => $('miniwrap').classList.toggle('collapsed');
    renderSeq();

    if (corners) { Vision.setCorners(corners); mapFn = Vision.squareToQuad(corners); }
    await startCamera();
    if (mapFn) {
      setStatus('Tableau calibré. Appuyez sur « Référence » quand le pied est hors du tableau.');
      running = true;
    } else {
      setStatus('Appuyez sur « Calibrer » pour indiquer les coins du tableau.');
    }
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { }
    requestAnimationFrame(loop);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { select, addManual };
})();
