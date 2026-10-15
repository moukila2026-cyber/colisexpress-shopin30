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
- **Comptes agents nommés** : 1 compte = 1 agence, plusieurs agents ;
  chaque écriture d'étape trace l'agent acteur dans l'historique
- **Grille tarifaire** (Paramètres > Tarifs) : axe ville départ → ville
  arrivée (ou « toutes destinations ») × tranche de poids → prix FCFA,
  sélectionnés en menu déroulant à l'enregistrement (saisie libre en repli)
- **État de paiement par colis** : « Payé au départ », « Partiel »,
  « À payer à l'arrivée » — puis encaissement du solde à la remise
- **Caisse du jour** par agence : encaissements du jour par mode (espèces,
  mobile money), restes à encaisser, clôture avec total compté, export CSV
- **Carnet de clients** : expéditeurs et destinataires mémorisés
  automatiquement à chaque colis (ou à la main), recherche par téléphone,
  pré-remplissage du formulaire « nouveau colis », historique des colis par
  client — visible uniquement par l'agence propriétaire
- **Devis public** : estimateur anonyme sur la page d'accueil (ville départ,
  ville arrivée, poids, nature) calculé depuis les grilles tarifaires des
  agences actives, avec contact WhatsApp de l'agence — aucune donnée
  personnelle demandée

## Arborescence

```text
api/                   Points d'entrée Vercel (réexportent lib/app.js)
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

- `demo@colisexpress.ci` / `demo1234` (gérant de Shopin30 Abidjan)
- `bouake@colisexpress.ci` / `demo1234` (gérant de Agence Bouaké Centre)
- `koffi@colisexpress.ci` / `demo1234` (agent actif, Shopin30 Abidjan)
- `aicha@colisexpress.ci` / `demo1234` (agent actif, Agence Bouaké Centre)
- `yao@colisexpress.ci` / `demo1234` (agent **désactivé** : la connexion est refusée)

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
| Inviter / désactiver des agents | **gérant** de l'agence uniquement (garde serveur `requireGerant`) |
| Se connecter comme agent | agent **actif** uniquement ; un agent désactivé perd sa session immédiatement |
| Suivi public (`/api/suivi/:code`) | monde entier, mais **strictement** les 7 champs publics (aucune donnée personnelle, y compris l'acteur `actorName` des étapes) |
| Carnet de clients (`/api/clients…`) | agence propriétaire uniquement (cloisonnement serveur) ; aucune suppression |
| Devis public (`POST /api/devis`) | anonyme, sans session : ne renvoie que prix, tranche et coordonnées professionnelles des agences (jamais d'e-mail ni d'identifiant interne) |
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
  unique, progression des statuts, refus d'accès, comptes agents, grille
  tarifaire, états de paiement, encaissements et clôture de caisse, carnet de
  clients et devis public).
- `tests/metier-colis.test.mjs` : règles métier (validation, construction,
  étapes, rattachement, acteur, états de paiement).
- `tests/metier-tarifs.test.mjs` : grille tarifaire (tranches, axes,
  priorité destination exacte, options du menu déroulant, validation) et
  devis public (`estimerDevis`).
- `tests/metier-clients.test.mjs` : carnet de clients (validation,
  normalisation, mémorisation depuis un colis, recherche).
- `tests/integration-page.test.mjs` : intégrité statique (syntaxe, imports,
  identifiants DOM, liens, absence de toute dépendance Firebase, points
  d'entrée Vercel de chaque route imbriquée).

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
7. **Équipe (Paramètres)** : le gérant invite des agents (nom, e-mail,
   téléphone, mot de passe provisoire) et les active/désactive ; chaque agent
   se connecte avec son propre e-mail et ses étapes apparaissent « Par … »
   dans l'historique des colis.
8. **Tarifs (Paramètres)** : le gérant construit sa grille (axe × tranche de
   poids → prix) ; dans « Nouveau colis », le prix est ensuite **choisi dans
   un menu déroulant** alimenté par la grille selon destination + poids, avec
   récapitulatif avant validation. Si la grille ne couvre pas l'envoi, la
   saisie libre reste autorisée (colis antérieurs et agences sans grille
   inchangés). Le prix est figé à l'enregistrement.
9. **Paiement** : l'état est saisi à l'enregistrement (payé au départ /
   partiel / à payer à l'arrivée), puis l'agence qui encaisse le solde met
   à jour la fiche colis (« Encaisser le solde »).
10. **Caisse** : page « Caisse du jour » — encaissements du jour avec totaux
    espèces / mobile money, restes à encaisser, clôture avec total compté
    validé par l'agent (écart conservé) et export CSV (date, code, expéditeur,
    destinataire, prix, payé, reste, mode, agent).
11. **Carnet de clients** : page « Clients » — chaque colis enregistré
    mémorise l'expéditeur (avec CNI) et le destinataire dans le carnet privé
    de l'agence ; recherche par téléphone ou nom, ajout/modification à la
    main, fiche client avec historique de ses colis. Dans « Nouveau colis »,
    la saisie d'un téléphone connu propose le **pré-remplissage** en un clic.
12. **Devis public** : sur la page d'accueil, l'estimateur (ville départ,
    ville arrivée, poids, nature) calcule les prix depuis les grilles des
    agences actives et propose « Contacter l'agence » sur WhatsApp. Aucune
    donnée personnelle n'est demandée pour estimer.

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
- **Fiche colis ou suivi QR en erreur sur le site déployé (mais OK en local)** :
  si le navigateur reçoit un **404 NOT_FOUND** (page Vercel, pas le JSON de
  l'API) sur `/api/colis/…` ou `/api/suivi/…`, il manque le point d'entrée
  Vercel de cette route. Hors Next.js, un segment entre crochets ne capte
  qu'un seul segment d'URL : `api/[...path].js` couvre les routes à un
  segment (`/api/health`, `/api/colis`…), et chaque route imbriquée a son
  fichier (`api/colis/[id].js`, `api/colis/[id]/attach.js`,
  `api/colis/[id]/progress.js`, `api/suivi/[code].js`). Toute nouvelle route
  imbriquée doit recevoir le sien ; un test (`npm test`) verrouille ces
  fichiers.

Conçu par **Shopin30** — support : [WhatsApp +225 0501303343](https://wa.me/2250501303343).
