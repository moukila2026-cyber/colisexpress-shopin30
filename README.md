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
  **sans aucune donnée personnelle** (codes, villes, durées seulement) ; envoi
  unique dans `lib/notifications.js`, WhatsApp Cloud puis Orange SMS, enfin
  simulation si aucun transport ne fonctionne ; page Notifications et panneau
  console avec journal (aucun numéro de téléphone dans les logs)
- **Plans, quotas et portefeuille (LOT 6)** : plan par agence — **Gratuit**
  (50 colis/mois, puis 30 FCFA par colis prépayés sur le portefeuille),
  **Pro** (10 000 FCFA/mois, 500 colis inclus), **Réseau** (sur devis).
  Seule l'agence **expéditrice** est comptée : l'agence de destination ne
  paie jamais. Seule la **création** d'un nouveau colis peut être refusée
  (quota atteint et portefeuille insuffisant) : un solde impayé ne bloque
  jamais un colis en cours (lecture, progression, réception, contrôle).
  Page « Abonnement » : compteur du mois, portefeuille et mouvements,
  échéances, historique
- **Console plateforme (LOT 6)** (`plateforme.html`, compte séparé des
  agences) : file des incidents ouverts depuis plus de 7 jours, litiges,
  agences (plan, compteur, portefeuille, abonnement), volumes du réseau,
  plan Réseau négocié et recharge des portefeuilles
- **Suivi personnalisé (LOT 7)** : chaque agence peut habiller la page de
  suivi public des colis qu'elle expédie (nom affiché, couleurs, logo
  PNG/JPEG/WebP) depuis Paramètres — facultatif, sans aucune donnée
  personnelle ; sinon, l'apparence COLIS EXPRESS par défaut
- **Paiements en ligne SasPay (LOT 7, resserré au LOT 8)** : payer
  l'**abonnement** du mois ou une **recharge** du portefeuille sur la page de
  paiement hébergée SasPay (mobile money, carte), compte marchand de
  Shopin30. **Shopin30 n'encaisse jamais l'argent des colis** : les agences
  encaissent elles-mêmes au guichet (espèces ou mobile money, caisse du
  jour) — le paiement en ligne d'un colis est refusé (403). Un paiement
  n'est appliqué qu'après vérification côté serveur (session payée,
  transaction « SUCCESS » au bon montant) ; webhook signé (HMAC) vérifié
  côté serveur ; mode **SIMULATION** tant qu'aucune clé n'est configurée
- **Mise en service assistée (LOT 9)** : guide pas à pas sans terminal
  [`docs/mise-en-service.md`](docs/mise-en-service.md) (Blob, base de
  préversion séparée, `SESSION_SECRET`, premier compte console, SasPay,
  variables à venir, vérifications finales, tableau des variables) et
  panneau **« Mise en service »** dans la console plateforme : une ligne
  ✓ / ⚠ / ✗ par point de configuration avec l'action à faire, sans jamais
  afficher la valeur d'un secret (empreinte non réversible de l'hôte de la
  base pour distinguer Preview et Production)
- **Compteur de colis en temps réel (LOT 10)** : sur chaque page agence,
  « Colis ce mois : 37 / 50 » avec barre de progression et détail (« reste
  13 inclus », « hors forfait : 30 FCFA par colis — votre solde couvre N
  colis », « illimité ») en trois niveaux (normal, alerte dès 80 %, danger)
  et lien « Recharger » pour le gérant ; carte **Mon forfait** sur le
  tableau de bord ; ligne permanente « Ce colis sera le 38e sur 50 inclus »
  dans le formulaire ; sans WebSocket : une requête légère `GET /api/resume`
  toutes les 20 s quand l'onglet est visible, mise à jour immédiate après
  chaque enregistrement (le compteur revient avec le colis) et entre onglets
  (`BroadcastChannel`) ; console : barre par agence, rafraîchie toutes les
  30 s
- **Tâche quotidienne (LOT 11)** : Cron Vercel à 05:00 UTC, une fois par
  jour, protégé par `CRON_SECRET` (comparaison en temps constant) ; ouvre la
  période mensuelle pour toutes les agences, balaie les escalades d'incident
  24 h / 7 j, les colis qui dorment et les colis en souffrance, puis envoie
  les rappels d'abonnement à J-2, le jour de l'échéance et en retard. Les
  exécutions sont journalisées dans `taches_executions` ; la console affiche
  les dix dernières et permet à un administrateur de lancer la tâche.
- **Sécurité avant la mise en production (LOT 8)** : garde-fous de paiement
  selon l'environnement Vercel (clé de test ou simulation refusées en
  production, clé réelle refusée en préversion), mode de frais SasPay
  (`SASPAY_MODE_FRAIS`), `SESSION_SECRET` forte obligatoire dès qu'une vraie
  base est branchée, et **premier administrateur de la console créé sans
  terminal** avec un jeton d'amorçage à usage unique

