# COLIS EXPRESS — note stratégique : réduire la perte et le « on ne sait plus où est le colis »

Objectif de ce document : partir des **problèmes réels d'une agence de colis en Côte d'Ivoire** (guichet, transporteur
interurbain, agence de destination, retrait au comptoir) et lister les évolutions de l'outil qui les traitent, priorisées
par impact sur la perte de colis et effort de réalisation.

Méthode : chaque idée est décrite en trois lignes — *problème de terrain*, *ce que ferait l'outil*, *impact sur la perte*.
Rien ici n'impose un framework ou un backend : tout reste compatible avec l'API Node + Postgres (Neon) du dépôt.

---

## 1. Ce que l'outil couvre déjà

| Chaîne | Aujourd'hui |
| --- | --- |
| Prise en charge | Formulaire complet (expéditeur + CNI, destinataire, nature, poids, prix), reçu avec QR code, partage WhatsApp |
| Identifiant | Code unique `CLI-XXXXXX`, non collidable (contrôle d'unicité avant écriture) |
| Progression | 5 étapes verrouillées par rôle : `Enregistré → Expédié → En transit → Arrivé à l'agence de destination → Retiré` |
| Preuve de retrait | Nom + numéro CNI de la personne qui récupère, conservés côté privé |
| Ouverture du réseau | Enregistrement possible vers une **agence non inscrite** (nom, ville, téléphone), rattachement ensuite par l'expéditeur |
| Cloisonnement | Suivi public sans donnée personnelle, écriture contrainte par l'API à rester fidèle au colis privé |
| Temps réel | `onSnapshot` partout : l'agence et le client voient la mise à jour sans rafraîchir |

**Ce qui manque pour la majorité des pertes :** tout ce qui se passe **entre deux agences** (le bag, le car, le dépotage),
la **preuve physique** (photos), l'**identité du saisisseur** (compte agence partagé), le **fonctionnement sans réseau**,
et l'**alerte quand un colis ne bouge plus**.

---

## 2. Les 10 problèmes terrain qui produisent les pertes

1. **Le colis quitte l'agence A sans bordereau.** Il part dans le porte-bagages du bus avec 40 autres ; à l'arrivée, personne
   ne peut dire lesquels manquaient. La perte est découverte 3 semaines plus tard, quand le client revient.
2. **La remise au transporteur n'est signée par personne.** Aucun horodatage, aucun nom de chauffeur, aucun immatricule.
   En cas de litige, chaque partie dit « je l'ai donné / je ne l'ai jamais reçu ».
3. **Le code est recopié à la main.** Une lettre confondue (`O`/`0`, `I`/`1`) et le suivi public renvoie « introuvable ».
   Le colis n'est pas perdu : **il est injoignable**.
4. **Beaucoup de colis ne sont jamais saisis** au moment où ils partent (guichet chargé, réseau coupé, panne de courant).
   Ce qui n'est pas dans le système est perdu par définition.
5. **L'agence de destination n'a pas de compte** (ou change de nom, de gérant, de numéro). Le colis arrive dans un lieu
   que le système ne sait pas notifier — c'est précisément le trou que le rattachement vient combler.
6. **Le retrait est fait à une mauvaise personne** (nom commun, tiers non autorisé, CNI présentée de confiance).
7. **Personne n'alerte quand un colis dort.** Aucun signal « sans mouvement depuis 48 h » ; le suivi est consulté quand le
   client réclame, jamais avant.
8. **Un compte agence = un mot de passe partagé** entre trois personnes. L'historique ne dit pas *qui* a fait l'étape :
   impossible de corriger la formation ou d'identifier une omission.
9. **Les litiges se règlent en WhatsApp**, sans trace : « le carton était écrasé », « il manquait deux pièces ».
10. **Le recouvrement et la compta** (frais payés, reste à payer à l'arrivée, ce que l'agence B doit à l'agence A) se font
    sur cahier — donc les colis « oubliés » ne deviennent jamais une ligne d'alerte.

---

## 3. Chantiers priorisés

Impact : effet direct sur la perte / le temps de résolution. Effort : jours-développeur à deux, sur la base du code actuel.

### P0 — ce qui arrête l'hémorragie

| # | Fonctionnalité | Impact | Effort | Ce que ça change |
| --- | --- | --- | --- | --- |
| 1 | **Bordereau d'acheminement** (regrouper des colis en un « bag » avec accusé de réception à chaque bout) | ★★★★★ | 5 j | Une perte devient une *ligne manquante* détectée le jour même, pas dans 3 semaines |
| 2 | **Photos à la prise en charge et à l'arrivée** | ★★★★☆ | 3 j | Fin des litiges sur le contenu/l'état ; preuve horodatée de la chaîne |
| 3 | **Scanner au lieu de recopier** (QR sur étiquette, caméra du téléphone) | ★★★★☆ | 3 j | Supprime les « introuvables » dus au code mal saisi |
| 4 | **Signalement d'incident** (perdu / endommagé / bloqué) avec escalade | ★★★★★ | 3 j | Un incident devient un objet suivi, avec délai de résolution mesurable |
| 5 | **Colis qui dorment : alertes automatiques** (48 h sans mouvement, 72 h non retiré) | ★★★★★ | 4 j | L'agence agit avant la réclamation du client |
| 6 | **Mode hors-ligne + file de rejeu** | ★★★★☆ | 5 j | Le guichet enregistre même sans réseau ; plus de colis non saisis |
| 7 | **Comptes agents rattachés à une agence** | ★★★☆☆ | 4 j | Traçabilité individuelle : on sait qui a oublié une étape |

### P1 — fiabilité du retrait et de la destination

| # | Fonctionnalité | Impact | Effort |
| --- | --- | --- | --- |
| 8 | **Code de retrait à 4 chiffres (OTP WhatsApp)** exigé pour clôturer | ★★★★★ | 4 j |
| 9 | **Contrôle d'arrivée par liste de contrôle** (cases à cocher sur le bordereau reçu) | ★★★★☆ | 2 j |
| 10 | **Correction / remplacement d'un rattachement sur validation plateforme** | ★★★☆☆ | 3 j |
| 11 | **Annuaire public des agences** (ville, quartier, horaires, fiabilité constatée) | ★★★☆☆ | 3 j |
| 12 | **Relance WhatsApp du client à chaque étape** (envoi automatique côté Cloud Function) | ★★★☆☆ | 3 j |
| 13 | **Recherche par téléphone / CNI / plage de dates + export CSV** | ★★★☆☆ | 2 j |

### P2 — pilotage et argent

| # | Fonctionnalité | Impact | Effort |
| --- | --- | --- | --- |
| 14 | **Reste à payer à l'arrivée (COD) + encaissement** | ★★★☆☆ | 3 j |
| 15 | **Solde inter-agences** (ce que B doit à A) et relevé mensuel | ★★☆☆☆ | 4 j |
| 16 | **Statistiques d'axe** : délai médian, taux de colis > 72 h, litiges / 1 000 | ★★★☆☆ | 3 j |
| 17 | **Console plateforme** : valider une agence, bloquer un compte, arbitrer un litige, journal d'audit | ★★★★☆ | 6 j |
| 18 | **Étiquettes thermiques / A4 imprimables** | ★★☆☆☆ | 2 j |
| 19 | **Purge / anonymisation conforme CNDP** des CNI après délai | ★★★☆☆ | 3 j |
| 20 | **Multi-langue (dioula, baoulé, wolof…)** et dictée vocale au guichet | ★★☆☆☆ | 3 j |

---

## 4. Spécifications des 6 chantiers structurants

### 4.1 Bordereau d'acheminement (« bag ») — la priorité n° 1

**Problème.** La perte a presque toujours lieu *entre* deux agences, et l'unité suivie (le colis) est trop fine pour
être contrôlée dans un porte-bagages.

**Principe.** On introduit un conteneur logique, le **bordereau**, que le transporteur émarge. Le colis n'est plus
seul dans la nature : il appartient à un lot qui a un accusé de réception.

```js
// bordereaux/{bordereauId}
{
  id, code: "BDR-A7K2F9",
  fromAgencyId, toAgencyId,            // comptes inscrits ; à terme : toAgencyId peut être null + déclaration
  carrierName, carrierPhone, vehicleRef,   // « Gbala Transport », « CI-1234-AB », « car Korhogo 11 h »
  parcelIds: [ "…", "…" ],             // 1 à 200
  status: "Préparé" | "Remis" | "En route" | "Arrivé" | "Contrôlé" | "Écart",
  handedOverAt/By, arrivedAt/By, checkedAt/By,
  missingParcelIds: [ "…" ],           // colis déclarés absents au contrôle d'arrivée
  createdAtISO
}
// suivis-bordereaux/{code}  → { code, bordereauId, status, parcelCount, cities, lastUpdatedAtISO }
```

**Parcours.**
1. Agence A : « Bordereau » → sélection de colis `Enregistré`/`Expédié` (multi-sélection depuis le tableau de bord,
   filtres ville + agence de destination) → imprimés/recopiés → **Remis au transporteur** (nom, téléphone, plaque).
2. Le transporteur reçoit un lien public `bordereau.html?code=BDR-…` : il voit la liste, sans donnée personnelle.
3. Agence B (ou l'expéditeur si l'agence est hors réseau, même logique que pour le rattachement) : **Contrôle d'arrivée**
   → la liste s'affiche en cases à cocher ; ce qui manque se coche « absent » → `status: "Écart"`.
4. Un écart crée **automatiquement un incident** (4.3) sur chaque colis manquant, visible chez A et chez B, avec le
   bordereau en preuve.

**Règles d'accès (API).** `bordereaux/{id}` : création par l'agence émettrice, lecture aux deux agences, mise à jour limitée (contrôles dans `lib/app.js`)
aux champs d'émargement ; `fromAgencyId`/`parcelIds` immuables après remise ; un colis ne peut être ajouté à un
bordereau que par son agence expéditrice, et `bordereauId` ne peut être écrit que par la même transaction qui crée
l'entrée d'historique. Aucun `delete`.

**Effet mesurable.** Temps de détection d'une perte : de *plusieurs semaines* (plainte client) à *le jour même*
(contrôle de dépotage). C'est le changement au plus fort rendement de toute la note.

### 4.2 Photos à la prise en charge et à l'arrivée

Stockage de fichiers (ex. Neon + object storage), accès limité aux deux agences, aucune lecture publique.

```js
colis.photoRefs: { intake: ["colis/{id}/photos/prise-en-charge-1.jpg"], arrival: [...] }
```

- 2 photos max par étape, compressées côté navigateur (`canvas` → 1 024 px, ~200 Ko) — important sur réseau 3G.
- Prise en charge : contenu ouvert + état de l'emballage. Arrivée : colis tel que reçu sur le quai.
- Retrait : la photo du **bordereau/lettre de voiture signée** quand il y en a une.
- Les règles d'écriture : upload autorisé seulement au propriétaire, taille < 2 Mo, type `image/*`,
  et suppression interdite (les photos font partie de la preuve, purge pilotée par la plateforme).

C'est ce qui transforme un « je n'ai jamais reçu ce colis » en constat objectif en 30 secondes.

### 4.3 Incidents et escalade

**Ne pas** ajouter « Perdu » dans la chaîne de statut : un colis peut être perdu puis retrouvé, et un statut de la chaîne
se substitue à l'autre (perte d'information dans le suivi public). On ajoute un **état latéral**.

```js
colis.incident: {
  type: "perdu" | "endommage" | "retard" | "conteste" | "bloque",
  note, openedBy, openedAtISO, agencyId,
  state: "ouvert" | "recherches" | "resolu" | "indemnite",
  resolvedAtISO, resolution
}
```

- Le suivi public affiche un bandeau sobre (« une vérification est en cours sur ce colis ») sans les détails privés.
- Minuterie d'escalade : ouvert > 24 h → rappel aux deux agences ; > 7 jours → file d'arbitrage plateforme.
- Un incident résolu reste dans l'historique et alimente le taux de litige de l'axe (4.6).

### 4.4 Alertes de colis qui dorment

Trois signaux, calculables **sans backend** dans un premier temps (le dashboard les affiche ; une Cloud Function les enverra
ensuite par WhatsApp/e-mail) :

| Signal | Règle | Action proposée |
| --- | --- | --- |
| Sans mouvement | `En transit`/`Expédié` et `updatedAt` > 48 h | « Relancer le transporteur » (message WhatsApp pré-rempli au numéro du bordereau) |
| Non retiré | `Arrivé à l'agence de destination` > 72 h | Rappel automatique au destinataire (message + lien de suivi) |
| Non rattaché | `destinationAgencyId == null` > 7 jours | Relance de l'agence de destination pour qu'elle crée son compte (message pré-rempli) |

Un macarton rouge sur la ligne du colis + une carte « À traiter » en haut du tableau de bord. Le principe : **le système
doit appeler l'agence, pas l'inverse.**

### 4.5 Scannner, étiquette, et fin de la recopie

- **Étiquette** imprimable (A4 4-up ou 100 × 150 mm thermique) : code `CLI-…` en grand, QR du lien de suivi, origine →
  destination, agence de retrait, date limite de retrait.
- **Scanner** dans le navigateur : `BarcodeDetector` quand il est disponible, repli sur une lib légère type `zxing-wasm`
  (~250 Ko, chargée à la demande). Trois usages : saisir le code au lieu de le taper, cocher une liste de bordereau,
  pointer un colis au comptoir.
- Alphabet du code déjà adapté (sans `I`, `O`, `0`, `1` dans `generateTrackingCode`) : à confirmer pour garder la
  tolérance à la recopie tout en passant au scan.
- Ajout utile : tolérance de saisie sur le suivi public (minuscules, espaces, tiret absent, `0`↔`O`) → le colis
  « introuvable » redevient trouvable.

### 4.6 Traçabilité individuelle et statistiques d'axe

- `agences/{uid}.members: { [uidAgent]: { nom, role: "gerant|agent", active } }` + collection `membres/{uidAgent}`
  pointant sur l'agence ; chaque écriture d'étape enregistre `actorId`/`actorName`. Les règles acceptent l'écriture pour
  tout membre actif de l'agence propriétaire (lecture du document `membres` dans la règle, ou *custom claims* posés par
  une Cloud Function : plus économe en lectures).
