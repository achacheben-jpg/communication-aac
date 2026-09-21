// ═══════════════════════════════════════════════════════════════
// IA — reconstitution de la phrase à partir de la suite de cases.
// Appelle l'API Claude directement depuis le téléphone avec la clé
// saisie dans les réglages (stockée uniquement sur le téléphone).
// ═══════════════════════════════════════════════════════════════
window.IA = (function () {

  const SYSTEM = `Tu aides à déchiffrer les phrases d'un adulte polyhandicapé qui communique en pointant avec le pied un tableau de lettres, de syllabes et de mots. Il n'a pas de précision motrice : il arrive qu'une case voisine soit pointée à la place de la bonne, ou qu'une case soit pointée deux fois.

Le tableau contient :
- des SONS (consonnes et voyelles phonétiques) : p t k r f s ch n b d g l v z j gn m e u a o é i oe ou an on è in ieu ui oi ill oin un ien. "k" vaut aussi "qu"/"c dur", "s" vaut aussi "c doux", "g" vaut "gu", "j" vaut "ge", "f" vaut "ph".
- des MOTS entiers : oui, non, est-ce que, ça va, il y a, s'il vous plaît, pardon, vous, il, je, tu, elle, nous, merci, salut, tu as compris ?, au revoir, pourquoi, quand, où, comment, combien.

Il écrit phonétiquement, sans espace : les sons se suivent pour former des mots. Exemple : "j e v eu m an j é" = "je veux manger". Il n'y a pas de séparateur entre les mots : à toi de découper.

On te donne la suite de cases pointées, dans l'ordre. Réponds UNIQUEMENT avec un objet JSON de la forme :
{"phrase": "la phrase la plus probable en bon français", "alternatives": ["autre lecture possible", "..."]}
Donne 0 à 3 alternatives, courtes. Pas de texte autour du JSON.`;

  function getKey() { try { return localStorage.getItem('aac_api_key') || ''; } catch (e) { return ''; } }
  function setKey(k) { try { localStorage.setItem('aac_api_key', k || ''); } catch (e) { } }

  /** Lecture "brute" sans IA : sons collés, mots séparés par des espaces. */
  function naive(items) {
    let out = '';
    for (const it of items) {
      if (it.kind === 'sound') out += it.value;
      else out += (out && !out.endsWith(' ') ? ' ' : '') + it.value + ' ';
    }
    return out.trim();
  }

  /** Reconstitution par l'IA. Renvoie { phrase, alternatives }. */
  async function reconstruct(items) {
    // Suite de cases déjà corrigée une fois → on connaît la réponse
    const known = window.Learn ? Learn.knownPhrase(items) : null;
    if (known) return { phrase: known, alternatives: [], fromMemory: true };
    const key = getKey();
    if (!key) throw new Error('Aucune clé API. Ouvrez les réglages pour la saisir.');
    const fmt = list => list.map(it => it.kind === 'sound' ? it.value : `[${it.value}]`).join(' ');
    const seq = fmt(items);
    // Exemples appris (corrections faites à la main) : montrent à l'IA
    // la façon d'écrire de la personne.
    let system = SYSTEM;
    const ex = (window.Learn ? Learn.examplesForIA(40) : []);
    if (ex.length) {
      system += '\n\nVoici des phrases réelles de cette personne, avec la suite de cases pointées et la phrase correcte (confirmée par un proche). Imite sa façon d\'écrire, ses raccourcis et ses habitudes :\n' +
        ex.map(e => `- ${e.labels.join(' ')}  →  ${e.phrase}`).join('\n');
    }
    const body = {
      model: 'claude-opus-5',
      max_tokens: 400,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: `Cases pointées (les mots entiers sont entre crochets) : ${seq}` }]
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let msg = `Erreur ${res.status}`;
      try { const e = await res.json(); if (e.error && e.error.message) msg += ' : ' + e.error.message; } catch (_) { }
      throw new Error(msg);
    }
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error("L'IA n'a pas pu répondre à cette demande.");
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse IA inattendue.');
    const obj = JSON.parse(m[0]);
    return { phrase: String(obj.phrase || '').trim(), alternatives: Array.isArray(obj.alternatives) ? obj.alternatives.map(String) : [] };
  }

  return { getKey, setKey, naive, reconstruct };
})();