## Arborescence

```text
api/                   Points d'entrée Vercel (réexportent lib/app.js)
lib/app.js             API Express : routes, sessions, autorisations
lib/auth.js            Hachage des mots de passe (scrypt) et cookies signés
lib/photos.js          Stockage des photos de preuve (Vercel Blob ou disque local)
lib/notifications.js   Notifications : fonction d'envoi unique, transports (simulation par défaut), journal
lib/facturation.js     Plans, quotas, portefeuille prépayé, abonnements (écritures atomiques)
lib/plateforme.js      Console plateforme : vue d'ensemble en lecture seule, amorçage du premier administrateur
lib/mise-en-service.js Diagnostic de configuration (console) : états ✓/⚠/✗ sans aucune valeur de secret
lib/paiements.js       Paiements en ligne : abstraction SasPay (simulation / test / réel), webhook signé
db/schema.sql          Schéma PostgreSQL (agences, colis, agents, tarifs, caisse, clients, bordereaux, photos, incidents, notifications, facturation)
db/init-db.js          npm run init-db : applique le schéma sur la base Neon
db/plateforme-admin.js npm run plateforme-admin : compte de la console plateforme (variables d'environnement)
db/logo-demo.js        Logo PNG de démonstration généré en mémoire (seed)
db/db.js               Connexion Neon (pg) ou PGlite (démo/tests), amorçage
server.js              Serveur local (API + fichiers statiques)
js/                    Frontend statique (modules ES, aucune dépendance externe)
tests/                 Tests automatisés (node --test)
```