- Statistiques par agence et par axe : délai médian bout-en-bout, taux de colis > 72 h, incidents / 1 000 colis,
  volume par jour, top destinations, taux de rattachement sous 7 jours. C'est ce qui fait accepter l'outil par un réseau :
  un chiffre par semaine, pas un logiciel de plus.

---

## 5. Feuille de route proposée

**Phase 1 — 2 semaines : fiabiliser la saisie réelle.**
Mode hors-ligne (file d'attente locale + rejeu des requêtes) · recherche par téléphone/CNI + export CSV ·
macaron « sans mouvement depuis 48 h » et cartes « À traiter » · tolérance de saisie du code dans le suivi public ·
comptes agents rattachés (sans changer l'UI existante).

**Phase 2 — 3 semaines : la chaîne de preuve.**
Bordereaux + contrôle d'arrivée + écarts automatiques · incidents et escalade · photos à la prise en charge et à
l'arrivée (Storage + règles) · étiquettes imprimables + scan.

**Phase 3 — 3 semaines : fermer la boucle client.**
OTP de retrait · rappels automatiques (Cloud Functions, WhatsApp/e-mail) · reste à payer à l'arrivée et solde
inter-agences · console plateforme (validation des agences, arbitrage de litige, purge CNDP).

Critère de sortie de la phase 2 : *« un colis manquant est détecté le jour même dans 95 % des cas »* — mesurable via la
date de création de l'incident moins la date d'arrivée du bordereau.

---

## 6. Garde-fous : ce qu'il ne faut pas faire

- **Ne pas affaiblir les contrôles de `lib/app.js` au fil de l'eau.** Chaque nouvelle ressource part du même socle : lecture aux seules
  agences concernées, écriture contrainte au propriétaire, pas de suppression, aucun champ personnel dans une collection publique.
- **Ne pas empiler les champs obligatoires au guichet.** Chaque champ requis en plus = moins de colis saisis = plus de colis
  invisibles. Exemple concret appliqué ici : le sélecteur d'agence de destination est devenu *optionnel* grâce à la saisie
  manuelle, au lieu de bloquer l'enregistrement.
- **Ne pas rendre le colis dépendant d'un compte inexistant.** Le rattachement doit rester une amélioration différée, jamais
  un prérequis ; c'est pourquoi l'expéditeur peut valider arrivée et retrait tant qu'aucune agence n'est rattachée.
- **Ne pas autoriser le changement d'agence de destination après rattachement en libre-service** : c'est la porte ouverte au
  détournement. Passer par un arbitrage plateforme (traçable).
- **Pas de suppression physique des colis ni des photos** : conservation, archivage, anonymisation.
- Ne pas reporter la preuve sur le client (une appli grand public = support, adoption, téléphone du client) : les photos et
  scans restent à la charge des agents, en deux gestes maximum.
- Un rattachement doit rester **unique et définitif** côté client ; la correction existe, mais validée par la plateforme.

---

## 7. Indicateurs à suivre dès la première semaine d'usage

| Indicateur | Cible à 3 mois | Pourquoi |
| --- | --- | --- |
| Colis enregistrés le jour même de la remise | > 95 % | mesure l'adoption réelle du guichet |
| Colis sans mouvement > 48 h | < 3 % | meilleur proxy de la perte |
| Écarts de bordereau détectés à l'arrivée | 100 % des écarts | prouve que le contrôle d'arrivée est fait |
| Délai médian enregistrement → retrait, par axe | -30 % | ce que le client final ressent |
| Retraits avec OTP + CNI | > 90 % | fin des remises indues |
| Agences de destination rattachées sous 7 jours | > 80 % | santé du réseau et du flux introduit ici |
| Litiges ouverts > 7 jours | 0 | crédibilité de l'escalade |
| Taux de saisie scannée vs recopiée | > 70 % | chute des codes erronés |

---

## 8. Ce que cette phase a déjà posé, et qui prépare la suite

- Une destination peut désormais être **déclarée sans compte** : c'est la condition pour que les bordereaux fonctionnent
  avec tout le réseau, y compris les points relais non numérisés.
- Le rattachement introduit une **écriture conditionnée par un état** (`destinationAgencyId == null` → `uid`), exactement le
  motif nécessaire pour l'émargement des bordereaux, la clôture des incidents et la validation d'un retrait par OTP.
- La logique de vérification est sortie du DOM dans `js/metier-colis.js` : les règles de progression, de garde et de
  rattachement sont désormais testables (`node --test`) — utile pour les évolutions de cette note, qui touchent toutes à
  la garde des écritures.
- Le contrat client ↔ API est couvert par les tests : ajouter une ressource (bordereaux, photos, incidents)
  se fera avec le même niveau de preuve.

## 9. Livrés : LOT 1 — comptes agents nommés (chantier 7 de la priorité P0)

La table `agents` (1 agence = N agents, gérant = compte agence existant) permet
la connexion par agent, l'activation/désactivation par le gérant (Paramètres >
Équipe) et la traçabilité `actorId`/`actorName` sur chaque écriture d'étape —
affichée « Par … » dans la fiche colis, **jamais** dans le suivi public
(projection `etapePublique()`). Contrôles serveur (`requireGerant`,
session agent invalidée à la désactivation), tests API + métier + intégrité
statique au vert.

## 10. Livré : LOT 2 — grille tarifaire, paiement et caisse (chantier 14 « reste
à payer (COD) + encaissement » de la priorité P2)

