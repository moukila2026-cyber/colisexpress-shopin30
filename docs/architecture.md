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
  `js/metier-incidents.js` et `js/metier-alertes.js` (LOT 4),
  `js/metier-notifications.js` (LOT 5), `js/metier-plans.js` (LOT 6),
  `js/metier-marque.js` et `js/metier-paiements.js` (LOT 7).
- **Photos de preuve** (`lib/photos.js`) : le stockage objet est isolé derrière
  `stockerObjet()` / `lireObjet()` — Vercel Blob si `BLOB_READ_WRITE_TOKEN`
  est défini, sinon disque local (`PHOTOS_DIR`, défaut `uploads/photos`).
  Aucun base64 géant en base : `photos` ne stocke que la clé et les métadonnées.
- **Notifications** (`lib/notifications.js`, LOT 5) : même principe
  d'isolation — une seule fonction d'envoi (`envoyerNotification()`) devant
  un registre de transports ; simulation par défaut (voir plus bas).
- **Base** (`db/schema.sql`) : `agencies`, `parcels`, `agents` (LOT 1),
  `tarifs`, `encaissements`, `caisse_closures` (LOT 2), `clients` (LOT 3),
  `bordereaux`, `photos`, `incidents` + colonnes `bordereau_id`/`retour_*`
  sur `parcels` (LOT 4), `notifications` (LOT 5), colonnes de plan et de
  portefeuille sur `agencies`, `facturation_periodes`,
  `portefeuille_mouvements`, `plateforme_admins` (LOT 6), colonnes
  `marque_*` sur `agencies`, `paiements_en_ligne`, `paiements_webhooks`
  (LOT 7).

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

### `notifications` (LOT 5 — notifications aux deux agences)

- **Événements** (catalogue `TYPES_NOTIFICATION`, `js/metier-notifications.js`) :
  `incident_ouvert` (manuel, ou automatique pour un absent au contrôle),
  `incident_escalade` (non résolu > 24 h), `bordereau_arrive`,
  `bordereau_ecart`, `colis_souffrance`, `retour_decide`, `retour_recu`,
  `alerte_sans_mouvement` / `alerte_non_retire` / `alerte_non_rattache`
  (colis qui dorment, mêmes seuils que `evaluerAlertes()`).
- **Destinataires** : `agencesConcernees()` — les deux agences du colis (ou du
  bordereau), une seule si la destination n'est pas rattachée. Jamais de
  client ni de tiers.
- **Aucune donnée personnelle** : `construireNotification()` lit uniquement
  codes de suivi / bordereau, villes, type d'incident, durées et nombre de
  colis (projections explicites) — ni nom, ni téléphone, ni CNI, ni identité
  d'agent, ni note libre, ni téléphone du transporteur.
