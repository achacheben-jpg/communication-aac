// ═══════════════════════════════════════════════════════════════
// CONVERSATION — le téléphone écoute ce qu'on lui dit, l'IA propose
// 4 réponses, et il en choisit une en posant le pied dans un des
// 4 grands coins du tableau (haut-gauche, haut-droit, bas-gauche,
// bas-droit). La réponse choisie est dite à voix haute.
// ═══════════════════════════════════════════════════════════════
window.Conv = (function () {

  const $ = id => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ARROWS = ['↖', '↗', '↙', '↘'];
  const NAMES = ['haut gauche', 'haut droit', 'bas gauche', 'bas droit'];

  const history = [];          // [{ who: 'autre' | 'lui', text }]
  let proposals = null;        // 4 réponses proposées (ou null)
  let rejected = [];           // réponses déjà proposées pour la même question
  let rec = null;              // reconnaissance vocale en cours
  let reqId = 0;               // pour ignorer une réponse IA arrivée trop tard
  let hooks = { speak() { }, setStatus() { }, unlockAudio() { }, beep() { } };

  /** Les 4 zones, dans l'ordre : 0 HG, 1 HD, 2 BG, 3 BD. */
  const QUADS = [0, 1, 2, 3].map(q => ({ id: 'q' + q, q }));

  function isActive() { return !!proposals; }

  /** Zone du tableau sous la pointe du pied (u, v entre 0 et 1). */
  function quadAt(u, v) { return QUADS[(v < 0.5 ? 0 : 2) + (u < 0.5 ? 0 : 1)]; }

  function labelOf(quad) { return proposals ? ARROWS[quad.q] + ' ' + proposals[quad.q] : ''; }

  // ── Écoute ──
  function listen() {
    hooks.unlockAudio();
    if (rec) { rec.stop(); return; }
    if (!SR) {
      hooks.setStatus('Écoute automatique indisponible ici : tapez la phrase, ou utilisez le micro du clavier.', true);
      $('conv-input').focus();
      return;
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    let latest = '';
    rec = new SR();
    rec.lang = 'fr-FR';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = e => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      latest = txt.trim();
      showHeard(latest, true);
    };
    rec.onerror = e => {
      if (e.error === 'no-speech') hooks.setStatus('Rien entendu. Réessayez.', true);
      else if (e.error === 'not-allowed') hooks.setStatus('Micro refusé : autorisez le micro dans les réglages de l’iPhone, ou tapez la phrase.', true);
      else if (e.error !== 'aborted') hooks.setStatus('Écoute : ' + e.error, true);
    };
    rec.onend = () => {
      rec = null;
      $('btn-listen').textContent = '🎤 Écouter';
      $('btn-listen').classList.remove('listening');
      if (latest) heard(latest);
    };
    try { rec.start(); } catch (e) { rec = null; hooks.setStatus('Écoute impossible : ' + e.message, true); return; }
    $('btn-listen').textContent = '⏹ J’écoute… (toucher pour arrêter)';
    $('btn-listen').classList.add('listening');
    hooks.setStatus('Parlez-lui normalement.');
  }

  /** Une phrase lui a été dite : on la note et on demande 4 réponses. */
  function heard(text) {
    text = (text || '').trim();
    if (!text) return;
    history.push({ who: 'autre', text });
    rejected = [];
    showHeard('', false);
    renderHistory();
    ask();
  }

  async function ask() {
    const id = ++reqId;
    hide(false);
    $('props-wait').classList.remove('hidden');
    try {
      const list = await IA.suggest(history, rejected);
      if (id !== reqId) return;
      proposals = list;
      rejected = rejected.concat(list);
      render();
      hooks.beep(660);
      hooks.setStatus('4 réponses proposées : il pose le pied dans le coin de son choix.');
    } catch (e) {
      if (id !== reqId) return;
      hooks.setStatus(e.message, true);
    } finally {
      if (id === reqId) $('props-wait').classList.add('hidden');
    }
  }

  /** Il a choisi la réponse de la zone q. */
  function choose(q) {
    if (!proposals) return;
    const text = proposals[q];
    hooks.beep(880);
    hooks.speak(text);
    history.push({ who: 'lui', text });
    renderHistory();
    hide(true);
    hooks.setStatus(`Réponse choisie (${NAMES[q]}) : « ${text} »`);
  }

  /** Il a écrit une phrase avec les cases et l'a fait lire : on la garde dans la conversation. */
  function addMine(text) {
    text = (text || '').trim();
    if (!text) return;
    const last = history[history.length - 1];
    if (last && last.who === 'lui' && last.text === text) return;
    history.push({ who: 'lui', text });
    renderHistory();
  }

  function hide(clearWait) {
    proposals = null;
    $('props').classList.add('hidden');
    $('props-actions').classList.add('hidden');
    if (clearWait) { reqId++; $('props-wait').classList.add('hidden'); }
  }

  function forget() {
    history.length = 0; rejected = [];
    hide(true);
    showHeard('', false);
    renderHistory();
  }

  // ── Affichage ──
  function showHeard(text, live) {
    const el = $('heard');
    el.textContent = text || 'Appuyez sur 🎤 quand on lui parle.';
    el.classList.toggle('raw', !text || live);
  }

  function renderHistory() {
    const el = $('conv-hist');
    el.innerHTML = '';
    history.slice(-6).forEach(h => {
      const d = document.createElement('div');
      d.className = 'msg ' + h.who;
      d.textContent = (h.who === 'lui' ? 'Lui : ' : 'On lui dit : ') + h.text;
      el.appendChild(d);
    });
  }

  function render() {
    document.querySelectorAll('#props .quad').forEach(el => {
      const q = +el.dataset.q;
      el.querySelector('.qtext').textContent = proposals[q];
      el.classList.remove('hov');
      el.querySelector('.qbar').style.width = '0%';
    });
    $('props').classList.remove('hidden');
    $('props-actions').classList.remove('hidden');
  }

  /** Met en évidence la zone visée par le pied, avec la progression du maintien. */
  function highlight(quad, progress) {
    document.querySelectorAll('#props .quad').forEach(el => {
      const on = !!quad && +el.dataset.q === quad.q;
      el.classList.toggle('hov', on);
      el.querySelector('.qbar').style.width = on ? Math.round(progress * 100) + '%' : '0%';
    });
  }

  function init(h) {
    hooks = Object.assign(hooks, h);
    $('btn-listen').onclick = listen;
    $('conv-form').onsubmit = e => {
      e.preventDefault();
      hooks.unlockAudio();
      const inp = $('conv-input');
      const t = inp.value;
      inp.value = '';
      inp.blur();
      heard(t);
    };
    $('btn-props-more').onclick = () => { hooks.unlockAudio(); ask(); };
    $('btn-props-none').onclick = () => { hide(true); hooks.setStatus('Aucune réponse ne convenait : il peut écrire avec les cases.'); };
    $('btn-conv-clear').onclick = () => { if (!history.length || confirm('Oublier la conversation ?')) forget(); };
    document.querySelectorAll('#props .quad').forEach(el => {
      el.addEventListener('click', () => { hooks.unlockAudio(); choose(+el.dataset.q); });
    });
    showHeard('', false);
  }

  return { init, isActive, quadAt, labelOf, choose, addMine, highlight };
})();
