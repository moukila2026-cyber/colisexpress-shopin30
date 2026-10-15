# COLIS EXPRESS — récapitulatif global (LOTS 1 à 13)

Document de synthèse destiné au propriétaire du projet : ce qui a été livré,
par quelle pull request, toutes les variables de Vercel (par environnement),
ce qu'il reste à faire côté plateforme, et les choix qui ont été tranchés au
passage. Aucune valeur de secret ne figure ici : seulement des noms, des
formats et des rôles.

Conçu par **Shopin30**. Application vanilla HTML/CSS/JS, API Express
(`lib/app.js`), Postgres (Neon en production, PGlite pour la démo et les
tests), déployée sur Vercel plan Hobby.

---

## 1. État actuel, en une ligne

**Les 13 lots sont livrés et fusionnés dans `main`.** `npm test` : **186 tests
verts**. Déploiement Vercel : **12 fonctions sur 12 autorisées** (limite
atteinte, marge zéro). Console plateforme : **0 ✗ attendu en production** une
fois `CRON_SECRET` ajoutée et la tâche quotidienne exécutée une fois. Les ⚠
restants sont normaux : transports de notifications non configurés (LOT 12
facultatif) et aucun webhook SasPay reçu pour l'instant.

---

## 2. Toutes les pull requests

| PR | Objet | Fusionnée le |
|---|---|---|
| #1 | Finalisation : visuels, UX mobile, QR code, partage WhatsApp, pages légales | 14/10/2026 |
| #2 | Agence de destination non inscrite : coordonnées et rattachement depuis la fiche colis | 14/10/2026 |
| #4 | Correctif : enregistrement d'un colis (transaction compatible) | 14/10/2026 |
| #5 | Correctif : diagnostic des refus d'accès et correctifs A–E | 14/10/2026 |
| #6 | Migration Firebase → Neon (Postgres), plus aucune dépendance Firebase | 14/10/2026 |
| #7 | Correctif : « Voir le colis » depuis le reçu et le tableau de bord | 15/10/2026 |
| #8 | Correctif : routage Vercel des routes imbriquées atteignant Express | 15/10/2026 |
| #9 | Correctif : fonctions Vercel dédiées aux routes imbriquées | 15/10/2026 |
| #10 | **LOT 1** — comptes agents nommés (équipe, sessions, traçabilité d'acteur) | 15/10/2026 |
| #11 | **LOT 2** — grille tarifaire, prix en menu déroulant, état de paiement, caisse | 15/10/2026 |
| #12 | **LOT 3** — mémoire client (carnet par agence) + devis public anonyme | 15/10/2026 |
| #13 | **LOT 4** — chaîne de preuve : bordereaux, photos, incidents, souffrance, alertes | 15/10/2026 |
| #14 | **LOT 5** — notifications aux deux agences (simulation, journal, sans donnée personnelle) | 15/10/2026 |
| #15 | **LOT 6** — plans, quotas, portefeuille prépayé, console plateforme | 15/10/2026 |
| #16 | **LOT 7** — suivi personnalisé par agence et paiements en ligne SasPay | 15/10/2026 |
| #17 | **LOT 8** — sécurité avant la mise en production | 15/10/2026 |
| #18 | **LOT 9** — mise en service assistée, sans terminal | 15/10/2026 |
| #19 | **LOT 10** — décompte des colis en temps réel (agence + console) | 15/10/2026 |
| #20 | Correctif urgent — routage Vercel de la console plateforme | 15/10/2026 |
| #21 | **LOT 11** — tâche quotidienne et rappels d'abonnement | 15/10/2026 |
| #22 | **LOT 12** — WhatsApp Cloud et Orange SMS CI | 15/10/2026 |
| #23 | **LOT 13** — relevés mensuels PDF en Node pur | 15/10/2026 |
| #24 | Récapitulatif global (ce document) | 15/10/2026 |