> **Mise en service sans terminal** : suivez
> [`docs/mise-en-service.md`](docs/mise-en-service.md), puis contrôlez le
> panneau « Mise en service » de la console plateforme.

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
   - **Notifications (LOTS 5 et 12)** : aucun réglage nécessaire pour la
     simulation. Sans variables de transport, les messages sont journalisés,
     sans envoi extérieur. Si WhatsApp Cloud est configuré, l'application
     essaie WhatsApp puis Orange SMS ; si les deux échouent, le message reste
     dans le journal en simulation. La variable facultative `NOTIFICATIONS_CANAL`
     permet de forcer `sms` ou `simulation`. Variables et guide pas à pas :
     [`docs/mise-en-service.md`](docs/mise-en-service.md). Les jetons restent
     dans Vercel uniquement ; aucun numéro de téléphone n'est écrit dans les
     logs.
   - **Console plateforme (LOT 6)** : le compte de l'équipe Shopin30 est
     distinct des agences. Créez-le (ou changez son mot de passe) sans
     aucun secret dans le code :
     `PLATEFORME_ADMIN_EMAIL=… PLATEFORME_ADMIN_NOM="…" PLATEFORME_ADMIN_MOT_DE_PASSE=… DATABASE_URL=… npm run plateforme-admin`
     (12 caractères minimum ; `PLATEFORME_ADMIN_ACTIF=0` désactive le
     compte). Connexion sur `/plateforme.html`.
   - **Paiements en ligne SasPay (LOT 7)** — variables d'environnement
     uniquement, jamais dans le code ni les journaux :
     - `SASPAY_SECRET_KEY` : clé secrète du tableau de bord SasPay
       (`sk_test_…` = bac à sable, `sk_live_…` = paiements réels) ;
     - `SASPAY_WEBHOOK_SECRET` : secret de signature du webhook, affiché
       une seule fois par SasPay à sa création ; déclarez dans le tableau de
       bord SasPay l'URL `https://<votre-domaine>/api/paiements/webhook`
       abonnée aux événements `transaction.*` ;
     - `APP_URL` (recommandée) : URL publique du site, pour l'adresse de
       retour après paiement.
     Sans clé : mode **SIMULATION** en démo/développement (page de paiement
     simulée, aucune somme réelle) ; en production sans clé, le paiement en
     ligne est **désactivé** (une simulation ne doit jamais créditer une vraie
     caisse) — sauf `PAIEMENTS_SIMULATION=1` pour une préproduction.
     N'utilisez une clé `sk_test_` que hors production : ses paiements de
     test créditent réellement le portefeuille de l'environnement.
   - **Garde-fous du LOT 8** (`configurationPaiements`, selon `VERCEL_ENV`
     que Vercel définit tout seul) : en **Production**, une clé `sk_test_`
     ou `PAIEMENTS_SIMULATION=1` → paiement **désactivé** avec la raison
     affichée ; en **Preview** ou **Development**, une clé `sk_live_` →
     désactivé (jamais d'argent réel sur une base de test). En local sans
     `DATABASE_URL`, la simulation reste le défaut.
   - `SASPAY_MODE_FRAIS` (facultative, `ADD_ON` ou `DEDUCTED`) : transmise
     à SasPay en `fee_charge_mode` à la création de chaque session. `ADD_ON`
     = les frais s'ajoutent au montant débité au payeur (Shopin30 reçoit le
     montant plein) ; `DEDUCTED` = le payeur est débité exactement du
     montant, les frais sont retenus sur le net reversé à Shopin30. Dans les
     deux cas, le montant vérifié est le montant **demandé**
     (`requested_amount`) et le portefeuille de l'agence est crédité de ce
     montant. Absente → réglage par défaut du compte SasPay (SasPay ignore
     aussi la valeur si « Autoriser le choix du mode de frais par l'API »
     n'est pas activé dans Paramètres → Frais).
   - **`SESSION_SECRET` (LOT 8)** : dès que `DATABASE_URL` est définie ou que
     `VERCEL_ENV` vaut `production`, une valeur d'**au moins 32 caractères**
     est obligatoire ; sinon les connexions et toutes les routes
     authentifiées (agences et console) répondent 503 avec un message clair
     — la valeur de secours du code ne sert plus qu'à la démo locale. Pour
     générer une valeur sans terminal : console du navigateur sur une page
     https → `crypto.randomUUID() + crypto.randomUUID()`.
   - **Premier administrateur de la console sans terminal (LOT 8)** : si
     aucun administrateur actif n'existe **et** que
     `PLATEFORME_PREMIER_ADMIN_JETON` (au moins 32 caractères) est définie,
     `/plateforme.html` affiche « Créer le premier administrateur » (jeton,
     e-mail, nom, mot de passe d'au moins 12 caractères). Le jeton est
     comparé à temps constant, la création est atomique (une seule possible,
     même en parallèle), puis l'amorçage est **fermé définitivement** :
     supprimez alors la variable dans Vercel. `npm run plateforme-admin`
     reste disponible pour les autres comptes.

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
- `plateforme@colisexpress.ci` / `demo1234` : **console plateforme**
  (`/plateforme.html`), compte séparé des agences

En démo, Abidjan est au plan **Pro** (abonnement du mois réglé, 2 500 FCFA
restants) et Bouaké au plan **Gratuit** avec 48 colis sur 50 ce mois-ci et
60 FCFA de portefeuille : 2 colis inclus, puis 2 colis hors forfait
prépayés, puis le refus de création montre la règle.

Le suivi public de Shopin30 Abidjan est personnalisé (bleu et or, logo) :
comparez `suivi.html?code=CLI-DEMO01` (Abidjan) et
`suivi.html?code=CLI-DEMO03` (Bouaké, apparence par défaut). Les paiements
en ligne fonctionnent en **simulation**.

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
| Abonnement (`GET /api/facturation`, `POST /api/facturation/plan`, `POST /api/facturation/abonnement`) | lecture : tout membre de l'agence ; changement de plan (Gratuit ↔ Pro) et règlement : **gérant** uniquement (garde serveur) ; Réseau : console plateforme seulement ; journal du portefeuille immuable |
| Quota et dépassement (`POST /api/colis`) | seule l'agence **expéditrice** est comptée (la destination ne paie jamais) ; seule la **création** d'un colis peut être refusée (402 : quota atteint et portefeuille insuffisant) ; aucune autre route ne consulte la facturation — un impayé ne bloque jamais un colis en cours |
| Console plateforme (`/api/plateforme…`) | compte **séparé** (`plateforme_admins`, cookie `ce_plateforme` signé dans un domaine distinct, `SameSite=Strict`, 12 h) ; une session d'agence n'ouvre jamais la console et inversement ; aucune donnée client (noms, téléphones, CNI) projetée ; recharge et plan journalisés |
| Suivi personnalisé (`GET`/`PUT /api/marque`, `GET /api/suivi/:code/logo`) | réglages : **gérant** uniquement ; couleurs strictement `#rrggbb` (contrôle serveur et contrainte SQL) ; logo PNG/JPEG/WebP vérifié sur ses octets, 300 Ko max, jamais de SVG ; le suivi public ne reçoit que nom affiché, couleurs et logo de l'agence expéditrice, si activé — aucune donnée personnelle, aucun contact |
| Paiements en ligne (`/api/paiements…`) | reste d'un colis : l'une des deux agences du colis (comme au guichet) ; abonnement et recharge : **gérant** ; clé SasPay uniquement côté serveur ; le « client » transmis à SasPay est l'agence (aucune donnée client) ; effet appliqué **une seule fois** et seulement après vérification serveur (statut de session + `verify` « SUCCESS », montant et devise exacts) ; webhook : HMAC-SHA256 sur le corps brut, horodatage ± 300 s, comparaison en temps constant ; le numéro débité n'est jamais conservé ; simulation refusée dès qu'une clé est configurée |
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
  LOT 5, plans, quotas, portefeuille et console plateforme du LOT 6, suivi
  personnalisé et paiements SasPay du LOT 7).
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
- `tests/metier-plans.test.mjs` : plans (Gratuit / Pro / Réseau), périodes
  mensuelles, quota effectif (impayé après échéance → quota Gratuit),
  dépassement prépayé, changements de plan, recharges, échéances. Les
  parcours API (402 sans solde, destination jamais comptée, rien de bloqué
  en cours de route, abonnement Pro, console plateforme séparée,
  concurrence) sont dans `tests/api.test.mjs`.
- `tests/metier-marque.test.mjs` : suivi personnalisé (couleurs strictes,
  contraste lisible, logos vérifiés sur leurs octets, projection publique).
- `tests/metier-paiements.test.mjs` : paiements en ligne (montants
  décimaux XOF, demandes, statuts de session, transaction conforme). Les
  parcours API (simulation, abonnement et recharge, mode TEST contre un faux
  SasPay local avec webhooks signés, configuration) sont dans
  `tests/api.test.mjs`.
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
18. **Abonnement** : page « Abonnement » — plan actuel, compteur des colis
    enregistrés ce mois (jauge), portefeuille et mouvements, échéances et
    historique. Le gérant passe au **Pro** (abonnement prélevé sur le
    portefeuille dès que le solde le permet, échéance à 7 jours) ou revient
    au **Gratuit** au 1er du mois suivant ; le **Réseau** se demande par
    devis. Au-delà du quota, chaque colis est prélevé de 30 FCFA à
    l'enregistrement ; sans solde, la création est refusée avec un message
    clair (le formulaire « Nouveau colis » prévient avant). En démo :
    connectez-vous avec `bouake@colisexpress.ci` et enregistrez 5 colis.
19. **Console plateforme** (`/plateforme.html`, compte
    `plateforme@colisexpress.ci` en démo) : indicateurs du réseau, file des
    incidents ouverts depuis plus de 7 jours (CLI-DEMO07, litige de
    10 jours), litiges, agences (plan, compteur, portefeuille, abonnement,
    volumes) ; « Gérer » une agence pour fixer son plan (Réseau : quota et
    prix négociés) ou créditer son portefeuille d'un paiement reçu (un
    abonnement dû est alors réglé automatiquement).
