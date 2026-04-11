// ═══════════════════════════════════════════
// APP — navigation, texte, voix, mode
// ═══════════════════════════════════════════
window.App = (function() {
  let txt = '';
  let currentMode = 'manual';
  let lastStatus = { color: '', text: 'Mode manuel' };

  // Auto-speak settings (persistés en localStorage)
  const SPEAK_SELECT_KEY = 'aac_speak_on_select';
  const SPEAK_WORD_KEY = 'aac_speak_on_word';
  const SPEAK_SENTENCE_KEY = 'aac_speak_on_sentence';

  function getSetting(key, defaultVal) {
    const v = localStorage.getItem(key);
    if (v === null) return defaultVal;
    return v === '1';
  }
  function setSetting(key, val) {
    localStorage.setItem(key, val ? '1' : '0');
  }
  function getSpeakOnSelect() { return getSetting(SPEAK_SELECT_KEY, true); }
  function getSpeakOnWord() { return getSetting(SPEAK_WORD_KEY, false); }
  function getSpeakOnSentence() { return getSetting(SPEAK_SENTENCE_KEY, false); }

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
    const prevTxt = txt;
    txt += val;
    render();
    Prediction.scheduleSuggest();

    // ═══ Auto-speak : feedback vocal immédiat ═══
    // 1) Lire la case sélectionnée (chaque lettre / syllabe / mot)
    if (getSpeakOnSelect()) {
      speakSnippet(val.trim() || val);
    }
    // 2) Lire le dernier mot complet (si la sélection se termine par un espace)
    if (getSpeakOnWord() && /\s$/.test(val)) {
      const words = prevTxt.trim().split(/\s+/).concat(val.trim());
      const lastWord = words[words.length - 1];
      if (lastWord && lastWord.length > 1) speakSnippet(lastWord);
    }
    // 3) Lire la phrase entière sur ponctuation finale
    if (getSpeakOnSentence() && /[.!?]\s*$/.test(txt)) {
      speakSnippet(txt.trim());
    }

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

  /** Prononce un snippet court (lettre, syllabe, mot, phrase) immédiatement.
   *  Ne touche pas à la file principale de lecture : ce sont des feedbacks
   *  courts qui remplacent l'éventuelle lecture précédente. */
  function speakSnippet(text) {
    if (!text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      const slider = document.getElementById('sl-speed');
      u.rate = slider ? parseFloat(slider.value) : 0.9;
      u.volume = 1;
      speechSynthesis.speak(u);
    } catch (e) { console.warn('[speak] snippet failed', e); }
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
    // Initialiser les toggles de voix depuis localStorage
    const c1 = document.getElementById('chk-speak-sel');
    if (c1) c1.checked = getSpeakOnSelect();
    const c2 = document.getElementById('chk-speak-word');
    if (c2) c2.checked = getSpeakOnWord();
    const c3 = document.getElementById('chk-speak-sent');
    if (c3) c3.checked = getSpeakOnSentence();
    // Initialiser le select de source caméra
    const sc = document.getElementById('sl-cam-source');
    if (sc && window.Camera && Camera.getSource) sc.value = Camera.getSource();
    // Afficher la liste des profils de calibration
    if (Calibration.renderProfilesUI) Calibration.renderProfilesUI();
    render();
  }

  window.addEventListener('load', init);

  return {
    getText, setText, sel, add, back, clearAll, speak,
    showScreen, goCalib, goMain, setMode, toggleSettings,
    setStatus, refreshStatus, flashPredChip,
    getSpeakOnSelect, getSpeakOnWord, getSpeakOnSentence,
    setSpeakOnSelect: (v) => setSetting(SPEAK_SELECT_KEY, v),
    setSpeakOnWord: (v) => setSetting(SPEAK_WORD_KEY, v),
    setSpeakOnSentence: (v) => setSetting(SPEAK_SENTENCE_KEY, v),
    speakSnippet
  };
})();