Toutes ces pull requests sont fusionnées dans `main` ; la case
« vérification production » est décochée dans leurs tableaux de vérification,
la production n'étant pas joignable depuis l'environnement de travail.

---

## 3. Ce que chaque lot a apporté

| Lot | Livré | Preuve |
|---|---|---|
| 1 | Comptes agents nommés par agence : gérant, agent, lecteur ; chaque écriture porte le nom de l'acteur ; désactivation d'un compte sans suppression. | `tests/api.test.mjs` (LOT 1), `tests/integration-page.test.mjs` |
| 2 | Grille tarifaire par axe, prix choisi en menu déroulant (le serveur recalcule et refuse un prix hors grille), état de paiement d'un colis, caisse du jour et clôture. | `tests/metier-tarifs.test.mjs`, `tests/metier-paiements.test.mjs` |
| 3 | Carnet de clients par agence (jamais partagé entre agences) et devis public anonyme utilisable sans compte. | `tests/metier-clients.test.mjs` |
| 4 | Bordereaux d'acheminement (scellé, contrôle à l'arrivée), photos de preuve horodatées, incidents avec arbitrage plateforme, colis en souffrance, alertes. | `tests/metier-bordereau.test.mjs`, `tests/metier-incidents.test.mjs` |
| 5 | Fonction d'envoi unique des notifications, journal complet, aucune donnée personnelle dans le journal, mode simulation par défaut. | `tests/metier-notifications.test.mjs` |
| 6 | Plans Gratuit / Pro / illimité, quotas mensuels, hors forfait 30 FCFA/colis, portefeuille prépayé, console plateforme (lecture seule + crédit et plan). | `tests/metier-plans.test.mjs` |
| 7 | Suivi public aux couleurs de l'agence expéditrice, paiement en ligne SasPay (abonnements et recharges **seulement**), webhook signé. | `tests/api.test.mjs` (LOT 7) |
| 8 | Garde-fous d'environnement (clé de test refusée en production, simulation refusée en production), `SESSION_SECRET` obligatoire dès qu'une vraie base est branchée, premier administrateur console créé sans terminal. | `tests/api.test.mjs` (LOT 8) |
| 9 | Guide `docs/mise-en-service.md` pas à pas et panneau « Mise en service » dans la console : une ligne ✓ / ⚠ / ✗ par point, sans jamais afficher la valeur d'un secret. | `tests/api.test.mjs` (LOT 9) |
| 10 | Compteur « Colis ce mois : 37 / 50 » sur chaque page agence, carte « Mon forfait », rafraîchissement léger toutes les 20 s, barre par agence dans la console. | `tests/api.test.mjs` (LOT 10) |
| 11 | Tâche quotidienne Vercel Cron à 05:00 UTC : ouverture du mois, escalades d'incident 24 h / 7 j, colis qui dorment, colis en souffrance, rappels d'abonnement J-2 / jour J / retard ; journal dans `taches_executions` ; console : 10 dernières exécutions + **Exécuter maintenant** ; archivage des relevés le 1er du mois. | `tests/api.test.mjs` (LOT 11), `lib/taches-quotidiennes.js` |
| 12 | Transports réels WhatsApp Cloud (prioritaire) puis Orange SMS CI (repli), journal des envois, mode **SIMULATION** tant que rien n'est configuré, panneau « Transports de notifications » dans la console, aucun numéro ni secret dans les logs. | `tests/api.test.mjs` (LOT 12), `lib/notifications.js` |
| 13 | Relevés mensuels PDF par agence, générés en Node pur (aucune dépendance native) : colis enregistrés, encaissements, hors forfait, abonnement, mouvements du portefeuille ; téléchargement depuis **Abonnement** et depuis la console ; archivage automatique le 1er du mois. 100 % français, FCFA. | `tests/pdf.test.mjs`, `tests/api.test.mjs` (LOT 13) |

---

## 4. Toutes les variables Vercel

