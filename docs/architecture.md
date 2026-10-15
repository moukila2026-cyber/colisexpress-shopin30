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
- **Base** (`db/schema.sql`) : deux tables.

### `agencies`

| colonne | rôle |
|---|---|
| `id` | identifiant (UUID) |
| `email`, `password_hash` | connexion (scrypt) |
| `name`, `city`, `phone` | profil public de l'agence |

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
- Aucun jeton n'est stocké en base : la révocation se fait par expiration ou
  rotation de `SESSION_SECRET`.

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