- **Grille tarifaire** (Paramètres > Tarifs, gérant) : axe ville départ →
  ville arrivée (ou « toutes destinations ») × tranche de poids → prix FCFA.
  Le prix du « nouveau colis » est **choisi dans un menu déroulant** alimenté
  par la grille (récapitulatif avant validation) ; le serveur **recalcule et
  impose** ce prix (`optionsPrix()` partagé) — saisie libre uniquement si la
  grille est vide ou non applicable (aucune régression pour les colis
  existants). Sortie de grille par désactivation, jamais de suppression.
- **État de paiement** à l'enregistrement : « Payé au départ », « Partiel »
  (montant + mode), « À payer à l'arrivée » ; encaissement du solde à la
  remise par l'agence concernée (« Encaisser le solde » sur la fiche colis).
- **Caisse du jour** par agence : encaissements journalisés (montant, mode,
  agent acteur), totaux espèces / mobile money, restes à encaisser, clôture
  avec total compté validé par l'agent (écart conservé, une par jour) et
  export CSV (date, code, expéditeur, destinataire, prix, payé, reste, mode,
  agent).
- Règles d'or respectées : la caisse et les encaissements n'existent que du
  côté des deux agences déjà concernées par le colis ; un impayé n'empêche ni
  la lecture ni l'avancement du colis.