20. **Suivi personnalisé** : Paramètres → « Personnalisation du suivi »
    (gérant) — nom affiché, couleur principale, couleur d'accent, logo
    (redimensionné à 256 px dans le navigateur), aperçu en direct. Une fois
    activée, la page de suivi public des colis de l'agence s'affiche à ses
    couleurs avec son logo ; aucune donnée personnelle n'y figure.
21. **Paiement en ligne (SasPay)** : sur la fiche d'un colis avec un reste à
    payer, « Payer en ligne (SasPay) » prépare la page de paiement hébergée
    (à ouvrir ou à envoyer au destinataire par WhatsApp) ; dès que SasPay
    confirme (webhook signé ou retour sur la fiche), le serveur vérifie la
    transaction et inscrit le montant dans la caisse du jour (« Paiement
    SasPay », mobile money). Sur la page Abonnement, le gérant paie
    l'abonnement dû ou recharge le portefeuille de la même façon. En démo,
    la page de paiement est **simulée** (« Payer » / « Refuser »).

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
- **Console plateforme en erreur sur le site déployé (mais OK en local)** :
  si `/api/plateforme/amorcage` renvoie le JSON `{"error":"Ressource introuvable."}`,
  la requête a atteint Express mais le chemin n'a pas été redéplié ; ce n'est
  pas le 404 NOT_FOUND de Vercel. Le rewrite
  `/api/plateforme/:action → /api/plateforme?action=:action` utilise désormais
  le point d'entrée dédié `api/plateforme.js` ; le handler et le middleware
  Express redéplient `?action=` et acceptent aussi les en-têtes de chemin
  original de Vercel. Le test de régression simule
  `/api/plateforme?action=amorcage`.
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
- **Tâche quotidienne non exécutée** : dans Vercel → *Settings* →
  *Environment Variables*, vérifiez `CRON_SECRET` (Production, au moins
  32 caractères), puis redéployez. Console plateforme → « Tâche quotidienne »
  → **Exécuter maintenant** ; la ligne « Tâche quotidienne » du panneau
  « Mise en service » doit passer à ✓. Le Cron Vercel se déclenche ensuite à
  05:00 UTC chaque jour.
- **Chaque déploiement Vercel échoue avec « No more than 12 Serverless
  Functions… »** : le dossier `api/` contient plus de 12 fichiers. Repliez
  les routes concernées via les `rewrites` de `vercel.json` (voir ci-dessus).

Conçu par **Shopin30** — support : [WhatsApp +225 0501303343](https://wa.me/2250501303343).