Chemin des clics : Vercel → projet **colisexpress-shopin30** → **Settings** →
**Environment Variables** → **Add New**. Ne cochez que les environnements
indiqués.

| Variable | Production | Preview | Format attendu | Rôle |
|---|---|---|---|---|
| `DATABASE_URL` | ✔ (base principale) | ✔ (branche `preview`) | `postgresql://…neon.tech/…?sslmode=require` | Connexion à la base Neon (deux valeurs distinctes). |
| `SESSION_SECRET` | ✔ | ✔ (autre valeur) | ≥ 32 caractères aléatoires | Signature des cookies de connexion (agences et console). |
| `BLOB_READ_WRITE_TOKEN` | ✔ | ✔ | fournie par Vercel (`vercel_blob_rw_…`) | Photos de preuve et logos (store public `colisexpress-photos`). |
| `PLATEFORME_PREMIER_ADMIN_JETON` | **supprimée** | **supprimée** | ≥ 32 caractères | Jetons d'amorçage à usage unique : à retirer après usage. |
| `SASPAY_SECRET_KEY` | ✔ `sk_live_…` | ✔ `sk_test_…` | `sk_live_…` ou `sk_test_…` | Clé secrète SasPay (abonnements et recharges uniquement). |
| `SASPAY_WEBHOOK_SECRET` | ✔ | facultatif | chaîne affichée une fois par SasPay | Vérification de la signature des webhooks. |
| `APP_URL` | ✔ `https://colisexpress-shopin30.vercel.app` | **vide** | URL sans barre finale | Adresse de retour après paiement. |
| `SASPAY_MODE_FRAIS` | facultatif | facultatif | `ADD_ON` ou `DEDUCTED` | Qui paie les frais SasPay ; absente = réglage du compte. |
| `PAIEMENTS_SIMULATION` | **jamais** | facultatif `1` | `1` | Simulation de paiement sans clé (préversion uniquement). |
| `CRON_SECRET` | ✔ (à ajouter, Production **seulement**) | — | ≥ 32 caractères aléatoires | Authentifie Vercel Cron à 05:00 UTC (comparaison en temps constant). |
| `WHATSAPP_TOKEN` | facultatif | vide (recommandé) | jeton d'utilisateur système Meta | WhatsApp Cloud, prioritaire sur Orange SMS. |
| `WHATSAPP_PHONE_ID` *(ou `WHATSAPP_PHONE_NUMBER_ID`)* | facultatif | vide | identifiant numérique Meta | Numéro expéditeur WhatsApp Business. |
| `WHATSAPP_MODELE` | facultatif | vide | nom du modèle approuvé (ex. `colisexpress_notification`) | Modèle utility à deux variables. |
| `WHATSAPP_API_VERSION` | facultatif | vide | `vNN.0` | Version Graph utilisée par l'API WhatsApp. |
| `ORANGE_SMS_CLIENT_ID` | facultatif | vide | identifiant Orange Developer | Repli Orange SMS CI. |
| `ORANGE_SMS_CLIENT_SECRET` | facultatif | vide | secret OAuth Orange | Repli Orange SMS CI. |
| `ORANGE_SMS_NOM_EXPEDITEUR` | facultatif | vide | expéditeur numérique agréé (10 chiffres ou `tel:+225…`) | Repli Orange SMS CI. |
| `NOTIFICATIONS_CANAL` | facultatif | facultatif | `auto`, `whatsapp`, `sms` ou `simulation` | Force l'ordre des transports ; défaut `auto` (WhatsApp → SMS → simulation). |
| `VERCEL`, `VERCEL_ENV` | automatiques | automatiques | — | Définies par Vercel : **ne pas les créer**. |

Aucune variable n'est nécessaire pour les relevés PDF du LOT 13.

---

## 5. À faire de votre côté

