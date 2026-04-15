// ═══════════════════════════════════════════
// PRÉDICTION IA — appelle un proxy backend
// (Cloudflare Worker) qui détient la clé API.
// Le navigateur ne voit JAMAIS de clé.
// ═══════════════════════════════════════════
window.Prediction = (function() {
  const DEBOUNCE_MS = 800;
  const REQUEST_TIMEOUT_MS = 8000;
  const PROXY_STORAGE = 'aac_proxy_url';
  const ENABLED_STORAGE = 'aac_pred_enabled';
  // Anciennes clés à purger (l'app stockait la clé API en clair avant)
  const LEGACY_KEYS = ['aac_api_key'];

  let debounceTimer = null;
  let pendingController = null;
  let lastInputSig = '';
  let enabled = true;
  let proxyUrl = '';

  function init() {
    // Purge des anciennes clés API qui traînaient en localStorage
    LEGACY_KEYS.forEach(k => localStorage.removeItem(k));

    proxyUrl = (localStorage.getItem(PROXY_STORAGE) || '').trim();
    const stored = localStorage.getItem(ENABLED_STORAGE);
    enabled = stored === null ? true : stored === '1';
    const inp = document.getElementById('inp-proxy-url');
    if (inp) inp.value = proxyUrl;
    const chk = document.getElementById('chk-pred');
    if (chk) chk.checked = enabled;
    renderEmpty();
    bindChips();
  }

  function saveProxyUrl(u) {
    proxyUrl = (u || '').trim().replace(/\/+$/, '');
    localStorage.setItem(PROXY_STORAGE, proxyUrl);
    if (proxyUrl) scheduleSuggest();
  }

  function setEnabled(v) {
    enabled = !!v;
    localStorage.setItem(ENABLED_STORAGE, enabled ? '1' : '0');
    if (!enabled) renderEmpty();
    else scheduleSuggest();
  }

  function bindChips() {
    for (let i = 0; i < 3; i++) {
      const el = document.getElementById('pred-' + i);
      if (!el) continue;
      el.onclick = () => acceptSuggestion(i);
    }
  }

  function renderEmpty(msg) {
    for (let i = 0; i < 3; i++) {
      const el = document.getElementById('pred-' + i);
      if (!el) continue;
      el.className = 'pred-chip empty';
      el.textContent = i === 0 ? (msg || 'suggestions') : '—';
      el.dataset.word = '';
    }
  }

  function renderLoading() {
    for (let i = 0; i < 3; i++) {
      const el = document.getElementById('pred-' + i);
      if (!el) continue;
      el.className = 'pred-chip loading';
      el.textContent = i === 0 ? 'calcul' : '';
      el.dataset.word = '';
    }
  }

  function renderSuggestions(words) {
    for (let i = 0; i < 3; i++) {
      const el = document.getElementById('pred-' + i);
      if (!el) continue;
      const w = (words[i] || '').trim();
      if (w) {
        el.className = 'pred-chip';
        el.textContent = w;
        el.dataset.word = w;
      } else {
        el.className = 'pred-chip empty';
        el.textContent = '—';
        el.dataset.word = '';
      }
    }
  }

  /** Extraire la partie en cours de frappe (depuis le dernier espace) */
  function currentBuffer(fullText) {
    const m = fullText.match(/(\S*)$/);
    return m ? m[1] : '';
  }
  function contextBefore(fullText) {
    const m = fullText.match(/(.*?)(\S*)$/);
    return m ? m[1] : fullText;
  }

  /** Appelé par App.render() après chaque modification du texte */
  function scheduleSuggest() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!enabled) { renderEmpty(); return; }
    if (!proxyUrl) { renderEmpty('Configurez l\'URL du proxy'); return; }

    const txt = window.App ? App.getText() : '';
    const buffer = currentBuffer(txt);
    if (buffer.length === 0) {
      renderEmpty();
      return;
    }
    debounceTimer = setTimeout(() => callPredict(txt), DEBOUNCE_MS);
  }

  async function callPredict(fullText) {
    const buffer = currentBuffer(fullText);
    const before = contextBefore(fullText);
    const sig = before + '|' + buffer;
    if (sig === lastInputSig) return;
    lastInputSig = sig;

    if (pendingController) pendingController.abort();
    pendingController = new AbortController();
    const timeoutId = setTimeout(() => pendingController.abort(), REQUEST_TIMEOUT_MS);

    renderLoading();

    try {
      const resp = await fetch(proxyUrl + '/predict', {
        method: 'POST',
        signal: pendingController.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ before, buffer })
      });
      if (!resp.ok) {
        renderEmpty(resp.status === 403 ? 'origine bloquée' : 'erreur ' + resp.status);
        return;
      }
      const data = await resp.json();
      const words = Array.isArray(data && data.words) ? data.words : [];
      if (words.length > 0) renderSuggestions(words);
      else renderEmpty();
    } catch (e) {
      if (e.name !== 'AbortError') renderEmpty('erreur réseau');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function acceptSuggestion(i) {
    const el = document.getElementById('pred-' + i);
    if (!el) return;
    const word = el.dataset.word;
    if (!word) return;
    if (window.App) {
      const txt = App.getText();
      const newTxt = contextBefore(txt) + word + ' ';
      App.setText(newTxt);
      App.flashPredChip(el);
    }
  }

  /** ═══ COMPLÉTION DE PHRASE ═══ */
  async function completeNow() {
    if (!proxyUrl) {
      flashStatus('Configurez l\'URL du proxy dans ⚙');
      return;
    }
    const txt = (window.App ? App.getText() : '').trim();
    if (!txt) return;
    const wordCount = txt.split(/\s+/).length;
    if (wordCount < 2) {
      flashStatus('Composez au moins 2 mots');
      return;
    }

    const btn = document.getElementById('btn-complete');
    if (btn) btn.textContent = '⋯';

    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(proxyUrl + '/complete', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: txt })
      });
      if (!resp.ok) {
        flashStatus('Erreur (' + resp.status + ')');
        return;
      }
      const data = await resp.json();
      const suggestion = String((data && data.completion) || '').trim();
      if (suggestion) showGhostCompletion(txt, suggestion);
    } catch (e) {
      flashStatus(e.name === 'AbortError' ? 'Délai dépassé' : 'Erreur réseau');
    } finally {
      clearTimeout(timeoutId);
      if (btn) btn.textContent = '💡';
    }
  }

  function showGhostCompletion(txt, suggestion) {
    const outEl = document.getElementById('output-text');
    if (!outEl) return;
    let clean = suggestion.replace(/^["'«»]+|["'«»]+$/g, '').trim();
    if (!clean) return;
    const needsSpace = !txt.endsWith(' ') && !clean.startsWith(',') && !clean.startsWith('.');
    const joined = txt + (needsSpace ? ' ' : '') + clean;

    // Construction DOM (pas d'innerHTML) pour éviter toute injection
    outEl.textContent = '';
    const before = document.createElement('span');
    before.textContent = txt;
    const ghost = document.createElement('span');
    ghost.className = 'output-ghost';
    ghost.textContent = (needsSpace ? ' ' : '') + clean;
    outEl.appendChild(before);
    outEl.appendChild(ghost);

    outEl.onclick = () => {
      outEl.onclick = null;
      if (window.App) {
        App.setText(joined + ' ');
        App.speak();
      }
    };
  }

  function flashStatus(msg) {
    if (window.App) App.setStatus('orange', msg);
    setTimeout(() => { if (window.App) App.refreshStatus(); }, 2000);
  }

  return { init, saveProxyUrl, setEnabled, scheduleSuggest, completeNow };
})();