- **Fonction d'envoi unique** (`lib/notifications.js`) :
  `notifier(evenement)` → `notificationsPourAgences()` → pour chaque agence
  `envoyerNotification()` : (1) `INSERT … ON CONFLICT (dedup_key) DO NOTHING`
  réserve la clé de dédoublonnage `type:ref[:début d'épisode]:agence` (une
  seule notification par événement et par agence, même en concurrence) ;
  (2) transport du canal effectif ; (3) statut journalisé (`simule`,
  `envoye` ou `echec` avec un message générique, jamais l'erreur brute).
- **Canal** (`configurationNotifications()`) : `NOTIFICATIONS_CANAL`
  (défaut `simulation`). `whatsapp`, `sms`, `email` sont déclarés dans
  `TRANSPORTS` avec leurs variables d'environnement requises mais
  `envoyer: null` : tant qu'un transport n'est pas branché **et** configuré,
  le canal effectif reste la simulation (aucun envoi réel). L'API ne renvoie
  jamais la valeur d'une variable d'environnement.
- **Échéances sans tâche planifiée** : `balayerEcheances()` est appelé par
  `GET /api/alertes` (tableau de bord, rafraîchi toutes les 20 s) et
  `GET /api/notifications`. Il évalue `evenementsEcheance()` sur les colis de
  l'agence appelante, écarte en une requête les clés déjà journalisées et
  notifie les **deux** agences — quelle que soit celle qui consulte.
  Idempotent ; un colis qui « redort » après avoir bougé ouvre un nouvel
  épisode (clé datée par `sinceISO`).
- **Jamais bloquant** : `notifier()` et `balayerEcheances()` absorbent toute
  erreur (journal serveur sans donnée personnelle) — l'opération métier
  aboutit même si le journal est indisponible (testé).
- **Routes** : `GET /api/notifications` (journal des 300 dernières, compteur
  `nonLues`, configuration sans secret ; `?resume=1` = compteur seul, sans
  balayage, pour le badge de la barre latérale) et
  `POST /api/notifications/lecture` (`{ ids: [...] }` ou `{ toutes: true }`,
  limité au journal de l'agence appelante). Sur Vercel, cette route à
  3 segments est repliée par le rewrite `/api/notifications/:action` →
  `/api/notifications?action=:action` : **aucune nouvelle fonction
  serverless** (10/12).
- **Interface** : `notifications.html` + `js/notifications.js` (filtres par
  famille, non lues, « marquer comme lue », ouvrir = lire), lien
  « Notifications » avec compteur dans `agencySidebar()`.

### Plans, quotas, portefeuille et console plateforme (LOT 6)

- **Plans** (`PLANS`, `js/metier-plans.js`) : `gratuit` (50 colis/mois,
  puis 30 FCFA par colis prépayés), `pro` (10 000 FCFA/mois, 500 colis
  inclus, même dépassement), `reseau` (sur devis : `quota_negocie`, NULL =
  illimité, et `prix_negocie_fcfa`, fixés par la console). Colonnes
  additives sur `agencies` : `plan`, `plan_suivant` (retour au Gratuit
  programmé), `portefeuille_fcfa` avec `CHECK (portefeuille_fcfa >= 0)`.
- **Période mensuelle** (`facturation_periodes`, PK `(agency_id, periode)`,
  `periode` = « AAAA-MM », fuseau d'Abidjan = UTC) : ouverte paresseusement
  au premier besoin (`ouvrirPeriode()`), elle fige plan et quota, crée
  l'abonnement dû (échéance J+7) et le prélève si le solde le permet.
- **Quota** : `reserverCreation()` est appelé par `POST /api/colis` et nulle
  part ailleurs. Rang atomique (`UPDATE … SET colis_comptes = colis_comptes
  + 1 RETURNING`) ; au-delà du quota effectif, débit conditionnel
  (`UPDATE agencies … WHERE portefeuille_fcfa >= 30`) journalisé dans la
  même instruction (CTE). Échec → rang rendu, **402** avec un message
  français. Si l'enregistrement du colis échoue ensuite, la réservation est
  rendue (remboursement journalisé `ajustement`). Une panne inattendue de la
  facturation est journalisée et n'empêche pas l'agence de travailler.
- **Invariants** : seule l'agence **expéditrice** est comptée — la
  destination ne paie jamais ; lecture, progression, réception, contrôle,
  retour et suivi public ne consultent jamais la facturation (testé avec une
  expéditrice en impayé et une destination au quota, portefeuille vide).
- **Impayé** : abonnement `du` après l'échéance → quota effectif ramené à
  celui du Gratuit (`quotaEffectif()`) tant qu'il n'est pas réglé ; seule la
  création de nouveaux colis est concernée.
- **Portefeuille** (`portefeuille_mouvements`, immuable) : `recharge`,
  `depassement`, `abonnement`, `ajustement`, montant signé et solde après
  opération. Recharge par la console (référence du paiement reçu, nom de
  l'opérateur) ; l'abonnement dû est réglé automatiquement dès que le solde
  le permet. Paiement en ligne : LOT 7.
- **Changements de plan** : gérant (garde serveur) Gratuit → Pro immédiat
  (abonnement dû, prélevé si possible), Pro → Gratuit au mois suivant
  (annulable) ; console : tout plan, effet immédiat sur le quota (un
  abonnement déjà payé reste acquis).
- **Console plateforme** : compte séparé (`plateforme_admins`), connexion
  `POST /api/plateforme/connexion`, cookie `ce_plateforme` (HttpOnly,
  `SameSite=Strict`, 12 h) signé dans un domaine HMAC distinct de celui des
  agences — aucun jeton ne vaut pour l'autre espace. `GET /api/plateforme`
  (`lib/plateforme.js`, lecture seule, n'ouvre aucune période) : indicateurs,
  `fileIncidents` (`escaladeIncident().filePlateforme`, > 7 j), litiges
  (incidents `conteste`), agences (plan, compteur, portefeuille,
  abonnement, volumes envoyés/reçus, incidents ouverts), volumes par mois et
  par statut ; aucune donnée client projetée. Écritures :
  `POST /api/plateforme/plan` et `POST /api/plateforme/credit`. Comptes de
  production : `npm run plateforme-admin` (variables d'environnement).
- **Vercel** : `/api/facturation/:action` et `/api/plateforme/:action` sont
  repliées par rewrites sur `api/[...path].js` — toujours 10 fonctions.

### Suivi personnalisé et paiements SasPay (LOT 7)

- **Marque d'agence** (colonnes `marque_*` sur `agencies`, facultatives) :
  `PUT /api/marque` (gérant) valide nom affiché (2–60), couleurs `#rrggbb`
  (`validerMarque()` + contrainte SQL `~ '^#[0-9a-f]{6}$'`) et logo
  (`validerLogo()` : PNG/JPEG/WebP reconnus sur leurs octets, ≤ 300 Ko,
  jamais de SVG) stocké par `lib/photos.js`. Le suivi public
  (`GET /api/suivi/:code`) ajoute `marque` (nom, couleurs, couleur de texte
  lisible, présence d'un logo) de l'agence **expéditrice** si elle est
  active ; le logo est servi par `GET /api/suivi/:code/logo`
  (`nosniff`, CSP `default-src 'none'`). Côté navigateur, `variablesMarque()`
  revalide les couleurs avant l'attribut `style`.
- **Abstraction de paiement** (`lib/paiements.js`) : `configurationPaiements()`
  (simulation sans clé en démo/dev/tests ou avec `PAIEMENTS_SIMULATION=1` ;
  désactivé en production sans clé ; `sk_test_` → test ; `sk_live_` → réel),
  `fournisseurPaiement(mode)` → `{ creerSession, statutSession,
  verifierTransaction }` (SasPay : `POST /checkout-sessions/`,
  `GET /checkout-sessions/{id}/status/`, `GET /payments/{id}/verify/`, clé en
  Bearer côté serveur, montants « 3500.00 », XOF, pays CI ; simulation : page
  `paiement-simulation.html`, état en base).
- **Cycle** (`paiements_en_ligne`) : création (`en_attente`, mode figé,
  session réutilisée 30 min contre les doubles clics — SasPay n'accepte pas
  d'`Idempotency-Key` sur cette route) → confirmation `confirmerPaiement()`
  déclenchée par le retour navigateur (`POST /api/paiements/verifier`), le
  webhook ou un rafraîchissement : statut de session `PAID` puis `verify`
  `SUCCESS` au montant exact et en XOF (`transactionConforme()`), sinon rien
  n'est appliqué. Effet appliqué **une seule fois** : le drapeau
  `effet_applique` bascule dans la même instruction SQL que l'écriture
  (encaissement « Paiement SasPay » + mise à jour du colis, ou crédit du
  portefeuille journalisé puis `reglerAbonnement()`).
- **Webhook** `POST /api/paiements/webhook` (public) : corps brut conservé
  par le middleware JSON, `X-Webhook-Signature` = HMAC-SHA256 hex de
  « horodatage.corps » avec `SASPAY_WEBHOOK_SECRET`, `X-Webhook-Timestamp`
  à ± 300 s, `timingSafeEqual` ; 403 sinon (503 sans secret). Il ne fait que
  déclencher la vérification des paiements concernés ; journal minimal
  (`paiements_webhooks` : événement + identifiant de transaction, jamais le
  numéro débité).
- **Données personnelles** : le « client » transmis à SasPay est l'agence
  (nom et e-mail professionnels) ; le payeur saisit son numéro sur la page
  SasPay.
- **Vercel** : rewrites `/api/paiements/:action` et
  `/api/suivi/:code/:action` ; `/api/marque` est une route à un segment —
  toujours 10 fonctions.

### Sécurité avant la mise en production (LOT 8)

- **Shopin30 n'encaisse jamais l'argent des colis.** `validerDemandePaiement()`
  distingue `OBJETS_PAIEMENT_CREATION` (`abonnement`, `recharge`) de
  `OBJETS_PAIEMENT` (historique, `colis` compris) ; l'objet `colis` renvoie
  `{ error, status: 403 }` et `POST /api/paiements` répond 403 avec le
  message « l'agence encaisse elle-même au guichet ». `creerPaiement()`
  refuse aussi l'objet (défense en profondeur). Les lignes historiques
  `objet = 'colis'` restent lisibles (`GET /api/paiements?parcelId=`) et
  `appliquerEffet()` sait encore les appliquer une seule fois : le webhook
  et `confirmerPaiement()` ne plantent pas dessus. Aucune migration
  destructive (la contrainte `CHECK (objet IN (…))` garde `colis`).
  Interface : plus de bouton ni de lien SasPay dans `js/colis.js` ; la caisse
  et l'encaissement au guichet ne changent pas ; `paiement-simulation.html`
  ne traite que l'abonnement et la recharge.
- **Garde-fous de paiement** (`configurationPaiements(env)`, selon
  `VERCEL_ENV`) : production → `sk_live_` seule ; `sk_test_` ou
  `PAIEMENTS_SIMULATION=1` → `desactive` avec raison explicite ; preview /
  development → `sk_live_` refusée ; hors Vercel, `sk_live_` sans
  `DATABASE_URL` refusée (jamais d'argent réel sur une base de test), et la
  simulation reste le défaut sans `DATABASE_URL`.
- **Frais SasPay** : `SASPAY_MODE_FRAIS` (`ADD_ON` | `DEDUCTED`) → champ
  `fee_charge_mode` de `POST /checkout-sessions/`. D'après la doc SasPay,
  `requested_amount` est toujours le montant demandé ; `ADD_ON` :
  `debited_amount = montant + frais`, `net_amount = montant` ; `DEDUCTED` :
  `debited_amount = montant`, `net_amount = montant − frais`.
  `transactionConforme()` compare le montant attendu à
  `montantDemandeFCFA()` (`requested_amount`, à défaut `net_amount` en
  ADD_ON ou `debited_amount` en DEDUCTED) ; le crédit du portefeuille reste
  le montant demandé dans les deux modes.
- **Sessions** : `etatSecretSession(env)` → `{ ok, exige, longueur, raison }`
  (jamais la valeur). `exige` = `DATABASE_URL` définie ou
  `VERCEL_ENV=production` ; alors `SESSION_SECRET` doit faire ≥ 32
  caractères, sinon `secret()` lève `ErreurConfigurationSession` (503) :
  `getSessionCharge()`, `getPlatformCharge()`, `createSessionToken()` et
  les routes de connexion/inscription refusent, le gestionnaire d'erreurs
  renvoie le message clair. `SECRET_DEV` n'est utilisé qu'en démo locale.
- **Amorçage du premier administrateur** (`lib/plateforme.js`) :
  `GET /api/plateforme/amorcage` → `{ disponible, motif }` (`ouvert`,
  `ferme`, `jeton_absent`) ; `POST /api/plateforme/amorcage` (jeton,
  e-mail, nom, mot de passe ≥ 12). Jeton `PLATEFORME_PREMIER_ADMIN_JETON`
  ≥ 32 caractères comparé via `timingSafeEqual` sur empreintes SHA-256 ;
  création atomique en une instruction (`INSERT … ON CONFLICT (cle) DO
  NOTHING` dans `plateforme_amorcage` + `INSERT … WHERE NOT EXISTS
  (administrateur actif)`) ; 5 jetons faux par adresse et par 15 min → 429 ;
  ensuite fermé pour toujours (même si tous les administrateurs sont
  désactivés). Routes repliées par le rewrite `/api/plateforme/:action`
  existant — toujours 10 fonctions.

### Mise en service assistée (LOT 9)

- `lib/mise-en-service.js` → `diagnosticMiseEnService({ env, hoteRequete })`
  renvoie `{ environnement, production, resume, lignes[] }` ; chaque ligne :
  `{ cle, libelle, etat: ok|attention|erreur, detail, action }`. Points :
  environnement (`VERCEL_ENV`), base (Neon ou démo + `empreinteHoteBase()` =
  10 hex de SHA-256 de l'hôte, non réversible, pour comparer Preview et
  Production), `SESSION_SECRET` (`etatSecretSession`), `BLOB_READ_WRITE_TOKEN`,
  paiement (`configurationPaiements`, cohérence avec l'environnement ;
  `erreur: true` distingue une mauvaise configuration d'une absence),
  `SASPAY_WEBHOOK_SECRET`, `APP_URL` (production : égale à l'hôte de la
  requête ; préversion : vide = normal), dernier webhook
  (`paiements_webhooks`), canal de notifications, tâche quotidienne
  (`taches_executions`, table additive remplie au LOT 11, `CRON_SECRET`),
  agences Gratuit ≥ 80 % du quota.
- **Jamais de valeur de secret** : le module ne lit que la présence, la
  longueur et le mode ; les tests vérifient qu'aucune valeur (ni sa fin) ne
  sort dans le JSON.
- Route `GET /api/plateforme/mise-en-service` (`requirePlateforme`, lecture
  seule, `Cache-Control: no-store`), repliée par le rewrite
  `/api/plateforme/:action` — toujours 10 fonctions. Panneau en tête de la
  console (`plateforme.html`, `js/plateforme.js`).
- Guide pas à pas : `docs/mise-en-service.md`.

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
| quota : la destination ne paie jamais | `reserverCreation({ agencyId: session })` uniquement dans `POST /api/colis` ; aucune autre route ne lit la facturation |
| abonnement : gérant seul | `requireGerantFacturation` sur `POST /api/facturation/*` ; plan Réseau réservé à la console |
| suivi personnalisé : gérant seul, rien de personnel | `PUT /api/marque` refusé aux agents ; `marquePublique()` ne projette ni contact ni clé de stockage |
| colis jamais payés en ligne à Shopin30 | `POST /api/paiements` : objet `colis` → 403 (`validerDemandePaiement`), `creerPaiement()` refuse aussi |
| secret de session fort hors démo | `verifierSecretSession()` sur connexion, inscription, `requireAgency`, `requirePlateforme` → 503 tant que `SESSION_SECRET` < 32 caractères |
| premier administrateur : une seule fois | `creerPremierAdmin()` : jeton en temps constant, ligne unique `plateforme_amorcage`, aucun administrateur actif |
| paiement appliqué une seule fois, après vérification | `confirmerPaiement()` (session `PAID` + `verify` `SUCCESS`, montant exact) et drapeau `effet_applique` dans la même instruction que l'écriture |
| webhook authentique | `verifierSignatureWebhook()` : HMAC du corps brut, ± 300 s, temps constant |
| console plateforme : compte séparé | `requirePlateforme` (cookie `ce_plateforme`, domaine de signature distinct, compte actif) |
| notifications : chaque agence son journal | `WHERE agency_id = $session` en lecture comme en marquage « lu » ; destinataires calculés côté serveur (`agencesConcernees()`) |

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
alertes ; LOT 5 : notifications aux deux agences sans donnée personnelle,
journal cloisonné, bordereau arrivé / écart, souffrance et retour,
échéances balayées une fois par épisode, panne de transport ou de journal
jamais bloquante ; LOT 6 : quota puis dépassement prépayé et refus 402,
destination jamais comptée, colis en cours jamais bloqués par un impayé,
abonnement Pro et échéances, retour au Gratuit au mois suivant, console
plateforme séparée, concurrence sur le compteur et le portefeuille ; LOT 7 :
suivi personnalisé et logo vérifié, paiement simulé du reste d'un colis
appliqué une seule fois, abonnement et recharge, mode TEST contre un faux
SasPay local — requête sans donnée client, webhooks signés, rejeu et
signature refusés, montant vérifié). Les règles pures sont testées dans
`tests/metier-*.test.mjs` et le câblage Vercel dans
`tests/integration-page.test.mjs`.

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