## 11. Livré : LOT 3 — mémoire client + devis public

- **Carnet de clients** (table `clients`, page « Clients ») : expéditeurs et
  destinataires mémorisés **par agence** (nom, téléphone, CNI expéditeur,
  ville, note). La mémorisation est **automatique** à chaque enregistrement de
  colis (upsert sur (agence, rôle, téléphone) : jamais de doublon, une CNI
  déjà renseignée n'est jamais effacée), et possible à la main. Recherche par
  téléphone (même partiel, format libre) ou par nom ; fiche client avec
  **historique de ses colis** ; modification par PATCH ; **aucune
  suppression**. Cloisonnement strict : le carnet n'est visible que par
  l'agence propriétaire (garde serveur).
- **Pré-remplissage au guichet** : dans « Nouveau colis », la saisie d'un
  téléphone connu propose « Client connu : … · pré-remplir » (expéditeur :
  prénom, nom, CNI ; destinataire : prénom, nom) — le guichet ne ressaisit
  plus ce qu'il sait déjà.
- **Devis public** (page d'accueil, `POST /api/devis` anonyme) : ville départ,
  ville arrivée, poids, nature (facultative) → offres calculées depuis les
  grilles tarifaires **actives** des agences (`estimerDevis()` partagé, tri
  par prix croissant), chacune avec « Contacter l'agence » (WhatsApp
  pré-rempli). Aucune donnée personnelle demandée ni renvoyée (ni e-mail, ni
  identifiant interne). Axe non couvert = proposition de contact équipe,
  jamais d'erreur.

## 12. Livré : LOT 4 — chaîne de preuve (chantiers 1, 2, 4, 5, 9 + colis en
souffrance)

