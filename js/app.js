// ═══════════════════════════════════════════
// APP — navigation, texte, voix, mode
// ═══════════════════════════════════════════
window.App = (function() {
  let txt = '';
  let currentMode = 'manual';
  let lastStatus = { color: '', text: 'Mode manuel' };

  function getText() { return txt; }
  function setText(v) { txt = v; render(); Prediction.scheduleSuggest(); }

  function render() {
    const outEl = document.getElementById('output-text');
    if (!outEl) return;
    if (txt) outEl.innerHTML = `<span>${escapeHtml(txt)}</span>`;
    else outEl.innerHTML = `<span class="output-placeholder">Composez...</span>`;
    outEl.onclick = null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
  }

  /** Sélection d'une case — depuis clic manuel ou dwell caméra */
  function sel(el, opts) {
    if (!el || !el.dataset || !el.dataset.val) return;
    flash(el);
    const val = el.dataset.val;
    txt += val;
    render();
    Prediction.scheduleSuggest();

    // Apprentissage offset : si sélection manuelle (pas via caméra) et caméra active,
    // enregistrer la paire (pied détecté ↔ case cliquée).
    if (!opts || !opts.fromCamera) {
      if (currentMode === 'camera' && Camera && Camera.getLastFootUVBoard) {
        const foot = Camera.getLastFootUVBoard();
        if (foot) {
          const cellCenter = Camera.cellCenterUV(el);
          if (cellCenter) Calibration.recordPair(foot, cellCenter);
        }
      }
    }
  }

  function add(v) { txt += v; render(); Prediction.scheduleSuggest(); }

  function back() {
    // Retire le dernier mot/segment (jusqu'au séparateur précédent)
    if (!txt) return;
    // Retire les espaces de fin puis la dernière séquence non-espace
    const trimmed = txt.replace(/\s+$/, '');
    const m = trimmed.match(/^(.*?)(\S+)$/);
    txt = m ? m[1] : '';
    render();
    Prediction.scheduleSuggest();
  }

  function clearAll() { txt = ''; render(); Prediction.scheduleSuggest(); }

  function speak() {
    if (!txt.trim()) return;
    const u = new SpeechSynthesisUtterance(txt.trim());
    u.lang = 'fr-FR';
    u.rate = parseFloat(document.getElementById('sl-speed').value);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    // Enregistrer dans historique
    Favorites.record(txt);
  }

  function flash(el) {
    el.classList.add('c-selected');
    setTimeout(() => el.classList.remove('c-selected'), 500);
  }

  function flashPredChip(el) {
    el.classList.add('c-selected');
    setTimeout(() => el.classList.remove('c-selected'), 400);
  }

  // ═══════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById('screen-' + id);
    if (el) el.classList.add('active');
  }

  function goCalib() {
    showScreen('calib');
    Calibration.reset();
    Calibration.startCam();
  }

  function goMain(mode) {
    showScreen('main');
    setMode(mode || 'manual');
  }

  // ═══════════════════════════════════════════
  // MODE (manuel / caméra / scan)
  // ═══════════════════════════════════════════
  function setMode(m) {
    // Cleanup de l'ancien mode
    if (currentMode === 'camera' && m !== 'camera') Camera.stop();
    if (currentMode === 'scan' && m !== 'scan') Scan.stop();

    currentMode = m;
    document.getElementById('btn-manual').classList.toggle('active', m === 'manual');
    document.getElementById('btn-camera').classList.toggle('active', m === 'camera');
    document.getElementById('btn-scan').classList.toggle('active', m === 'scan');

    if (m === 'camera') {
      Camera.start();
    } else if (m === 'scan') {
      Scan.start();
    } else {
      setStatus('', 'Mode manuel');
    }
  }

  // ═══════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════
  function setStatus(color, text) {
    lastStatus = { color, text };
    const dot = document.getElementById('main-dot');
    if (dot) dot.className = 'status-dot' + (color ? ' ' + color : '');
    const s = document.getElementById('main-status');
    if (s) s.textContent = text;
  }
  function refreshStatus() { setStatus(lastStatus.color, lastStatus.text); }

  // ═══════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════
  function toggleSettings() {
    document.getElementById('settings-panel').classList.toggle('open');
  }

  // ═══════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════
  function init() {
    Calibration.load();
    Calibration.initLabel();
    Prediction.init();
    render();
  }

  window.addEventListener('load', init);

  return {
    getText, setText, sel, add, back, clearAll, speak,
    showScreen, goCalib, goMain, setMode, toggleSettings,
    setStatus, refreshStatus, flashPredChip
  };
})();
