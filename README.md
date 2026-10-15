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
- **Bordereaux d'acheminement** : regrouper 1 à 200 colis expédiés ensemble
  (transporteur, véhicule/ligne de car), statuts Préparé → Remis → En route →
  Arrivé → Contrôlé/Écart, lien public `bordereau.html?code=BDR-…` sans
  données personnelles, contrôle d'arrivée en cases à cocher — un colis
  absent crée **automatiquement un incident**
- **Photos de preuve** : 2 maximum par étape (prise en charge, arrivée),
  compressées côté navigateur (~200 Ko), stockées **hors de Postgres**
  (Vercel Blob ou disque local derrière `lib/photos.js`), visibles uniquement
  par les deux agences, jamais supprimables
- **Incidents** : état latéral du colis (perdu, endommagé, retard, contesté,
  bloqué — ouvert / en recherches / résolu), visible par les deux agences,
  bandeau sobre sur le suivi public (« une vérification est en cours »),
  escalade > 24 h (alerte) et > 7 jours (file plateforme)
- **Colis en souffrance** : liste « arrivé non retiré depuis > 7 jours » avec
  workflow **retour à l'expéditeur** (trajet tracé dans l'historique) et
  frais de magasinage éventuels encaissés dans la caisse
- **Alertes « colis qui dorment »** sur le tableau de bord (cartes
  « À traiter ») : sans mouvement > 48 h, non retiré > 72 h, non rattaché
  > 7 jours
- **Notifications (LOT 5)** aux **deux agences concernées** : incident ouvert
  (manuel ou automatique) et escalade 24 h, bordereau arrivé et écart au
  contrôle, colis en souffrance, retour à l'expéditeur décidé / reçu, colis
  qui dorment. **Mode simulation par défaut** : aucun message ne sort de
  l'application, chaque notification est journalisée (page
  « Notifications », compteur de non lues dans la barre latérale). Messages
  **sans aucune donnée personnelle** (codes, villes, durées seulement) ; une
  seule fonction d'envoi (`lib/notifications.js`) pour brancher plus tard
  WhatsApp, SMS ou e-mail

## Arborescence

