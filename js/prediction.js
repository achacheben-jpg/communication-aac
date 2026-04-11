// ═══════════════════════════════════════════
// PRÉDICTION IA (Anthropic API)
// ═══════════════════════════════════════════
window.Prediction = (function() {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODEL = 'claude-haiku-4-5-20251001';
  const DEBOUNCE_MS = 800;
  const KEY_STORAGE = 'aac_api_key';
  const ENABLED_STORAGE = 'aac_pred_enabled';

  let debounceTimer = null;
  let pendingController = null;
  let lastInputSig = '';
  let enabled = true;
  let apiKey = '';

  function init() {
    apiKey = localStorage.getItem(KEY_STORAGE) || '';
    const stored = localStorage.getItem(ENABLED_STORAGE);
    enabled = stored === null ? true : stored === '1';
    const inp = document.getElementById('inp-apikey');
    if (inp) inp.value = apiKey;
    const chk = document.getElementById('chk-pred');
    if (chk) chk.checked = enabled;
    renderEmpty();
    bindChips();
  }

  function saveKey(k) {
    apiKey = (k || '').trim();
    localStorage.setItem(KEY_STORAGE, apiKey);
    if (apiKey) scheduleSuggest();
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
    if (!apiKey) { renderEmpty('Ajoutez votre clé API'); return; }

    const txt = window.App ? App.getText() : '';
    const buffer = currentBuffer(txt);
    if (buffer.length === 0) {
      renderEmpty();
      return;
    }
    debounceTimer = setTimeout(() => callAPI(txt), DEBOUNCE_MS);
  }

  async function callAPI(fullText) {
    const buffer = currentBuffer(fullText);
    const before = contextBefore(fullText);
    const sig = before + '|' + buffer;
    if (sig === lastInputSig) return;
    lastInputSig = sig;

    if (pendingController) pendingController.abort();
    pendingController = new AbortController();

    renderLoading();

    const system = "Tu es un système de prédiction de mots pour AAC français. L'utilisateur compose des mots en pointant des lettres et des syllabes sur un tableau de communication. Le texte contient parfois des phonèmes séparés (ex: 'kom' → 'comment'). À partir du début de mot donné et du contexte, propose exactement 3 mots français complets courants qui pourraient compléter le mot en cours. Privilégie les mots usuels. Réponds uniquement avec un tableau JSON compact, sans texte autour, format exact: [\"mot1\",\"mot2\",\"mot3\"]";
    const user = `Contexte: "${before.trim()}"\nDébut du mot: "${buffer}"\nPropose 3 complétions probables.`;

    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        signal: pendingController.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 100,
          system,
          messages: [{ role: 'user', content: user }]
        })
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.warn('Prediction API error', resp.status, body);
        renderEmpty(resp.status === 401 ? 'clé invalide' : 'erreur API');
        return;
      }
      const data = await resp.json();
      const text = (data.content && data.content[0] && data.content[0].text) || '';
      const words = parseWords(text);
      if (words.length > 0) renderSuggestions(words);
      else renderEmpty();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('Prediction fetch error', e);
        renderEmpty('erreur réseau');
      }
    }
  }

  function parseWords(raw) {
    if (!raw) return [];
    // Extraire tableau JSON, même avec texte autour
    const m = raw.match(/\[[^\]]*\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr.map(w => String(w).trim()).filter(Boolean).slice(0, 3);
      }
    } catch (e) {}
    return [];
  }

  function acceptSuggestion(i) {
    const el = document.getElementById('pred-' + i);
    if (!el) return;
    const word = el.dataset.word;
    if (!word) return;
    // Remplace le buffer courant par le mot complet + espace
    if (window.App) {
      const txt = App.getText();
      const newTxt = contextBefore(txt) + word + ' ';
      App.setText(newTxt);
      App.flashPredChip(el);
    }
  }

  /** ═══ COMPLÉTION DE PHRASE (3.2) ═══ */
  async function completeNow() {
    if (!apiKey) {
      flashStatus('Ajoutez votre clé API dans ⚙');
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

    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 80,
          system: "Tu complètes une phrase en français pour un utilisateur AAC. Continue la phrase de façon naturelle et courte (maximum 8 mots supplémentaires). Réponds uniquement avec la suite à ajouter, sans répéter le début, sans guillemets, sans explication.",
          messages: [{ role: 'user', content: `Phrase à compléter : "${txt}"\nSuite (max 8 mots) :` }]
        })
      });
      if (!resp.ok) {
        flashStatus('Erreur API (' + resp.status + ')');
        return;
      }
      const data = await resp.json();
      const suggestion = ((data.content && data.content[0] && data.content[0].text) || '').trim();
      if (suggestion) showGhostCompletion(txt, suggestion);
    } catch (e) {
      flashStatus('Erreur réseau');
    } finally {
      if (btn) btn.textContent = '💡';
    }
  }

  function showGhostCompletion(txt, suggestion) {
    const outEl = document.getElementById('output-text');
    if (!outEl) return;
    // Nettoyer : retirer une ponctuation finale pour fusion propre
    let clean = suggestion.replace(/^["'«»]+|["'«»]+$/g, '').trim();
    if (!clean) return;
    const needsSpace = !txt.endsWith(' ') && !clean.startsWith(',') && !clean.startsWith('.');
    const joined = txt + (needsSpace ? ' ' : '') + clean;

    outEl.innerHTML = `<span>${escapeHtml(txt)}</span><span class="output-ghost">${needsSpace ? ' ' : ''}${escapeHtml(clean)}</span>`;
    outEl.onclick = () => {
      outEl.onclick = null;
      if (window.App) App.setText(joined + ' ');
      // Lire immédiatement
      if (window.App) App.speak();
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
  }

  function flashStatus(msg) {
    if (window.App) App.setStatus('orange', msg);
    setTimeout(() => { if (window.App) App.refreshStatus(); }, 2000);
  }

  return { init, saveKey, setEnabled, scheduleSuggest, completeNow };
})();
