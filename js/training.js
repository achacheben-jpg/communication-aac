// ═══════════════════════════════════════════
// TRAINING — apprentissage supervisé sur vidéo(s)
// ═══════════════════════════════════════════
// À partir d'une paire (vidéo, texte attendu), optimise les paramètres
// de transcription (offsetV, offsetU, dwellMs) en deux passes de grid
// search sur une trace pré-enregistrée.
//
// Flux :
//   1. L'utilisateur choisit une vidéo + écrit le texte attendu
//   2. collectTrace() : joue la vidéo une fois, enregistre (time, uv)
//      pour chaque frame où le pied est détecté (via Camera en mode
//      "training" — détection active mais dwell désactivé)
//   3. simulate() : rejoue la trace avec des paramètres arbitraires et
//      renvoie la transcription résultante
//   4. gridSearch() : évalue ~1500 combinaisons et renvoie la meilleure
//      au sens de la distance de Levenshtein normalisée
//   5. apply() : sauvegarde les paramètres trouvés en localStorage et
//      synchronise les sliders UI
//
window.Training = (function() {
  const OFFSET_ROWS_KEY = 'aac_trained_offset_rows';
  const OFFSET_U_KEY = 'aac_trained_offset_u';
  const DWELL_KEY = 'aac_trained_dwell_ms';

  let cellMap = null;

  /** Indexation des cases cliquables en coordonnées UV tableau [0..1]. */
  function precomputeCellMap() {
    const tb = document.getElementById('tableau');
    if (!tb) return [];
    const tbR = tb.getBoundingClientRect();
    if (tbR.width === 0 || tbR.height === 0) return [];
    const cells = Tableau.allSelectable();
    return cells.map(cell => {
      const cR = cell.getBoundingClientRect();
      return {
        val: cell.dataset.val,
        u1: (cR.left - tbR.left) / tbR.width,
        u2: (cR.right - tbR.left) / tbR.width,
        v1: (cR.top - tbR.top) / tbR.height,
        v2: (cR.bottom - tbR.top) / tbR.height,
        uc: (cR.left + cR.width / 2 - tbR.left) / tbR.width,
        vc: (cR.top + cR.height / 2 - tbR.top) / tbR.height
      };
    });
  }

  function findCellAtUV(u, v) {
    if (!cellMap) return null;
    for (let i = 0; i < cellMap.length; i++) {
      const c = cellMap[i];
      if (u >= c.u1 && u <= c.u2 && v >= c.v1 && v <= c.v2) return c;
    }
    return null;
  }

  /** Capture une trace complète (une passe) en lisant la vidéo via Camera. */
  function collectTrace(onProgress) {
    return new Promise((resolve, reject) => {
      if (!window.VideoSource || !VideoSource.has()) {
        reject(new Error('Aucune vidéo chargée'));
        return;
      }
      if (!window.Camera || !Camera.startTraining) {
        reject(new Error('Camera.startTraining indisponible'));
        return;
      }

      // Active le mode enregistrement AVANT de démarrer Camera
      Camera.startTraining();

      let tickInterval = null;
      const cleanup = () => {
        if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
      };

      // Camera.start() est async : on attend qu'elle ait posé son propre
      // onended, puis on le remplace par le nôtre pour capturer la trace.
      Camera.start().then(() => {
        const v = document.getElementById('video-live');
        if (!v) { reject(new Error('élément vidéo introuvable')); return; }

        v.onended = () => {
          cleanup();
          const trace = Camera.stopTrainingAndGetTrace();
          resolve(trace);
        };
        v.onerror = (e) => {
          cleanup();
          Camera.stopTrainingAndGetTrace();
          reject(new Error('erreur lecture vidéo : ' + (e && e.message || '')));
        };

        tickInterval = setInterval(() => {
          if (onProgress && v.duration) {
            onProgress(Math.min(1, v.currentTime / v.duration));
          }
        }, 200);

        // Sécurité : si la vidéo est déjà terminée (edge case)
        if (v.ended || (v.duration && v.currentTime >= v.duration - 0.05)) {
          cleanup();
          resolve(Camera.stopTrainingAndGetTrace());
        }
      }).catch((e) => {
        cleanup();
        Camera.stopTrainingAndGetTrace();
        reject(e);
      });
    });
  }

  /** Simule le pipeline de dwell sur une trace pré-enregistrée. */
  function simulate(trace, offsetU, offsetV, dwellMs) {
    if (!cellMap) cellMap = precomputeCellMap();
    let currentCell = null;
    let dwellStart = 0;
    let transcript = '';
    // Anti-répétition : après une sélection, exiger de quitter puis revenir
    let cooldownUntil = 0;

    for (let i = 0; i < trace.length; i++) {
      const pt = trace[i];
      const u = pt.u - offsetU;
      const v = pt.v - offsetV;
      if (u < 0 || u > 1 || v < 0 || v > 1) {
        currentCell = null;
        dwellStart = 0;
        continue;
      }
      const c = findCellAtUV(u, v);
      if (!c) {
        currentCell = null;
        dwellStart = 0;
        continue;
      }
      if (c !== currentCell) {
        currentCell = c;
        dwellStart = pt.t;
        continue;
      }
      // Même case qu'avant → accumuler le dwell
      if (pt.t < cooldownUntil) continue;
      const elapsedMs = (pt.t - dwellStart) * 1000;
      if (elapsedMs >= dwellMs) {
        transcript += c.val;
        cooldownUntil = pt.t + 0.3; // 300 ms de cooldown avant re-sélection
        currentCell = null;
        dwellStart = 0;
      }
    }
    return transcript;
  }

  /** Distance de Levenshtein normalisée par la longueur du texte cible.
   *  Nettoie ponctuation et casse avant comparaison. */
  function normalizedDistance(candidate, target) {
    const clean = (s) => (s || '').toLowerCase().replace(/[\s.,!?;:()«»"']/g, '');
    const a = clean(candidate);
    const b = clean(target);
    if (b.length === 0) return a.length;
    return levenshtein(a, b) / b.length;
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) dp[j] = prev;
        else dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
        prev = tmp;
      }
    }
    return dp[n];
  }

  /** Grid search en deux passes (coarse + refine) sur (offsetV, offsetU, dwell). */
  async function gridSearch(trace, target, onProgress) {
    cellMap = precomputeCellMap();
    if (trace.length === 0) {
      return { err: 'Trace vide — aucune détection du pied pendant la vidéo.' };
    }

    const tbRows = 10;
    let best = { dist: Infinity, offsetRows: 2, offsetU: 0, dwellMs: 1500, transcript: '' };

    // ═══ PASSE 1 : COARSE ═══
    const coarseOvRows = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const coarseOu = [-0.1, -0.05, 0, 0.05, 0.1];
    const coarseDw = [400, 600, 800, 1000, 1200, 1500, 1800, 2200];

    const total1 = coarseOvRows.length * coarseOu.length * coarseDw.length;
    let done = 0;
    for (const ovRows of coarseOvRows) {
      for (const ou of coarseOu) {
        for (const dw of coarseDw) {
          const ov = ovRows / tbRows;
          const tr = simulate(trace, ou, ov, dw);
          const d = normalizedDistance(tr, target);
          if (d < best.dist) {
            best = { dist: d, offsetRows: ovRows, offsetU: ou, dwellMs: dw, transcript: tr };
          }
          done++;
        }
      }
      if (onProgress) {
        onProgress(done / (total1 * 2));
        await sleep(0);
      }
    }

    // ═══ PASSE 2 : REFINE autour du meilleur ═══
    const refineOvStep = 0.1;
    const refineOvRows = [];
    for (let k = -4; k <= 4; k++) refineOvRows.push(+(best.offsetRows + k * refineOvStep).toFixed(2));
    const refineOuStep = 0.02;
    const refineOu = [];
    for (let k = -3; k <= 3; k++) refineOu.push(+(best.offsetU + k * refineOuStep).toFixed(3));
    const refineDwStep = 100;
    const refineDw = [];
    for (let k = -3; k <= 3; k++) refineDw.push(best.dwellMs + k * refineDwStep);

    const total2 = refineOvRows.length * refineOu.length * refineDw.length;
    done = 0;
    for (const ovRows of refineOvRows) {
      for (const ou of refineOu) {
        for (const dw of refineDw) {
          if (ovRows < -1 || ovRows > 5 || dw < 200 || dw > 3500) { done++; continue; }
          const ov = ovRows / tbRows;
          const tr = simulate(trace, ou, ov, dw);
          const d = normalizedDistance(tr, target);
          if (d < best.dist) {
            best = { dist: d, offsetRows: ovRows, offsetU: ou, dwellMs: dw, transcript: tr };
          }
          done++;
        }
      }
      if (onProgress) {
        onProgress(0.5 + done / (total2 * 2));
        await sleep(0);
      }
    }

    if (onProgress) onProgress(1);
    return best;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Sauvegarde les paramètres trouvés + applique aux sliders UI. */
  function apply(best) {
    if (!best || best.dist === Infinity) return;
    localStorage.setItem(OFFSET_ROWS_KEY, String(best.offsetRows));
    localStorage.setItem(OFFSET_U_KEY, String(best.offsetU));
    localStorage.setItem(DWELL_KEY, String(best.dwellMs));

    // Synchroniser les sliders / learned offset
    const slOffset = document.getElementById('sl-offset');
    if (slOffset) {
      slOffset.value = String(best.offsetRows);
      slOffset.dispatchEvent(new Event('input'));
    }
    const slDwell = document.getElementById('sl-dwell');
    if (slDwell) {
      slDwell.value = String(best.dwellMs / 1000);
      slDwell.dispatchEvent(new Event('input'));
    }
    // Mettre aussi dans learned offset pour la compensation horizontale
    const learned = {
      du: best.offsetU,
      dv: 0,
      samples: 0,
      trainedAt: Date.now()
    };
    localStorage.setItem('aac_learned_offset', JSON.stringify(learned));
  }

  /** Applique les params sauvegardés au démarrage (si présents). */
  function loadSavedOnStartup() {
    const ov = localStorage.getItem(OFFSET_ROWS_KEY);
    const dw = localStorage.getItem(DWELL_KEY);
    if (ov !== null) {
      const slOffset = document.getElementById('sl-offset');
      if (slOffset) {
        slOffset.value = ov;
        slOffset.dispatchEvent(new Event('input'));
      }
    }
    if (dw !== null) {
      const slDwell = document.getElementById('sl-dwell');
      if (slDwell) {
        slDwell.value = String(parseFloat(dw) / 1000);
        slDwell.dispatchEvent(new Event('input'));
      }
    }
  }

  return {
    collectTrace, simulate, gridSearch, apply, loadSavedOnStartup,
    precomputeCellMap, normalizedDistance
  };
})();
