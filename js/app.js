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
    if (id === 'training') refreshTrainingScreen();
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
  // ANALYSE D'UNE VIDÉO PRÉ-ENREGISTRÉE
  // ═══════════════════════════════════════════
  function pickVideoFile() {
    const inp = document.getElementById('video-file-input');
    if (inp) inp.click();
  }

  function onVideoFileSelected(e) {
    const file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    if (!window.VideoSource) return;
    VideoSource.set(file);
    clearAll();
    setStatus('blue', `Vidéo "${VideoSource.name()}" chargée — calibration…`);
    // Aller à la calibration en utilisant la vidéo comme source
    goCalib();
    // Reset l'input pour pouvoir re-sélectionner le même fichier plus tard
    e.target.value = '';
  }

  /** Relance la vidéo depuis le début (sans recharger) */
  function replayVideo() {
    if (!window.VideoSource || !VideoSource.has()) return;
    if (VideoSource.resetTranscript) VideoSource.resetTranscript();
    clearAll();
    goMain('camera');
  }

  /** Appelée par Camera quand la vidéo chargée se termine */
  function showTranscriptResult() {
    const metaEl = document.getElementById('transcript-meta');
    const textEl = document.getElementById('transcript-text');
    if (metaEl) {
      const name = (window.VideoSource && VideoSource.has()) ? VideoSource.name() : '';
      metaEl.textContent = name ? `Source : ${name}` : '';
    }
    if (textEl) {
      const t = txt.trim();
      textEl.textContent = t || '(aucun texte détecté — vérifie la calibration et le seuil de dwell)';
    }
    showScreen('transcript');
    // Stopper le mode caméra (la vidéo est déjà finie)
    if (currentMode === 'camera') {
      currentMode = 'manual';
      if (window.Camera) Camera.stop();
    }
  }

  function closeTranscript() {
    // Retour à l'accueil et clear de la vidéo
    if (window.VideoSource) VideoSource.clear();
    showScreen('home');
  }

  function copyTranscript() {
    const text = (txt || '').trim();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => setStatus('blue', '✓ Copié dans le presse-papier'))
        .catch(() => setStatus('orange', 'Copie échouée'));
    }
  }

  function speakTranscript() {
    speak();
  }

  // ═══════════════════════════════════════════
  // APPRENTISSAGE SUPERVISÉ (Training)
  // ═══════════════════════════════════════════
  let lastTrainingResult = null;

  function pickTrainingFile() {
    const inp = document.getElementById('training-file-input');
    if (inp) inp.click();
  }

  function onTrainingFileSelected(e) {
    const file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    if (!window.VideoSource) return;
    VideoSource.set(file);
    const status = document.getElementById('training-file-status');
    if (status) status.textContent = `✓ ${file.name}`;
    e.target.value = '';
  }

  function refreshTrainingScreen() {
    const calibStatus = document.getElementById('training-calib-status');
    if (calibStatus) {
      if (Calibration.isCalibrated()) {
        calibStatus.innerHTML = '<span style="color:var(--green)">✓ Tableau calibré</span>';
      } else {
        calibStatus.innerHTML = '<span style="color:var(--orange)">⚠ Calibre d\'abord les 4 coins via 📷 Démarrer avec caméra</span>';
      }
    }
    const fileStatus = document.getElementById('training-file-status');
    if (fileStatus) {
      if (window.VideoSource && VideoSource.has()) {
        fileStatus.textContent = `✓ ${VideoSource.name()}`;
      } else {
        fileStatus.textContent = 'Aucune vidéo chargée';
      }
    }
    // Masquer les anciens résultats
    const res = document.getElementById('training-results');
    if (res) res.style.display = 'none';
    const prog = document.getElementById('training-progress-wrap');
    if (prog) prog.style.display = 'none';
  }

  async function startTraining() {
    if (!Calibration.isCalibrated()) {
      alert('Calibre d\'abord le tableau (4 coins) via 📷 Démarrer avec caméra.');
      return;
    }
    if (!window.VideoSource || !VideoSource.has()) {
      alert('Charge d\'abord une vidéo test.');
      return;
    }
    const targetEl = document.getElementById('training-target');
    const target = (targetEl && targetEl.value || '').trim();
    if (!target) {
      alert('Tape le texte attendu (ce que la personne a écrit dans la vidéo).');
      return;
    }
    if (!window.Training) {
      alert('Module Training non chargé.');
      return;
    }

    const progWrap = document.getElementById('training-progress-wrap');
    const progFill = document.getElementById('training-progress-fill');
    const statusText = document.getElementById('training-status-text');
    const resultsWrap = document.getElementById('training-results');
    const startBtn = document.getElementById('training-start-btn');

    if (progWrap) progWrap.style.display = '';
    if (resultsWrap) resultsWrap.style.display = 'none';
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = '⏳ En cours…'; }

    try {
      // Phase 1 : enregistrer la trace en jouant la vidéo
      if (statusText) statusText.textContent = 'Phase 1/2 — capture de la trace (lecture vidéo)…';
      if (progFill) progFill.style.width = '0%';

      showScreen('main'); // la vidéo doit être dans #video-live (mode caméra)
      const trace = await Training.collectTrace((pct) => {
        if (progFill) progFill.style.width = (pct * 50) + '%';
      });
      Camera.stop();
      showScreen('training');

      if (!trace || trace.length === 0) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--red)">❌ Aucune détection du pied pendant la vidéo. Vérifie la calibration et le mode source caméra dans ⚙.</span>';
        if (startBtn) { startBtn.disabled = false; startBtn.textContent = '🧠 Relancer'; }
        return;
      }

      if (statusText) statusText.textContent = `Phase 2/2 — grid search (${trace.length} points capturés)…`;

      // Phase 2 : grid search
      const best = await Training.gridSearch(trace, target, (pct) => {
        if (progFill) progFill.style.width = (50 + pct * 50) + '%';
      });

      if (best.err) {
        if (statusText) statusText.innerHTML = `<span style="color:var(--red)">❌ ${best.err}</span>`;
        if (startBtn) { startBtn.disabled = false; startBtn.textContent = '🧠 Relancer'; }
        return;
      }

      lastTrainingResult = best;

      // Afficher résultats
      if (progFill) progFill.style.width = '100%';
      if (statusText) statusText.textContent = '✓ Apprentissage terminé';

      const accuracy = Math.max(0, Math.round((1 - best.dist) * 100));
      const accEl = document.getElementById('training-accuracy');
      if (accEl) accEl.textContent = accuracy + '% de précision';
      const gotEl = document.getElementById('training-got');
      if (gotEl) gotEl.textContent = best.transcript || '(vide)';
      const wantEl = document.getElementById('training-want');
      if (wantEl) wantEl.textContent = target;
      const paramsEl = document.getElementById('training-params');
      if (paramsEl) {
        paramsEl.textContent =
          `offset vertical: ${best.offsetRows.toFixed(2)} lignes
offset horizontal: ${best.offsetU.toFixed(3)}
dwell: ${best.dwellMs} ms
points capturés: ${trace.length}`;
      }

      if (resultsWrap) resultsWrap.style.display = '';
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '🧠 Relancer'; }

    } catch (e) {
      console.error('[training] error', e);
      if (statusText) statusText.innerHTML = `<span style="color:var(--red)">❌ Erreur : ${e.message}</span>`;
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '🧠 Relancer'; }
    }
  }

  function applyTraining() {
    if (!lastTrainingResult || !window.Training) return;
    Training.apply(lastTrainingResult);
    setStatus('blue', '✓ Paramètres d\'apprentissage appliqués');
    setTimeout(() => showScreen('home'), 400);
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
    // Charger les paramètres d'apprentissage sauvegardés (s'il y en a)
    if (window.Training && Training.loadSavedOnStartup) Training.loadSavedOnStartup();
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
    speakSnippet,
    pickVideoFile, onVideoFileSelected, replayVideo,
    showTranscriptResult, closeTranscript, copyTranscript, speakTranscript,
    pickTrainingFile, onTrainingFileSelected, startTraining, applyTraining
  };
})();
