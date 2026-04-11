// ═══════════════════════════════════════════
// FAVORIS & HISTORIQUE
// ═══════════════════════════════════════════
window.Favorites = (function() {
  const KEY = 'aac_history';
  const MAX_ITEMS = 60;  // garder jusqu'à 60 phrases, afficher top 10

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function persist(items) {
    // Limiter la taille : garder les pinnés + les plus récents/fréquents
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.count * 1000 + b.lastUsed / 1e10) - (a.count * 1000 + a.lastUsed / 1e10);
    });
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  }

  /** Enregistrer une phrase au moment où elle est lue */
  function record(text) {
    const clean = text.trim();
    if (!clean) return;
    const items = load();
    const existing = items.find(it => it.text === clean);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = Date.now();
    } else {
      items.push({ text: clean, count: 1, pinned: false, lastUsed: Date.now() });
    }
    persist(items);
  }

  /** Top 10 : pinned en premier, puis par fréquence */
  function top(n = 10) {
    const items = load();
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.count !== a.count) return b.count - a.count;
      return b.lastUsed - a.lastUsed;
    });
    return items.slice(0, n);
  }

  function togglePin(text) {
    const items = load();
    const it = items.find(i => i.text === text);
    if (it) {
      it.pinned = !it.pinned;
      persist(items);
    }
    render();
  }

  function remove(text) {
    const items = load().filter(i => i.text !== text);
    persist(items);
    render();
  }

  function pick(text) {
    // Injecter dans le composeur et revenir à l'écran principal
    if (window.App) {
      App.setText(text + ' ');
      App.showScreen('main');
    }
  }

  function render() {
    const list = document.getElementById('fav-list');
    if (!list) return;
    const items = top(10);
    if (items.length === 0) {
      list.innerHTML = `<div class="fav-empty">
        Aucune phrase enregistrée.<br>
        Chaque phrase lue (▶ Lire) est ajoutée ici automatiquement.
      </div>`;
      return;
    }
    list.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'fav-item' + (it.pinned ? ' pinned' : '');
      row.innerHTML = `
        <div class="fav-text"></div>
        <div class="fav-count">${it.count}×</div>
        <button class="fav-btn pin ${it.pinned ? 'active' : ''}" title="Épingler">★</button>
        <button class="fav-btn del" title="Supprimer">🗑</button>
      `;
      const textEl = row.querySelector('.fav-text');
      textEl.textContent = it.text;
      textEl.onclick = () => pick(it.text);
      row.querySelector('.pin').onclick = () => togglePin(it.text);
      row.querySelector('.del').onclick = () => remove(it.text);
      list.appendChild(row);
    });
  }

  return { record, top, togglePin, remove, render, pick };
})();
