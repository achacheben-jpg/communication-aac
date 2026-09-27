# Lecture du tableau

Application web pour iPhone qui lit, avec la caméra, les cases qu'une personne
désigne avec son pied sur son tableau de communication, puis reconstitue la
phrase et la lit à voix haute.

## Installer sur l'iPhone (une seule fois)

1. Ouvrir l'adresse de l'application dans **Safari**.
2. Appuyer sur le bouton **Partager** (carré avec une flèche) puis
   **Sur l'écran d'accueil**.
3. Ouvrir l'application depuis l'écran d'accueil et **autoriser la caméra**.

## Préparer un essai

1. Poser le téléphone sur un support fixe, caméra arrière vers le tableau.
   Tout le tableau doit être visible, le plus en face possible.
2. Le pied doit être **hors** du tableau.
3. Appuyer sur **Calibrer** : glisser les 4 points jaunes sur les 4 coins du
   tableau (HG = coin près du chiffre 0). Appuyer sur **Valider**.
   L'application mémorise alors l'image du tableau vide.
4. Si la lumière change ou si le téléphone a bougé : pied hors du tableau,
   appuyer sur **Référence** (ou refaire **Calibrer** si le téléphone a bougé).

## Pendant l'écriture

- La case sous la pointe du pied s'affiche en grand, avec une barre verte qui
  se remplit. Quand la barre est pleine, la case est **validée** (bip + voix).
- Les cases validées s'affichent dans « Ce qu'il montre ».
- « **non** » efface la dernière case (réglable).
- **Reconstituer** demande à l'IA la phrase la plus probable (automatique
  2,5 s après la dernière case si une clé API est saisie dans les réglages).
- **Lire** prononce la phrase.
- Toucher une case du mini tableau l'ajoute à la main (pour corriger).

## Mode conversation (réponses proposées)

Pour répondre plus vite quand on lui parle :

1. Appuyer sur **🎤 Écouter**, puis lui parler normalement. On peut aussi
   **taper** la phrase dans le champ en dessous (ou utiliser le micro du clavier).
2. L'IA propose **4 réponses**, une par grand coin du tableau :
   haut gauche, haut droit, bas gauche, bas droit.
3. Il pose le pied dans le coin de la réponse choisie et le garde le temps
   que la barre verte se remplisse : la réponse est dite à voix haute.
4. Rien ne convient ? **🔄 Autres réponses** en demande 4 nouvelles ;
   **✖ Aucune : il écrit** revient aux cases habituelles.

Si le pied est déjà posé quand les réponses apparaissent, il doit le bouger ou
le lever avant de choisir (pour éviter un choix involontaire). La conversation
sert de contexte à l'IA ; **🗑 oublier** l'efface. Les phrases qu'il écrit avec
les cases puis fait **Lire** sont aussi ajoutées à la conversation.

Nécessite la clé API. La voix entendue est transcrite par l'iPhone (service
d'Apple), puis le texte est envoyé à l'IA.

## Réglages utiles

- **Temps de maintien** : durée pendant laquelle le pied doit rester sur la
  case (1,2 s par défaut). Augmenter si trop de fausses validations.
- **Sensibilité** : baisser si le pied n'est pas détecté, monter si des
  zones orange apparaissent sans le pied (ombres, reflets).
- **Décalage de la pointe** : si la case validée est toujours un peu au-dessus
  ou en dessous de celle visée.
- **Le pied arrive par le côté** : côté du tableau par lequel le pied entre.
- **Tester avec une vidéo** : permet d'essayer avec une vidéo enregistrée,
  sans la personne.

## Mise en ligne

Le site est publié automatiquement par GitHub Pages à chaque modification de
la branche `main`.

## Apprentissage automatique

- **Phrase fausse** : bouton « Ce n'est pas ça : noter la bonne phrase », taper
  la phrase correcte. Elle est mémorisée : la même suite de cases donnera
  directement cette phrase, et l'IA reçoit les phrases apprises comme exemples
  de la façon d'écrire de la personne.
- **Case mal détectée** : toucher la case dans « Ce qu'il montre », puis la
  bonne case sur le mini tableau. À partir de 3 corrections, l'application
  calcule le décalage moyen entre la pointe détectée et la case visée et
  l'applique automatiquement.
- Réglages → Apprentissage : voir le bilan, partager le fichier
  d'apprentissages (utile pour l'analyse), l'importer sur un autre téléphone,
  ou tout oublier.
