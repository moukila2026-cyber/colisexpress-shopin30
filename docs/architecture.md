# Architecture technique (après migration Firebase → Neon)

## Pourquoi Neon

Firebase (Auth + Firestore) imposait ses règles de sécurité côté service et
bloquait l'enregistrement des colis (`permission-denied`). Neon fournit une base
**PostgreSQL** standard : la logique revient entièrement dans le code, testable
en local.

## Pièces du système

```text
Navigateur  ── fetch /api/* ──►  lib/app.js (Express)
                                    │  sessions : cookie signé (lib/auth.js)
                                    │  autorisations + logique métier
                                    │  js/metier-colis.js (partagé avec l'UI)
                                    ▼
                              db/db.js ──►  Neon (DATABASE_URL)  [production]
                                        └►  PGlite (mémoire)     [démo/tests]
```

- **Frontend** (`js/`) : modules ES sans dépendance externe, `js/api.js` est le
  seul point de contact réseau. Les pages rafraîchissent leurs données
  périodiquement (15–20 s) à la place des anciens abonnements temps réel.
- **API** (`lib/app.js`) : routes `/api/*`. Toutes les anciennes règles
  Firestore sont réécrites comme des contrôles serveur.
- **Métier** (`js/metier-colis.js`) : inchangé, importé **à la fois** par le
  navigateur et par le serveur — une seule source de vérité. Idem pour
  `js/metier-tarifs.js` (LOT 2), `js/metier-bordereau.js`,
  `js/metier-incidents.js` et `js/metier-alertes.js` (LOT 4).
- **Photos de preuve** (`lib/photos.js`) : le stockage objet est isolé derrière
  `stockerObjet()` / `lireObjet()` — Vercel Blob si `BLOB_READ_WRITE_TOKEN`
  est défini, sinon disque local (`PHOTOS_DIR`, défaut `uploads/photos`).
  Aucun base64 géant en base : `photos` ne stocke que la clé et les métadonnées.
- **Base** (`db/schema.sql`) : `agencies`, `parcels`, `agents` (LOT 1),
  `tarifs`, `encaissements`, `caisse_closures` (LOT 2), `clients` (LOT 3),
  `bordereaux`, `photos`, `incidents` + colonnes `bordereau_id`/`retour_*`
  sur `parcels` (LOT 4).

### `agencies`

| colonne | rôle |
|---|---|
| `id` | identifiant (UUID) |
| `email`, `password_hash` | connexion du **gérant** (scrypt) — le compte agence EST le gérant |
| `name`, `city`, `phone` | profil public de l'agence |

### `agents` (LOT 1 — comptes agents)

| colonne | rôle |
|---|---|
| `id` | identifiant (UUID) |
| `agency_id` | agence propriétaire (1 agence = N agents) |
| `name`, `email`, `phone` | identité de l'agent ; `email` UNIQUE au réseau (connexion) |
| `password_hash` | mot de passe scrypt propre à l'agent |
| `role` | `agent` (le gérant n'a pas de ligne : c'est le compte `agencies`) |
| `active` | un agent désactivé ne peut plus se connecter et sa session expire |

### `tarifs`, `encaissements`, `caisse_closures` (LOT 2)

| table | rôle |
|---|---|
| `tarifs` | grille d'une agence : `origin_city` × `destination_city` ( `''` = toutes destinations) × tranche `[weight_min_kg ; weight_max_kg[` → `price_fcfa` ; sortie de grille par `active = FALSE` (**jamais de suppression**) |
| `parcels.payment_status` / `paid_amount_fcfa` | état de paiement du colis (`paye` / `partiel` / `arrivee` / `regle` ; NULL = colis antérieur) et cumul encaissé |
| `encaissements` | journal de caisse : montant, mode (`especes` / `mobile_money`), `date_key` (Afrique/Abidjan), agent acteur — alimenté à l'enregistrement et à chaque encaissement du solde |
| `caisse_closures` | clôture : total compté par l'agent vs total calculé, écart conservé, UNIQUE (agence, jour) |

**Prix (autorité serveur).** `POST /api/colis` recalcule les options avec
`optionsPrix()` (`js/metier-tarifs.js`, partagé client/serveur) depuis la
grille de l'agence connectée ; si une ligne s'applique, c'est **son** prix qui
est enregistré (le menu déroulant côté client n'est qu'un affichage), sinon la
saisie libre est acceptée. `validerPaiement()` contrôle l'état saisi ; le
premier versement crée la ligne `encaissements` associée.

**Routes du LOT 2.** `GET/POST /api/tarifs` (segments simples),
`PATCH /api/tarifs/:id`, `POST /api/colis/:id/encaisser`,
`GET /api/caisse`, `POST /api/caisse/cloture` — les trois formes imbriquées
ont leur fichier dans `api/` (verrouillé par `npm test`), lecture/écriture
réservées aux agences concernées, écritures de grille au gérant.

### `clients` (LOT 3 — carnet de clients)

