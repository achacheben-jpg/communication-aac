# Proxy IA — Cloudflare Worker

Ce Worker garde la clé Gemini côté serveur. Le navigateur ne voit jamais la clé.

## Endpoints

- `POST /predict` — body : `{ "before": "...", "buffer": "..." }` → `{ "words": ["mot1","mot2","mot3"] }`
- `POST /complete` — body : `{ "text": "..." }` → `{ "completion": "..." }`

## Déploiement (4 commandes)

Pré-requis : un compte [Cloudflare](https://dash.cloudflare.com/sign-up) (gratuit) et une nouvelle clé [Google AI Studio](https://aistudio.google.com/app/apikey).

```bash
# 1. Installer wrangler (CLI Cloudflare)
npm install -g wrangler

# 2. Se connecter à Cloudflare (ouvre le navigateur)
wrangler login

# 3. Stocker la clé Gemini comme secret (jamais committé)
wrangler secret put GEMINI_API_KEY
# → coller la clé quand demandé

# 4. Déployer
wrangler deploy
```

Wrangler renvoie une URL du type `https://aac-predict.<ton-sous-domaine>.workers.dev`.

## Configuration côté app

Ouvrir l'app, aller dans **⚙ Réglages → Prédiction IA → URL du proxy** et coller l'URL du Worker (sans `/predict` à la fin).

## Vérifier que ça marche

```bash
curl -X POST https://aac-predict.<sous-domaine>.workers.dev/predict \
  -H "Content-Type: application/json" \
  -H "Origin: https://achacheben-jpg.github.io" \
  -d '{"before":"je suis ","buffer":"co"}'
```

Doit renvoyer : `{"words":["content","comme","contre"]}` (ou similaire).

## Sécurité

- La clé Gemini est un **secret** Cloudflare, jamais dans le code ni dans les logs.
- CORS restreint aux origines listées dans `wrangler.toml` (`ALLOWED_ORIGINS`).
- Pour ajouter une origine (autre déploiement, mobile via Capacitor, etc.) : éditer `wrangler.toml` et redéployer (`wrangler deploy`).
- En cas de fuite suspectée : régénérer la clé sur Google AI Studio, puis `wrangler secret put GEMINI_API_KEY` avec la nouvelle clé.

## Coûts

- Cloudflare Workers : 100 000 requêtes/jour gratuits.
- Gemini `gemini-2.0-flash-lite` : voir tarification Google AI Studio (généreux quota gratuit).