```text
api/                   Points d'entrée Vercel (réexportent lib/app.js)
lib/app.js             API Express : routes, sessions, autorisations
lib/auth.js            Hachage des mots de passe (scrypt) et cookies signés
lib/photos.js          Stockage des photos de preuve (Vercel Blob ou disque local)
lib/notifications.js   Notifications : fonction d'envoi unique, transports (simulation par défaut), journal
db/schema.sql          Schéma PostgreSQL (agences, colis, agents, tarifs, caisse, clients, bordereaux, photos, incidents, notifications)
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
   - **Photos de preuve (LOT 4)** : créez un store
     [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) et ajoutez
     `BLOB_READ_WRITE_TOKEN` — le stockage des images bascule
     automatiquement dessus (`lib/photos.js`). Sans ce jeton (développement,
     démo, tests), les photos sont écrites sur le disque local dans
     `PHOTOS_DIR` (défaut `uploads/photos`, jamais commité). Dans les deux
     cas, le contenu n'est servi que par la route authentifiée
     `GET /api/photos/:id` (deux agences du colis uniquement) et Postgres ne
     garde que les métadonnées.
   - **Notifications (LOT 5)** : rien à configurer — `NOTIFICATIONS_CANAL`
     vaut `simulation` par défaut (aucun envoi réel, journal consultable
     dans la page « Notifications »). Les canaux `whatsapp`, `sms` et `email`
     sont des points de branchement prévus dans `lib/notifications.js`
     (`TRANSPORTS`) : tant que la fonction d'envoi du transport n'est pas
     écrite **et** que ses variables (ex. `WHATSAPP_API_URL`,
     `WHATSAPP_API_TOKEN`) ne sont pas toutes définies, le serveur reste en
     simulation. Ces jetons sont des secrets : variables d'environnement
     uniquement.

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
| Bordereau (`/api/bordereaux…`) | création et émargement « Remis / En route » : agence **expéditrice** ; « Arrivé » et contrôle : agence de **destination** (ou l'expéditrice si non rattachée) ; lecture aux deux agences |
| Suivi public d'un bordereau (`/api/suivi-bordereau/:code`) | monde entier, mais codes de suivi + statuts uniquement (ni noms, ni téléphones — y compris celui du transporteur) |
| Photos (`/api/colis/:id/photos`, `/api/photos/:id`) | téléversement par l'agence concernée par l'étape (prise en charge : expéditrice ; arrivée : destination), lecture aux deux agences ; 2 max/étape, `image/*`, ≤ 2 Mo ; **jamais publiques, jamais supprimables** |
| Incidents (`/api/colis/:id/incidents`, `/api/incidents…`) | ouverture et suivi par les deux agences du colis ; un seul incident non résolu à la fois ; le suivi public n'affiche qu'un bandeau fixe |
| Retour à l'expéditeur (`POST /api/colis/:id/retour`) | décision : agence qui détient le colis (arrivée + non retiré) ; réception : agence expéditrice ; frais de magasinage → caisse de l'agence qui encaisse |
| Notifications (`GET /api/notifications`, `POST /api/notifications/lecture`) | destinataires : les **deux agences concernées** seulement (jamais un client ni un tiers) ; chaque agence lit et marque « lu » **son** journal ; messages sans nom, téléphone, CNI, identité d'agent ni note libre ; simulation tant qu'aucun transport réel n'est configuré ; aucune suppression |
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
  clients et devis public, chaîne de preuve du LOT 4, notifications du
  LOT 5).
- `tests/metier-colis.test.mjs` : règles métier (validation, construction,
  étapes, rattachement, acteur, états de paiement).
- `tests/metier-tarifs.test.mjs` : grille tarifaire (tranches, axes,
  priorité destination exacte, options du menu déroulant, validation) et
  devis public (`estimerDevis`).
- `tests/metier-clients.test.mjs` : carnet de clients (validation,
  normalisation, mémorisation depuis un colis, recherche).
- `tests/metier-bordereau.test.mjs` : bordereaux (validation de création,
  colis embarquables, étapes par acteur, contrôle d'arrivée, projection
  publique).
- `tests/metier-incidents.test.mjs` : incidents (ouverture, transitions,
  escalade 24 h / 7 j, bandeau public).
- `tests/metier-alertes.test.mjs` : alertes « colis qui dorment » (48 h /
  72 h / 7 j, souffrance).
- `tests/metier-notifications.test.mjs` : notifications (catalogue des
  événements, destinataires = les deux agences, messages sans donnée
  personnelle, dédoublonnage par épisode, échéances, canal en simulation par
  défaut). Les parcours API correspondants (incident, bordereau arrivé /
  écart, souffrance et retour, balayage des échéances, panne de transport
  jamais bloquante) sont dans `tests/api.test.mjs`.
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
13. **Bordereaux** : page « Bordereaux » — sélection de 1 à 200 colis
    « Enregistré »/« Expédié » vers la même destination, transporteur
    (nom, téléphone, véhicule/ligne), puis émargement : remise au
    transporteur (tracée dans l'historique de chaque colis), mise en route,
    arrivée. L'agence de destination (ou l'expéditrice si elle n'est pas
    rattachée) fait le **contrôle d'arrivée en cases à cocher** : tout est
    présent → « Contrôlé » et les colis sont confirmés arrivés ; un colis
    absent → « Écart » et **incident « perdu » automatique**. Le
    transporteur reçoit le lien public `bordereau.html?code=BDR-…`
    (aucune donnée personnelle).
14. **Photos de preuve** : sur la fiche colis, 2 photos maximum à la prise
    en charge (agence expéditrice) et 2 à l'arrivée (agence de destination),
    compressées dans le navigateur (~200 Ko). Visibles par les deux agences
    uniquement, jamais supprimables.
15. **Incidents** : sur la fiche colis — ouvrir un incident (perdu,
    endommagé, retard, contesté, bloqué), le passer « en recherches », puis
    le résoudre avec une explication tracée. Les deux agences le voient ;
    le suivi public affiche seulement « Une vérification est en cours sur ce
    colis ». Ouvert > 24 h : alerte de relance ; > 7 jours : escalade
    plateforme.
16. **Colis qui dorment** : le tableau de bord affiche les cartes
    « À traiter » (sans mouvement > 48 h, arrivé non retiré > 72 h, agence
    non rattachée > 7 j, **en souffrance** > 7 j). Pour un colis en
    souffrance, l'agence qui le détient décide le **retour à l'expéditeur**
    (frais de magasinage éventuels, encaissés dans sa caisse du jour) ;
    l'agence expéditrice confirme la réception — les deux trajets sont
    tracés dans l'historique du colis.
17. **Notifications** : page « Notifications » (compteur de non lues dans la
    barre latérale) — chaque événement de la chaîne de preuve est notifié
    aux deux agences du colis : incident ouvert (y compris l'incident
    automatique d'un absent au contrôle), incident non résolu depuis 24 h,
    bordereau arrivé, écart au contrôle, colis en souffrance, retour décidé
    puis reçu, colis qui dorment. En démo (`npm start`), le journal est
    pré-rempli (BDR-DEMO03 en écart, CLI-DEMO06 en retour) et le premier
    affichage du tableau de bord y ajoute les échéances en direct ; confirmer
    la réception du retour de CLI-DEMO06 avec `bouake@colisexpress.ci`
    notifie aussitôt les deux agences. Mode simulation : rien ne sort de
    l'application tant qu'aucun transport réel n'est configuré.

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
  l'API) sur `/api/colis/…` ou `/api/suivi/…`, la route n'est captée par
  aucun point d'entrée Vercel. Hors Next.js, un segment entre crochets ne
  capte qu'un seul segment d'URL : `api/[...path].js` couvre les routes à un
  segment (`/api/health`, `/api/colis`…), et chaque route à deux segments a
  son fichier (`api/colis/[id].js`, `api/suivi/[code].js`…). Les routes à
  **trois segments** (`/api/colis/:id/attach`, `/api/bordereaux/:id/controle`,
  `/api/caisse/cloture`…) n'ont **pas** de fichier : le plan Hobby limite un
  déploiement à **12 fonctions serverless**, elles sont repliées par les
  `rewrites` de `vercel.json` sur la fonction parente (`?action=…`) puis
  redépliées par le premier middleware de `lib/app.js`. Toute nouvelle route
  à trois segments doit passer par ce mécanisme (jamais par un nouveau
  fichier) ; `npm test` verrouille les fichiers, les rewrites et la limite
  de 12 fonctions.
- **Chaque déploiement Vercel échoue avec « No more than 12 Serverless
  Functions… »** : le dossier `api/` contient plus de 12 fichiers. Repliez
  les routes concernées via les `rewrites` de `vercel.json` (voir ci-dessus).

Conçu par **Shopin30** — support : [WhatsApp +225 0501303343](https://wa.me/2250501303343).
