// ═══════════════════════════════════════════
// MODE SCAN AUTOMATIQUE + DÉTECTION AUDIO
// ═══════════════════════════════════════════
// Deux niveaux : (1) scan des lignes, (2) scan des cases dans la ligne active.
// Validation par son (Web Audio RMS > seuil) ou par tap écran.
window.Scan = (function() {
  let active = false;
  let level = 'row';   // 'row' | 'cell'
  let rowIdx = 0;
  let cellIdx = 0;
  let rowOrder = [];
  let currentRowCells = [];
  let timer = null;

  // Audio
  let audioCtx = null;
  let audioStream = null;
  let analyser = null;
  let audioBuf = null;
  let audioLoop = null;
  let lastPeakAt = 0;   // anti-rebond

  function start() {
    stop();
    rowOrder = Tableau.rowOrder();
    if (rowOrder.length === 0) return;
    active = true;
    level = 'row';
    rowIdx = 0;
    cellIdx = 0;
    tick();
    scheduleNext();
    // Démarrer détection audio (optionnel, tap écran fonctionne aussi)
    startAudio().catch(() => {
      if (window.App) App.setStatus('orange', 'Scan sans audio — tapez pour valider');
    });
    bindTap(true);
    if (window.App) App.setStatus('blue', 'Scan : lignes — son ou tap pour valider');
  }

  function stop() {
    active = false;
    if (timer) { clearTimeout(timer); timer = null; }
    clearHighlights();
    stopAudio();
    bindTap(false);
  }

  function scheduleNext() {
    if (!active) return;
    const rate = parseFloat(document.getElementById('sl-scan-rate')?.value || '1.4') * 1000;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!active) return;
      advance();
      tick();
      scheduleNext();
    }, rate);
  }

  function advance() {
    if (level === 'row') {
      rowIdx = (rowIdx + 1) % rowOrder.length;
    } else {
      cellIdx++;
      if (cellIdx >= currentRowCells.length) {
        // retour au scan de lignes
        level = 'row';
        cellIdx = 0;
        currentRowCells = [];
      }
    }
  }

  function tick() {
    clearHighlights();
    if (level === 'row') {
      const byRow = Tableau.byRow();
      const row = byRow[rowOrder[rowIdx]] || [];
      row.forEach(el => el.classList.add('c-scan-row'));
    } else {
      const cell = currentRowCells[cellIdx];
      if (cell) cell.classList.add('c-scan-cell');
    }
  }

  function clearHighlights() {
    document.querySelectorAll('.c-scan-row, .c-scan-cell').forEach(el => {
      el.classList.remove('c-scan-row', 'c-scan-cell');
    });
  }

  /** Appelé par un son fort ou un tap sur l'écran */
  function validate() {
    if (!active) return;
    if (level === 'row') {
      const byRow = Tableau.byRow();
      currentRowCells = (byRow[rowOrder[rowIdx]] || []).slice();
      if (currentRowCells.length === 0) return;
      level = 'cell';
      cellIdx = 0;
      tick();
      if (window.App) App.setStatus('blue', 'Scan : cases de la ligne');
    } else {
      const cell = currentRowCells[cellIdx];
      if (cell && window.App) App.sel(cell);
      // Retour scan lignes
      level = 'row';
      cellIdx = 0;
      currentRowCells = [];
      tick();
      if (window.App) App.setStatus('blue', 'Scan : lignes');
    }
    // Réarmer le timer
    if (timer) clearTimeout(timer);
    scheduleNext();
  }

  // ═══ TAP ÉCRAN ═══
  function onTap(e) {
    const t = e.target;
    // Laisser la toolbar, les boutons d'output, les réglages fonctionner
    if (t && (t.tagName === 'BUTTON' || t.closest('button'))) return;
    if (t && t.closest && t.closest('#settings-panel')) return;
    if (t && t.closest && t.closest('#output-text')) return;
    // Un tap sur une case du tableau en mode scan doit servir à valider et NE PAS
    // déclencher l'onclick de la case. Capture phase + stopPropagation.
    if (t && t.closest && t.closest('#tableau')) {
      e.preventDefault();
      e.stopPropagation();
    }
    validate();
  }

  function bindTap(on) {
    const main = document.getElementById('screen-main');
    if (!main) return;
    if (on) {
      main.addEventListener('click', onTap, true); // capture phase
    } else {
      main.removeEventListener('click', onTap, true);
    }
  }

  // ═══ AUDIO ═══
  async function startAudio() {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(audioStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioBuf = new Uint8Array(analyser.fftSize);
      audioTick();
    } catch (e) {
      throw e;
    }
  }

  function stopAudio() {
    if (audioLoop) { cancelAnimationFrame(audioLoop); audioLoop = null; }
    if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyser = null;
    audioBuf = null;
  }

  function audioTick() {
    if (!analyser || !audioBuf) return;
    analyser.getByteTimeDomainData(audioBuf);
    // RMS normalisé [0,1]
    let sum = 0;
    for (let i = 0; i < audioBuf.length; i++) {
      const s = (audioBuf[i] - 128) / 128;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / audioBuf.length);
    const threshold = parseFloat(document.getElementById('sl-audio-th')?.value || '0.2');
    const now = Date.now();
    if (rms > threshold && now - lastPeakAt > 500) {
      lastPeakAt = now;
      validate();
    }
    audioLoop = requestAnimationFrame(audioTick);
  }

  return { start, stop, validate };
})();