Les étapes 1 à 5 concernent le LOT 11, les étapes 6 à 8 sont facultatives
(LOT 12), les étapes 9 à 11 sont les contrôles finaux. À chaque ajout de
variable : **Save**, puis Vercel → **Deployments** → menu ⋯ du dernier
déploiement Production → **Redeploy**.

1. **Créer `CRON_SECRET`.** Ouvrez n'importe quelle page du site, appuyez sur
   **F12** → onglet **Console**, tapez `crypto.randomUUID() + crypto.randomUUID()`
   puis **Entrée**. Copiez le résultat (il dépasse 32 caractères) sans le
   partager. Vercel → **Settings** → **Environment Variables** → **Add New** :
   *Key* `CRON_SECRET`, *Value* le résultat, cochez **Production** seulement
   (laissez Preview décoché) → **Save**, puis **Redeploy**.
2. Ouvrez `https://colisexpress-shopin30.vercel.app/plateforme.html` et
   connectez-vous avec le compte console (celui créé à l'étape « Premier
   compte console » du guide `docs/mise-en-service.md`).
3. Descendez jusqu'au panneau **Tâche quotidienne** et cliquez **Exécuter
   maintenant**. Le tableau doit afficher une exécution **Réussie** avec le
   nombre d'agences, de colis balayés et de rappels.
