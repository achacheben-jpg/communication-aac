# Prompt Claude Code — Application de Communication AAC

## Contexte utilisateur

Tu travailles sur une application de communication assistée (AAC) pour un adulte polyhandicapé :
- Spasticité générale, mouvements involontaires partiellement volontaires
- Aucune précision motrice, ne peut pas fixer une position volontairement
- Utilise son **pied** pour pointer un tableau de lettres/syllabes
- Niveau cognitif : au-dessus de la moyenne
- Utilise ce tableau depuis 20 ans

## Ce qui existe déjà (Phase 1 + 2)

Un fichier `index.html` autonome qui contient :
- Le tableau de communication fidèle à l'original (lettres, syllabes, mots fonctionnels)
- Mode manuel : clic sur les cases → synthèse vocale lit le texte
- Mode caméra : calibration 4 coins du tableau physique, détection du pied par analyse de pixels, dwell selection (maintien = sélection)
- Réglage du décalage vertical (le pied pointe au-dessus du pouce, pas à la pointe)
- PWA : fonctionne dans le navigateur mobile, calibration sauvegardée en localStorage
- Hébergé sur GitHub Pages

## Structure du tableau (à respecter absolument)

```
Ligne 0  : non | est-ce que ? | ça va | il y a       DROITE: oui (span 0-1)
Ligne 1  : [s.v.p. span 1-3] | p  t  k  r  f  s  ch    DROITE col4: n
Ligne 2  : [s.v.p. span]     | b  d  g  l  v  z  j     DROITE col4: gn (span 2-3)  col5: pardon
Ligne 3  : [s.v.p. span]     | (vides)              m   DROITE col4: (gn span)
Ligne 4  : (vide)            | vous il je tu elle nous
Ligne 5  : merci             | e  u  a  o  é  i         DROITE: salut
Ligne 6  : (vide)            | oe ou an on è in
Ligne 7  : (vide)            | (vide)
Ligne 8  : tu as compris ?   | ieu ui oi ill oin un ien  DROITE: au revoir (span 8-9)
Ligne 9  : (vide)            | pourquoi quand où comment combien
```

## Phase 3 — Ce que tu dois construire

### Objectif
Réduire le nombre de sélections nécessaires pour former une phrase, grâce à la prédiction et l'apprentissage.

---

### 3.1 — Prédiction de mots en temps réel

**Principe** : après chaque lettre/syllabe sélectionnée, afficher 3-4 suggestions de mots probables.

**Implémentation** :
- Utiliser l'API Anthropic (`claude-haiku-4-5-20251001`) pour la prédiction
- Prompt système : `"Tu es un système de prédiction de mots pour AAC français. À partir des lettres/syllabes entrées, propose exactement 3 mots courts et courants sous forme JSON array. Exemple: ["suis","sur","sa"]"`
- Afficher les suggestions comme cases cliquables au-dessus du tableau
- Si l'utilisateur sélectionne une suggestion → le mot entier est ajouté d'un coup
- Debounce : appeler l'API 800ms après la dernière sélection

**UI suggestion** :
```
[ suis ]  [ sur ]  [ sa ]   ← cases bleues cliquables, grande taille
```

---

### 3.2 — Complétion de phrase

**Principe** : quand le texte composé fait plus de 3 mots, proposer une complétion de phrase entière.

**Implémentation** :
- Bouton "💡 Compléter" dans la barre d'output
- Appel API avec le contexte : `"Complète cette phrase en français de façon naturelle et courte (max 8 mots) : [texte actuel]"`
- La complétion apparaît en grisé après le texte actuel
- Un tap sur la complétion → elle est acceptée et lue

---

### 3.3 — Historique et favoris

**Principe** : mémoriser les phrases complètes les plus utilisées.

**Implémentation** :
- À chaque "▶ Lire" → sauvegarder la phrase en localStorage avec un compteur
- Écran "Favoris" accessible depuis la toolbar
- Afficher les 10 phrases les plus fréquentes, cliquables
- Bouton pour épingler/supprimer

---

### 3.4 — Apprentissage du décalage caméra

**Principe** : au lieu d'un décalage fixe réglé manuellement, apprendre automatiquement le vrai offset.

