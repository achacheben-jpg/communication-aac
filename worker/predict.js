// Cloudflare Worker — proxy IA pour l'app AAC.
// La clé API Gemini est détenue côté serveur uniquement, JAMAIS exposée
// au navigateur. Le client appelle POST /predict ou POST /complete.
//
// Variables à configurer dans Cloudflare :
//   Secret  GEMINI_API_KEY   (wrangler secret put GEMINI_API_KEY)
//   Var     ALLOWED_ORIGINS  CSV des origines autorisées
//                            ex: "https://achacheben-jpg.github.io"
//                            (utiliser "*" pour tout autoriser — déconseillé)

const GEMINI_MODEL = 'gemini-2.0-flash-lite';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PREDICT =
  "Tu es un système de prédiction de mots pour AAC français. " +
  "L'utilisateur compose des mots en pointant des lettres et des syllabes " +
  "sur un tableau de communication. Le texte contient parfois des phonèmes " +
  "séparés (ex: 'kom' → 'comment'). À partir du début de mot donné et du " +
  "contexte, propose exactement 3 mots français complets courants qui " +
  "pourraient compléter le mot en cours. Privilégie les mots usuels. " +
  "Réponds uniquement avec un tableau JSON compact, sans texte autour, " +
  "format exact: [\"mot1\",\"mot2\",\"mot3\"]";

const SYSTEM_COMPLETE =
  "Tu complètes une phrase en français pour un utilisateur AAC. Continue " +
  "la phrase de façon naturelle et courte (maximum 8 mots supplémentaires). " +
  "Réponds uniquement avec la suite à ajouter, sans répéter le début, sans " +
  "guillemets, sans explication.";

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!cors['Access-Control-Allow-Origin']) {
      return json({ error: 'origin not allowed' }, 403, cors);
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, cors);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'server not configured' }, 500, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'bad json' }, 400, cors); }

    const path = new URL(request.url).pathname;
    try {
      if (path === '/predict')  return await handlePredict(body, env, cors);
      if (path === '/complete') return await handleComplete(body, env, cors);
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'upstream error' }, 502, cors);
    }
  }
};

function buildCorsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (allowed.includes('*') ? '*' : origin) : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

async function handlePredict(body, env, cors) {
  const before = String(body.before || '').slice(0, 500);
  const buffer = String(body.buffer || '').slice(0, 50);
  if (!buffer) return json({ words: [] }, 200, cors);

  const userPrompt =
    `Contexte: "${before.trim()}"\n` +
    `Début du mot: "${buffer}"\n` +
    `Propose 3 complétions probables.`;

  const data = await callGemini(env.GEMINI_API_KEY, SYSTEM_PREDICT, userPrompt, 80);
  const words = parseWords(extractText(data));
  return json({ words }, 200, cors);
}

async function handleComplete(body, env, cors) {
  const txt = String(body.text || '').slice(0, 500).trim();
  if (!txt) return json({ completion: '' }, 200, cors);

  const userPrompt =
    `Phrase à compléter : "${txt}"\n` +
    `Suite (max 8 mots) :`;

  const data = await callGemini(env.GEMINI_API_KEY, SYSTEM_COMPLETE, userPrompt, 80);
  const completion = extractText(data).trim().replace(/^["'«»]+|["'«»]+$/g, '');
  return json({ completion }, 200, cors);
}

async function callGemini(apiKey, system, userPrompt, maxTokens) {
  const url = `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    })
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  return r.json();
}

function extractText(resp) {
  return resp?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseWords(raw) {
  if (!raw) return [];
  const m = raw.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr)) {
      return arr.map(w => String(w).trim()).filter(Boolean).slice(0, 3);
    }
  } catch {}
  return [];
}