| colonne | rôle |
|---|---|
| `agency_id` | agence propriétaire : le carnet est **privé**, jamais de visibilité croisée |
| `kind` | `expediteur` ou `destinataire` (la CNI n'est mémorisée que pour un expéditeur) |
| `first_name`, `last_name`, `phone`, `cni`, `city`, `notes` | fiche client ; `phone` ivoirien normalisé = clé de recherche au guichet |
| UNIQUE (`agency_id`, `kind`, `phone`) | la mémorisation automatique est un **upsert** : jamais de doublon, une CNI déjà renseignée n'est pas effacée |

**Mémorisation automatique.** `POST /api/colis` upserte l'expéditeur (avec
CNI, ville de départ) et le destinataire (ville d'arrivée) dans le carnet de
l'agence expéditrice (`clientsDepuisColis()` partagé) ; un échec de
mémorisation ne bloque jamais l'enregistrement du colis. Aucune route de
suppression : le carnet est la mémoire de l'agence.

**Routes du LOT 3.** `GET/POST /api/clients`, `GET/PATCH /api/clients/:id`
(fichier `api/clients/[id].js`) réservés à l'agence propriétaire ;
`GET /api/clients/:id` renvoie aussi l'**historique des colis** du client
(colis de l'agence dont l'expéditeur ou le destinataire porte ce téléphone).
`POST /api/devis` est **public et anonyme** : il agrège les grilles actives
(`tarifs` JOIN `agencies`), calcule les offres via `estimerDevis()`
(`js/metier-tarifs.js`, partagé) et ne renvoie que prix, tranche et
coordonnées professionnelles des agences — jamais d'identifiant interne,
d'e-mail ni de donnée personnelle.

### `parcels`

Tous les anciens documents `colis` + `suivis` fusionnés : le suivi public est
**calculé** par `GET /api/suivi/:code` (7 champs, aucune donnée personnelle) —
plus de duplication à maintenir cohérente. Contraintes : `tracking_code` UNIQUE,
`owner_id` et `destination_agency_id` référencent `agencies`. LOT 4 :
`bordereau_id` (écrit uniquement par la transaction qui crée le bordereau),
`retour_status`/`retour_started_at`/`retour_completed_at` (retour à
l'expéditeur) — les 5 statuts officiels du colis ne changent jamais.

### `bordereaux`, `photos`, `incidents` (LOT 4 — chaîne de preuve)

- **`bordereaux`** : lot de 1 à 200 colis (`bordereau_parcels`, PK
  `(bordereau_id, parcel_id)`) partis ensemble. `code` UNIQUE `BDR-XXXXXX`,
  transporteur (`carrier_name`, `carrier_phone`, `vehicle_ref`), statuts
  `Préparé → Remis → En route → Arrivé → Contrôlé/Écart`
  (`js/metier-bordereau.js`). Émargements verrouillés par acteur : remise et
  départ = agence émettrice ; arrivée et contrôle = agence de destination
  (ou émettrice si rien n'est rattaché). La remise expédie les colis
  (`Enregistré → Expédié`), le départ les met `En transit`, le contrôle
  confirme les présents (`→ Arrivé`) et chaque absent ouvre un incident
  `perdu` automatique. Suivi public `bordereau.html?code=BDR-…`
  (`GET /api/suivi-bordereau/:code`) : ni téléphone du transporteur, ni
  identité des clients — liste des codes de suivi et présence après contrôle.
- **`photos`** : 2 max par étape (`prise_en_charge` = expéditeur, `arrivee` =
  destination), compressées côté navigateur (`js/photos.js`, ~200 Ko),
  `image/*` seulement. Contenu **jamais public** : uniquement
  `GET /api/photos/:id` authentifié (les deux agences concernées), aucune
  route de suppression — la preuve est immuable.
- **`incidents`** : état latéral du colis (`perdu`, `endommage`, `retard`,
  `conteste`, `bloque`) avec cycle `ouvert → recherches → resolu`
  (`js/metier-incidents.js`). Visible par les deux agences ; un seul incident
  non résolu à la fois ; résolu = immuable. Le public ne voit qu'un bandeau
  sobre (« Une vérification est en cours sur ce colis. »). Escalade :
  `alerte24h` (ouvert > 24 h, les deux agences) puis `filePlateforme`
  (> 7 j, file plateforme — lot 6).
- **Souffrance + retour** : `GET /api/souffrance` liste les colis
  « Arrivé non retiré depuis > 7 jours » (`estEnSouffrance()`,
  `js/metier-alertes.js`) ; `POST /api/colis/:id/retour`
  (`etape: decider` par l'agence détentrice, `recevoir` par l'expéditrice)
  trace un nouveau trajet dans l'historique ; les frais de magasinage
  éventuels alimentent la caisse du jour avec le label
  « Frais de magasinage ».
- **Alertes** : `GET /api/alertes` groupe par signal les « colis qui dorment »
  (`sans_mouvement` > 48 h, `non_retire` > 72 h, `non_rattache` > 7 j,
  `souffrance` > 7 j) — cartes « À traiter » du tableau de bord.

## Autorisations (ex-`firestore.rules`)

| Ancienne règle Firestore | Équivalent serveur |
|---|---|
| `ownerId == request.auth.uid` | session → `owner_id = $session` |
| lecture réservée à owner/destination | `WHERE owner_id = $1 OR destination_agency_id = $1` |
| rattachement : owner, une fois, agence inscrite | `peutRattacher()` + `agences` EXISTS + `destination_agency_id IS NULL` |
| progression par étapes | `prochaineEtape()` (le serveur calcule le statut suivant) |
| suivi public `hasOnly(7 clés)` | projection SQL explicite |
| `allow delete: if false` | aucune route DELETE (photos/incidents inclus : preuve immuable) |
| bordereau : émarger selon son rôle | `peutControler()` / acteur imposé côté serveur (remise = émetteur, arrivée/contrôle = destinataire) |
| photos jamais publiques | `GET /api/photos/:id` exige une session des deux agences concernées ; clé de stockage jamais renvoyée |
| incidents visibles aux deux bouts | `WHERE owner_id = $1 OR destination_agency_id = $1` |

## Sessions

- `POST /api/register` et `/api/login` posent `ce_session` : cookie `HttpOnly`,
  `SameSite=Lax`, `Secure` en production, contenant `payload.signature`
  (HMAC-SHA256 de `SESSION_SECRET`, expiration 30 jours).
- La charge contient `id` (= agence) et, pour un agent, `agent` (= id agent).
  `requireAgency` recharge le membre : agent absent/inactif → 401 et cookie
  effacé — un agent désactivé par le gérant perd son accès immédiatement.
  Le gérant n'a pas de ligne `agents` : il EST le compte `agencies`.
- Aucun jeton n'est stocké en base : la révocation se fait par expiration ou
  rotation de `SESSION_SECRET`.

## Traçabilité de l'acteur (LOT 1)

- Chaque écriture d'étape (enregistrement, rattachement, progression) ajoute
  `actorId` / `actorName` à l'étape d'historique (`champsActeur()` partagé
  client/serveur) ; la fiche colis affiche « Par <agent> ».
- Le suivi public projette chaque étape via `etapePublique()` : ni `actorId`
  ni `actorName` ne sortent — aucune donnée personnelle côté anonyme.
- Écritures d'équipe (`POST/PATCH /api/agents`) : `requireGerant` appliqué
  côté serveur, jamais seulement dans l'interface.

## Tests

`npm test` exécute la suite sur PGlite : mêmes requêtes SQL que Neon, aucune
configuration requise. `tests/api.test.mjs` rejoue les parcours complets
(inscription, colis inscrit/non inscrite, rattachement unique, progression,
suivi public anonyme, refus d'accès ; LOT 4 : bordereau de bout en bout avec
écart → incident automatique, destination non rattachée, incidents et
escalade, photos de preuve, souffrance + retour + frais de magasinage,
alertes). Les règles pures sont testées dans `tests/metier-*.test.mjs` et le
câblage Vercel dans `tests/integration-page.test.mjs`.

## Déploiement

- **Vercel** : les fichiers de `api/` exportent l'app Express, le reste est
  statique. Variables : `DATABASE_URL`, `SESSION_SECRET`, et pour les photos
  `BLOB_READ_WRITE_TOKEN` (Vercel Blob ; à défaut `PHOTOS_DIR` sur disque
  local). Hors Next.js,
  Vercel convertit tout segment entre crochets en `([^/]+)` (un seul
  segment d'URL, pas de catch-all multi-segments) : `api/[...path].js`
  couvre les routes à un segment (`/api/health`, `/api/colis`…), et chaque
  route à deux segments a son fichier (`api/colis/[id].js`,
  `api/suivi/[code].js`, `api/clients/[id].js`, `api/photos/[id].js`…) —
  sinon elle renvoie le 404 NOT_FOUND de la plateforme au lieu d'atteindre
  Express.
  Le plan **Hobby limite un déploiement à 12 fonctions serverless** : les
  routes à trois segments (`/api/colis/:id/attach`,
  `/api/bordereaux/:id/remettre`, `/api/caisse/cloture`…) n'ont donc PAS
  chacune leur fichier. Elles sont repliées par les `rewrites` de
  `vercel.json` sur la fonction de leur route parente avec l'action en
  paramètre (`/api/colis/:id/:action → /api/colis/:id?action=:action`), et le
  premier middleware de `lib/app.js` redéplie l'URL réelle avant le routage
  Express — les URL publiques, le frontend et les tests ne changent pas.
  Toute nouvelle route à trois segments doit passer par ce mécanisme ;
  `npm test` verrouille les points d'entrée, les rewrites et le compte de
  fonctions (≤ 12).
- **Autre hébergeur Node** : `npm start` sert API + fichiers statiques
  (`server.js`).
