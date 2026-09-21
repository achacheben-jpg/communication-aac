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