- **Bordereau d'acheminement** (pages « Bordereaux » + suivi public
  `bordereau.html?code=BDR-…`) : lot de 1 à 200 colis partis ensemble avec
  transporteur (nom, téléphone, véhicule/ligne) ; statuts
  `Préparé → Remis → En route → Arrivé → Contrôlé/Écart`. Émargements
  verrouillés par acteur : la remise au transporteur expédie les colis
  (`Enregistré → Expédié`), le départ les met `En transit`, l'arrivée et le
  **contrôle en cases à cocher** appartiennent à l'agence de destination (ou à
  l'expéditrice si rien n'est rattaché). Chaque colis absent ouvre
  **automatiquement un incident `perdu`** avec le bordereau en preuve ; les
  présents sont confirmés arrivés. Le suivi public du bordereau ne montre ni
  téléphone du transporteur ni identité des clients.
- **Photos de preuve** (prise en charge = expéditeur, arrivée = destination) :
  2 max par étape, compression navigateur ~200 Ko (`js/photos.js`), `image/*`
  seulement, **jamais publiques** (contenu servi uniquement par
  `GET /api/photos/:id` authentifié, aux deux agences concernées), **jamais
  supprimables**. Stockage objet isolé derrière `lib/photos.js` : Vercel Blob
  si `BLOB_READ_WRITE_TOKEN`, sinon disque local — aucun base64 géant en base.
