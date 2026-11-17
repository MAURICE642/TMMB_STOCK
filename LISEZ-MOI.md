# TRIOMPHANT — Stock

Application web de gestion de stock, construite comme l'application de comptabilité :
même projet Firebase (`triomphant-v2`), mêmes comptes, même façon de se connecter.
Elle a sa **propre identité visuelle** : graphite chaud, ambre, ruban de balisage, polices Space Grotesk / IBM Plex.

## Ce qu'elle fait
| Page | Rôle |
|---|---|
| Vue d'ensemble | valeur du stock, stock bas, stock négatif, livraisons à vérifier |
| Stock par agence | quantités par agence (ou toutes), valeur au prix d'achat, export CSV |
| Articles | liste des articles **TMMB** (lecture seule) + prix d'achat et seuil d'alerte propres au stock |
| Entrées fournisseurs | réception de marchandise dans une agence, avec prix d'achat ; historique par période avec total des achats ; **l'admin peut corriger le prix d'une ligne** (motif obligatoire, ancien prix conservé, quantité et stock inchangés) |
| Transferts | d'une agence à une autre (refusé si le stock de départ est insuffisant) |
| Inventaires | inventaire de départ, puis inventaires périodiques avec écarts |
| Livraisons TMMB | livraisons déduites du stock, et celles à vérifier |
| Mouvements & rapports | synthèse par article sur une période, détail, export CSV |
| Réglages (admin) | jour J |

Accès : **admin** et **gestionnaire de stock** uniquement (comptes TMMB existants).

## Indépendance vis-à-vis de TMMB
- L'application **n'écrit jamais** dans les collections de TMMB : elle lit seulement
  `articles`, `agences`, `commerciaux`, `produits`, `livraisons` et `clients`.
- Tout ce qu'elle enregistre va dans des collections nouvelles, préfixées `stk_` :
  `stk_stock`, `stk_articles`, `stk_mouvements`, `stk_inventaires`, `stk_livTraitees`, `stk_config`.
- Le stock de TMMB (`stockAgences`, `stockMvts`) n'est ni lu ni modifié : les deux suivis sont séparés.
- Les pages stock de TMMB restent inchangées.

## Prix d'achat
- Chaque entrée enregistre le prix payé **ligne par ligne** : un même article peut avoir des prix différents d'une entrée à l'autre.
- Le prix « actuel » d'un article (valeur du stock) = celui de l'entrée **la plus récente par date** ;
  une entrée saisie en retard avec une date plus ancienne ne l'écrase pas.
- **Correction (admin)** : Entrées fournisseurs → Entrées enregistrées → « ✏️ Prix ». Le montant de l'entrée
  et les rapports d'achats sont recalculés ; si l'entrée corrigée est celle qui a fixé le prix actuel, il est corrigé aussi.
  Les règles Firestore n'autorisent à modifier **que le prix** (jamais la quantité) et seulement pour l'admin.

## Livraisons TMMB
À l'ouverture de l'application (et avec « 🔄 Relire les livraisons ») :
- seules les livraisons **datées du jour J ou après** et au statut « livré » sont prises en compte ;
- le stock de **l'agence du client** baisse selon la composition **figée sur la livraison**
  (même règle que TMMB : agence du client, sinon de son commercial, sinon du commercial de la livraison) ;
- chaque livraison est déduite **une seule fois**, même si deux personnes ouvrent l'application en même temps ;
- après la première lecture, seules les livraisons créées ou modifiées depuis la dernière lecture sont relues ;
- **à vérifier** (rien n'est déduit automatiquement) : livraison partielle, produit sans composition,
  agence introuvable, article inconnu, ou livraison annulée dans TMMB **après** la sortie de stock
  (bouton « Remettre en stock » ou « Garder la sortie »).

⚠️ C'est la **date de la livraison** dans TMMB qui compte, pas le jour où elle a été marquée livrée.
⚠️ Si personne n'ouvre l'application, le stock n'est pas mis à jour (choix « à l'ouverture » plutôt que Cloud Function).

## Mise en service
1. **Règles Firestore** (obligatoire, sinon tout est refusé) — voir `REGLES-FIRESTORE-stock.txt`.
   Le fichier `regles-tmmb/firestore.rules` est votre fichier TMMB v78 avec le bloc stock ajouté
   (rien d'autre n'a changé). Dans le dossier du dépôt TMMB :
   ```
   firebase deploy --only firestore:rules
   ```
2. **Publier** ce dossier sur un nouveau dépôt GitHub (sans le dossier `regles-tmmb`),
   avec GitHub Pages, comme la comptabilité. Pour un sous-domaine, ajoutez un fichier `CNAME`
   (je ne l'ai pas créé : le nom du sous-domaine n'a pas été choisi).
3. **Clé API** : si la clé web Firebase est limitée à certains sites dans Google Cloud
   (Identifiants → clé → restrictions HTTP), ajoutez la nouvelle adresse. À vérifier.
4. **Première utilisation, dans cet ordre** :
   1. Articles : régler les prix d'achat et seuils (facultatif, la valeur TMMB sert par défaut).
   2. Inventaires : **inventaire de départ** de chaque agence (case vide = 0).
   3. Réglages : fixer le **jour J**.
   Conseil : comptez le stock **avant** les livraisons du jour J (le matin), ou choisissez comme
   jour J le lendemain de l'inventaire. Sinon, une livraison faite avant le comptage serait
   retirée deux fois (une fois physiquement, une fois par l'application).

## Lectures Firestore
À chaque ouverture : articles + agences + commerciaux + `stk_stock` + `stk_articles`
+ inventaires + livraisons à vérifier, puis les livraisons **nouvelles ou modifiées** seulement.
Les mouvements et l'historique ne sont lus qu'à la demande, sur la période choisie.

## Fichiers
| Fichier | Rôle |
|---|---|
| `index.html` | pages et fenêtres |
| `app.js` | utilitaires (échappement, formats, CSV) |
| `app-firebase.js` | connexion, chargement, opérations, livraisons, rapports |
| `stock-logic.js` | règles de calcul pures (testées) |
| `style.css` | mise en page reprise de la comptabilité, **couleurs et polices propres au stock** |
| `stock.css` | identité du module (ruban, logo S, étiquettes de référence) et compléments |
| `manifest.json`, `icons/` | installation en PWA (nouveau logo TMMB) |
| `tests/test-logic.mjs` | tests des règles de calcul : `node tests/test-logic.mjs` |

## Vérifications faites
- 22 tests des règles de calcul : OK.
- Parcours complet dans Chrome avec une base Firebase **simulée** (43 contrôles OK, aucune erreur JavaScript) :
  refus d'un commercial, inventaire de départ et périodique, jour J, déductions, pas de double
  déduction à la réouverture, lecture incrémentale, annulation et réintégration, entrées, transferts,
  coupure réseau (rien d'écrit), article en double refusé, aucune écriture dans les collections TMMB,
  correction de prix par l'admin (motif obligatoire, quantité intouchable, gestionnaire sans accès),
  entrée datée plus tôt sans effet sur le prix actuel, affichage mobile.
- **Non testé** sur le vrai Firebase ni avec l'émulateur de règles (téléchargement bloqué dans
  mon environnement) : les règles `stk_` sont à vérifier après publication, par exemple avec une
  petite entrée de test.