4. Restez sur la page et vérifiez le panneau **Mise en service** : la ligne
   **« Tâche quotidienne (Vercel Cron) »** doit passer à **✓** (coche verte).
   Vercel exécutera ensuite la tâche chaque jour à **05:00 UTC** (05:00 à
   Abidjan, qui ne change pas d'heure).
5. Ouvrez une page **Abonnement** avec un compte gérant, choisissez un mois
   dans **Relevés mensuels PDF**, cliquez **Télécharger le PDF** : le relevé
   s'ouvre ou se télécharge en français, en FCFA, sans donnée personnelle de
   client. Le même relevé est téléchargeable depuis la console (bloc
   **Relevé mensuel PDF**).
6. **(Facultatif) WhatsApp** : Meta for Developers → **Add product** →
   **WhatsApp** → copiez le **Phone number ID** ; WhatsApp Manager →
   **Message templates** → créez un modèle *Utility*, langue *French*, deux
   variables `{{1}}` et `{{2}}` sur deux lignes, nom par exemple
   `colisexpress_notification`, et attendez le statut **Approved** ; Meta
   Business Settings → **Users** → **System users** → **Generate new token**.
   Puis Vercel → **Settings** → **Environment Variables** → **Add New**, en
   **Production seulement** : `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`,
   `WHATSAPP_MODELE` (le nom du modèle), `WHATSAPP_API_VERSION` (`vNN.0`).
7. **(Facultatif) Orange SMS CI** : Orange Developer → activez l'API SMS
   Messaging CI → récupérez **Client ID** et **Client Secret**, faites
   approuver l'expéditeur. Vercel → **Settings** →
   **Environment Variables** → **Add New**, en **Production seulement** :
   `ORANGE_SMS_CLIENT_ID`, `ORANGE_SMS_CLIENT_SECRET`,
   `ORANGE_SMS_NOM_EXPEDITEUR` (10 chiffres ivoiriens ou `tel:+225XXXXXXXXXX`).
8. Après l'étape 6 ou 7 : **Redeploy**, puis console → panneau **Transports de
   notifications** : le canal effectif doit indiquer l'envoi réel, et le
   journal ne montre aucun numéro de téléphone. ⚠ Les envois réels partent
   alors vers les agences : commencez par un numéro d'agence de test que vous
   contrôlez.
9. **Contrôle final du panneau Mise en service** en production : **0 ✗**. Les
   ⚠ normaux sont : **Notifications (canal effectif)** tant que les transports
   ne sont pas configurés (étapes 6 à 8) et **Dernier webhook SasPay reçu**
   tant qu'aucun paiement réel n'a été confirmé (l'⚠ disparaît après le premier
   paiement d'abonnement ou de recharge, ou après un « Envoyer un test »
   depuis le tableau de bord SasPay). Tout le reste doit être ✓.
10. **Contrôle des agences** : une agence se connecte, enregistre un colis,
    prend une photo (Vercel Blob), encaisse à la caisse du jour, puis une
    deuxième agence contrôle le bordereau au départ et à l'arrivée.
11. **Contrôle du suivi public** : ouvrez `suivi.html?code=…` sur un
    téléphone, sans être connecté : aucune donnée personnelle n'apparaît, et
    la mise en forme reprend la marque de l'agence **expéditrice**.

---

## 6. Choix signalés (déjà tranchés, non rouverts)

| Sujet | Choix retenu | Pourquoi |
|---|---|---|
| Encaissement | Shopin30 n'encaisse **jamais** l'argent des colis ; seuls les abonnements et les recharges de portefeuille passent par SasPay (compte marchand Shopin30). | Le paiement en ligne d'un colis est refusé (403) : l'argent du colis reste à l'agence. |
| Hors forfait | 30 FCFA par colis au-delà du quota, y compris en plan Pro. | Le prix du colis baisse de 10 000 à 9 500 FCFA à partir de 30 colis ; c'est aussi le prix d'une recharge de 30 FCFA l'unité. |
| Abonnement impayé | Au-delà de J+7, l'agence repasse au quota Gratuit pour les **nouvelles créations** seulement. | Un impayé ne bloque **jamais** un colis en cours ni un retrait. |
| Destination | L'agence de destination ne paie jamais. | Elle est déjà rémunérée par le tarif inter-agences de l'expéditrice. |
| Échéances | Balayage à la consultation (LOT 5) **conservé** en plus du Cron quotidien. | Une agence qui ouvre sa page voit ses alertes tout de suite, même si le Cron a échoué. |
| SasPay sans clé en production | Paiement en ligne **désactivé**, aucun repli silencieux en simulation. | Évite de croire à un paiement encaissé qui ne l'est pas. |
| Marque du suivi public | Celle de l'agence **expéditrice**. | C'est elle qui a pris le colis et qui répond au client. |
| Fonctions Vercel | Limite Hobby de **12 fonctions atteinte**. Les routes à 3 segments et plus sont repliées par `vercel.json` (`?action=…`) puis redépliées par `lib/app.js`. | La prochaine route imbriquée devra passer par un `rewrite`, jamais par un nouveau fichier `api/`. |
| Notifications sans transport | Mode **SIMULATION** : le message reste dans le journal, jamais perdu. | Aucun envoi réel involontaire avant la configuration des transports. |
| PDF | Génération **en Node pur**, sans dépendance native ni bibliothèque externe. | Reste compatible avec l'environnement serverless Vercel et les tests hors ligne. |
| Récap production | La case « vérification production » reste décochée dans les pull requests. | La production n'est pas joignable depuis l'environnement de travail ; le contrôle se fait depuis la console. |

---

## 7. Points de vigilance pour la suite

1. **12 fonctions sur 12** : toute nouvelle route à trois segments ou plus doit
   être repliée par un `rewrite` dans `vercel.json` et servie par une fonction
   parente existante. `npm test` verrouille la liste des fichiers, les
   rewrites et la limite de 12.
2. **Les variables `WHATSAPP_*` et `ORANGE_SMS_*` ne doivent pas être créées en
   Preview** : la préversion doit rester en simulation pour ne pas envoyer de
   message réel pendant un test.
3. **`CRON_SECRET` en Production uniquement** : la préversion n'exécute pas la
   tâche.
4. **`PLATEFORME_PREMIER_ADMIN_JETON` ne doit pas exister** : s'il est encore
   dans la liste, supprimez-le.
5. Le Cron Vercel s'exécute en **UTC** ; Abidjan étant à UTC+0 toute l'année,
   05:00 UTC = 05:00 à Abidjan.
