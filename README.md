# COLIS EXPRESS

Application web **100 % en français** de gestion d'envoi et de réception de colis
multi-agences. Interface statique + **API Node.js** + base **PostgreSQL (Neon)** :
plus aucune dépendance à Firebase.

- Interface mobile-first (vert foncé / orange), montants en **FCFA**
- Suivi public avec code `CLI-XXXXXX`, QR code sur le reçu, partage WhatsApp
- Données privées (téléphone, CNI) jamais exposées sur le suivi public
- Parcours « agence de destination non inscrite » : déclaration à la main,
  puis **rattachement** définitif quand l'agence crée son compte
- Authentification agence par e-mail/mot de passe (sessions cookie signées,
  mots de passe hachés scrypt)

## Arborescence

```text
api/[...path].js       Point d'entrée Vercel (redirige vers lib/app.js)
lib/app.js             API Express : routes, sessions, autorisations
lib/auth.js            Hachage des mots de passe (scrypt) et cookies signés
db/schema.sql          Schéma PostgreSQL (agencies, parcels)
db/db.js               Connexion Neon (pg) ou PGlite (démo/tests), amorçage
server.js              Serveur local (API + fichiers statiques)
js/                    Frontend statique (modules ES, aucune dépendance externe)
tests/                 Tests automatisés (node --test)
```

## 1. Base de données (Neon)

1. Créez un projet sur [neon.tech](https://neon.tech) (offre gratuite suffisante).
2. Copiez la **connection string** (format
   `postgresql://…?sslmode=require`).
3. Définissez-la dans la variable d'environnement `DATABASE_URL` :
   - **En local** : créez un fichier `.env` à la racine (jamais commité) :
     ```text
     DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
     SESSION_SECRET=une-longue-chaine-aleatoire
     ```
     ou exportez-la dans votre shell.
   - **Sur Vercel** : *Settings → Environment Variables* → `DATABASE_URL`
     (et `SESSION_SECRET`) sur les environnements Production et Preview.

> `DATABASE_URL` est un secret : ne la commitez pas, ne la partagez jamais
> dans une conversation ou un ticket.

## 2. Exécuter localement

```bash
npm install
npm run init-db    # crée les tables sur la base définie par DATABASE_URL
npm start          # http://localhost:8080
```

**Mode démo (sans Neon)** : si `DATABASE_URL` est absente, le serveur utilise
PGlite (Postgres WASM en mémoire) avec des données de démonstration :

- `demo@colisexpress.ci` / `demo1234`
- `bouake@colisexpress.ci` / `demo1234`

Les données de démo sont réinitialisées à chaque redémarrage.

## 3. Déployer sur Vercel

Le dépôt est déjà configuré (`vercel.json`, `api/[...path].js`) : le dépôt
GitHub est détecté comme projet **Node.js**. Après le premier import :

1. Renseignez `DATABASE_URL` et `SESSION_SECRET` dans *Environment Variables*.
2. Redéployez : toutes les routes `/api/*` sont servies par `lib/app.js`, les
   pages restent statiques.

> **Ne jamais activer `cleanUrls`** dans `vercel.json` : la redirection
> `colis.html?id=…` → `/colis` perd la query string, et les boutons
> « Voir le colis » (reçu, dashboard) ouvrent la fiche sans identifiant.
> Tous les liens de l'application portent déjà leur `.html` et leurs
> paramètres (`?id=`, `?code=`, `?retour=`) ; un test (`npm test`) verrouille
> ce point.

## 4. Sécurité : qui peut faire quoi

L'autorisation est appliquée **côté serveur** dans `lib/app.js` (les pages
peuvent être trafiquées sans effet) :

| Action | Condition |
|---|---|
| Créer un colis | agence connectée (`ownerId` = compte appelant) |
| Voir un colis / la liste | agence expéditrice **ou** agence de destination uniquement |
| Rattacher une agence de destination | expéditeur seulement, **une seule fois**, vers une agence inscrite, jamais vers lui-même |
| Faire avancer le statut | selon les étapes de `js/metier-colis.js` (expéditions : expéditeur ; arrivée/retrait : agence de destination, ou l'expéditeur si rien n'est rattaché) |
| Suivi public (`/api/suivi/:code`) | monde entier, mais **strictement** les 7 champs publics (aucune donnée personnelle) |
| Supprimer quoi que ce soit | jamais (aucune route de suppression) |

Les mots de passe sont hachés avec **scrypt** (bibliothèque standard Node) ; les
sessions utilisent un cookie `HttpOnly` signé HMAC (`SESSION_SECRET`).

## 5. Tests automatisés

Aucun service externe requis : la suite utilise PGlite (Postgres WASM) et le
module `node:test` de Node 20+.

```bash
npm test
```

- `tests/api.test.mjs` : parcours complets de l'API (session, colis inscrit et
  non inscrite, visibilité entre agences, suivi public anonyme, rattachement
  unique, progression des statuts, refus d'accès).
- `tests/metier-colis.test.mjs` : règles métier (validation, construction,
  étapes, rattachement).
- `tests/integration-page.test.mjs` : intégrité statique (syntaxe, imports,
  identifiants DOM, liens, absence de toute dépendance Firebase).

## 6. Parcours fonctionnel

1. **Inscription** : une agence crée son compte (`inscription.html`).
2. **Nouveau colis** : saisie expéditeur/destinataire/colis, choix d'une agence
   inscrite **ou** saisie manuelle d'une agence pas encore inscrite
   (nom, ville, téléphone) + invitation WhatsApp.
3. **Reçu** : code `CLI-XXXXXX`, QR code, partage WhatsApp.
4. **Suivi public** (`suivi.html`) : statut et historique, sans données
   personnelles.
5. **Fiche colis** : progression (« Expédié », « En transit », « Arrivé à
   l'agence de destination », « Retiré » avec CNI du retraitant) et
   **rattachement** de l'agence de destination quand elle crée son compte.
6. **Paramètres** : nom, ville et téléphone de l'agence.

## 7. Dépannage

- **`DATABASE_URL` absente au démarrage** : le serveur bascule en démo (PGlite)
  et l'affiche dans la console.
- **Erreur de connexion à la base** : vérifiez le format de la connection
  string Neon (`?sslmode=require`) et que `npm run init-db` a bien été exécuté.
- **401 sur les pages agence** : la session a expiré, reconnectez-vous.
- **403 / 400 sur une action** : l'action n'est pas permise pour ce compte
  (rattachement réservé à l'expéditeur, étape réservée à l'agence concernée…).
- **« Voir le colis » ouvre une fiche sans colis** : l'identifiant a été perdu
  en route. Vérifiez que `cleanUrls` n'est pas activé sur Vercel (voir section 3)
  et que l'URL finale contient bien `?id=…`.

Conçu par **Shopin30** — support : [WhatsApp +225 0501303343](https://wa.me/2250501303343).
