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

  /** Appel à l'API Claude. Renvoie le texte de la réponse. */
  async function call(system, userText, maxTokens) {
    const key = getKey();
    if (!key) throw new Error('Aucune clé API. Ouvrez les réglages pour la saisir.');
    const body = {
      model: 'claude-opus-5',
      max_tokens: maxTokens,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: userText }]
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
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  /** Reconstitution par l'IA. Renvoie { phrase, alternatives }. */
  async function reconstruct(items) {
    // Suite de cases déjà corrigée une fois → on connaît la réponse
    const known = window.Learn ? Learn.knownPhrase(items) : null;
    if (known) return { phrase: known, alternatives: [], fromMemory: true };
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
    const text = await call(system, `Cases pointées (les mots entiers sont entre crochets) : ${seq}`, 400);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse IA inattendue.');
    const obj = JSON.parse(m[0]);
    return { phrase: String(obj.phrase || '').trim(), alternatives: Array.isArray(obj.alternatives) ? obj.alternatives.map(String) : [] };
  }

  const SYSTEM_CONV = `Tu aides un adulte polyhandicapé qui ne peut pas parler à répondre pendant une conversation. Il choisit sa réponse en posant le pied sur un des 4 coins de son tableau, puis le téléphone la dit à voix haute.

On te donne la conversation récente. Propose exactement 4 réponses qu'il pourrait vouloir dire à la dernière phrase qu'on lui a adressée :
- à la première personne, en français simple et naturel, comme on parle à l'oral ;
- courtes (idéalement moins de 10 mots) ;
- vraiment différentes les unes des autres (par exemple : une réponse positive, une négative, une nuancée ou une demande de précision, et une autre idée probable) ;
- adaptées à ce que l'on sait de lui d'après la conversation et ses phrases habituelles.

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"reponses": ["...", "...", "...", "..."]}
Pas de texte autour du JSON.`;

  /**
   * Propose 4 réponses à partir de la conversation.
   * history = [{ who: 'autre' | 'lui', text }], du plus ancien au plus récent.
   * avoid = réponses déjà proposées qui ne convenaient pas.
   */
  async function suggest(history, avoid) {
    let system = SYSTEM_CONV;
    const ex = (window.Learn ? Learn.examplesForIA(30) : []);
    if (ex.length) {
      system += '\n\nPhrases qu\'il a réellement dites (pour connaître sa façon de parler et ses sujets habituels) :\n' +
        ex.map(e => `- ${e.phrase}`).join('\n');
    }
    const lines = history.slice(-12).map(h => (h.who === 'lui' ? 'Lui : ' : 'Interlocuteur : ') + h.text);
    let user = 'Conversation (du plus ancien au plus récent) :\n' + lines.join('\n');
    if (avoid && avoid.length) user += '\n\nCes réponses ne lui convenaient pas, propose 4 autres idées : ' + avoid.join(' / ');
    const text = await call(system, user, 400);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse IA inattendue.');
    const obj = JSON.parse(m[0]);
    const list = (Array.isArray(obj.reponses) ? obj.reponses : []).map(x => String(x).trim()).filter(Boolean).slice(0, 4);
    if (list.length < 4) throw new Error("L'IA n'a pas proposé 4 réponses.");
    return list;
  }

  return { getKey, setKey, naive, reconstruct, suggest };
})();