- **Incidents et escalade** (chantiers 4 + 9) : état latéral du colis
  (`perdu`, `endommage`, `retard`, `conteste`, `bloque`) avec cycle
  `ouvert → recherches → resolu`, visible par les deux agences, un seul
  incident non résolu à la fois, résolu = immuable. Le public ne voit qu'un
  bandeau sobre (« Une vérification est en cours sur ce colis. »). Escalade :
  ouvert > 24 h = alerte aux deux agences (`alerte24h`) ; > 7 j = file
  plateforme (`filePlateforme`, traitement lot 6).
- **Colis en souffrance + retour à l'expéditeur** : liste « Arrivé non retiré
  depuis > 7 jours » (`GET /api/souffrance`) ; la destination **décide** le
  retour (frais de magasinage éventuels encaissés dans sa caisse du jour,
  label « Frais de magasinage »), l'expéditrice **reçoit** le colis — nouveau
  trajet tracé dans l'historique sans toucher aux 5 statuts officiels.
- **Alertes « colis qui dorment »** (chantier 5, tableau de bord) :
  `GET /api/alertes` groupe les cartes « À traiter » par signal — sans
  mouvement > 48 h, arrivé non retiré > 72 h, non rattaché > 7 j, en
  souffrance > 7 j.
- Règles d'or respectées : autorisations côté serveur uniquement, aucune route
  DELETE (la preuve est immuable), aucune donnée personnelle en public,
  migrations additives idempotentes, données de démo enrichies (2 bordereaux,
  2 incidents, 1 photo, 1 colis en souffrance).