**Implémentation** :
- En mode manuel, quand l'utilisateur clique une case, enregistrer la position du pied détectée à ce moment
- Calculer l'offset réel entre position pied et case cliquée
- Après 20 paires enregistrées → ajuster automatiquement les paramètres de détection
- Afficher "Calibration automatique : 12/20 paires enregistrées"

---

### 3.5 — Amélioration détection caméra (MediaPipe)

La détection actuelle par analyse de pixels sombres est basique. Remplacer par **MediaPipe Hands** :

```javascript
// Charger MediaPipe Hands
import { Hands } from '@mediapipe/hands';

const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 0,        // léger pour mobile
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.5
});

hands.onResults((results) => {
  if (!results.multiHandLandmarks?.length) return;
  const landmarks = results.multiHandLandmarks[0];
  // Utiliser le landmark 8 (index tip) ou 4 (thumb tip)
  // Pour un pied : utiliser les landmarks les plus bas (y le plus grand)
  const tip = landmarks[8]; // index fingertip — adapter pour le pied
  // tip.x, tip.y sont normalisés [0,1]
  handleFootPosition(tip.x, tip.y);
});
```

**Note importante** : MediaPipe est entraîné sur des mains. Pour un pied, utiliser **MediaPipe Pose** (landmarks 31/32 = pieds) qui fonctionne mieux :

```javascript
import { Pose } from '@mediapipe/pose';
// landmark 31 = left_foot_index
// landmark 32 = right_foot_index  
// Prendre celui avec visibility > 0.5
// Appliquer l'offset vertical calibré
```

---

### 3.6 — Mode "scan automatique" (alternative sans caméra)

Pour les moments où la caméra n'est pas disponible :
- Les cases s'illuminent automatiquement ligne par ligne
- La personne fait un son/mouvement pour valider la ligne
- Puis les cases de la ligne s'illuminent une par une
- Validation = sélection

Implémentation avec Web Audio API pour détecter un son :
```javascript
navigator.mediaDevices.getUserMedia({ audio: true })
  .then(stream => {
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    // Détecter pic d'amplitude > seuil → validation
  });
```

---

## Architecture technique recommandée

```
communication-app/
├── index.html          ← page principale (tableau + UI)
├── css/
│   └── style.css
├── js/
│   ├── app.js          ← logique principale
│   ├── tableau.js      ← structure et rendu du tableau
│   ├── camera.js       ← détection caméra (MediaPipe Pose)
│   ├── prediction.js   ← appels API Anthropic
│   ├── history.js      ← historique et favoris
│   └── calibration.js  ← calibration et offset learning
├── manifest.json       ← PWA manifest
└── sw.js               ← Service Worker (offline)
```

## PWA complète

Ajouter un `manifest.json` :
```json
{
  "name": "Communication",
  "short_name": "AAC",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0f",
  "theme_color": "#2980b9",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Et un Service Worker pour fonctionner hors ligne.

## API Anthropic — clé

L'app utilise l'API Anthropic pour la prédiction (phase 3.1 et 3.2).
- Modèle : `claude-haiku-4-5-20251001` (rapide + économique)
- La clé API doit être saisie par l'utilisateur dans les réglages et stockée en localStorage
- Ne jamais la hardcoder dans le code

## Contraintes UX critiques

1. **Cases très grandes** — la personne a peu de précision
2. **Feedback immédiat** — animation flash dès sélection
3. **Synthèse vocale** — toujours `lang: 'fr-FR'`
4. **Pas de scroll horizontal** — tout doit tenir en largeur
5. **Dwell minimum 0.5s** — éviter les faux positifs
6. **Offset vertical réglable** — la case est toujours AU-DESSUS du pouce visible
7. **Calibration persistante** — sauvegardée entre les sessions
8. **Mode dégradé** — si caméra indisponible, mode manuel toujours accessible

## Priorité de développement

1. `prediction.js` — prédiction de mots (impact immédiat)
2. Amélioration détection MediaPipe Pose
3. `history.js` — historique/favoris
4. Offset learning automatique
5. Mode scan audio
6. PWA complète offline
