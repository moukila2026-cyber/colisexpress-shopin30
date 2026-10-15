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
  navigateur et par le serveur — une seule source de vérité.
- **Base** (`db/schema.sql`) : `agencies`, `parcels`, `agents` (LOT 1),
  `tarifs`, `encaissements`, `caisse_closures` (LOT 2).

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

### `parcels`

Tous les anciens documents `colis` + `suivis` fusionnés : le suivi public est
**calculé** par `GET /api/suivi/:code` (7 champs, aucune donnée personnelle) —
plus de duplication à maintenir cohérente. Contraintes : `tracking_code` UNIQUE,
`owner_id` et `destination_agency_id` référencent `agencies`.

## Autorisations (ex-`firestore.rules`)

| Ancienne règle Firestore | Équivalent serveur |
|---|---|
| `ownerId == request.auth.uid` | session → `owner_id = $session` |
| lecture réservée à owner/destination | `WHERE owner_id = $1 OR destination_agency_id = $1` |
| rattachement : owner, une fois, agence inscrite | `peutRattacher()` + `agences` EXISTS + `destination_agency_id IS NULL` |
| progression par étapes | `prochaineEtape()` (le serveur calcule le statut suivant) |
| suivi public `hasOnly(7 clés)` | projection SQL explicite |
| `allow delete: if false` | aucune route DELETE |

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
suivi public anonyme, refus d'accès).

## Déploiement

- **Vercel** : les fichiers de `api/` exportent l'app Express, le reste est
  statique. Variables : `DATABASE_URL`, `SESSION_SECRET`. Hors Next.js,
  Vercel convertit tout segment entre crochets en `([^/]+)` (un seul
  segment d'URL, pas de catch-all multi-segments) : `api/[...path].js`
  couvre les routes à un segment (`/api/health`, `/api/colis`…), et chaque
  route imbriquée a son fichier (`api/colis/[id].js`,
  `api/colis/[id]/attach.js`, `api/colis/[id]/progress.js`,
  `api/suivi/[code].js`) — sinon elle renvoie le 404 NOT_FOUND de la
  plateforme au lieu d'atteindre Express. Toute nouvelle route imbriquée
  doit recevoir son point d'entrée (verrouillé par `npm test`).
- **Autre hébergeur Node** : `npm start` sert API + fichiers statiques
  (`server.js`).
