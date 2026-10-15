# Mise en service de COLIS EXPRESS — guide pas à pas, sans terminal

Ce guide s'adresse à une personne **non développeuse**. Tout se fait depuis
des tableaux de bord dans le navigateur : Vercel, Neon, SasPay. À chaque
étape, un **contrôle** vous dit si c'est réussi. Le panneau **« Mise en
service »** de la console plateforme (`/plateforme.html`) reprend tous ces
contrôles avec un ✓ / ⚠ / ✗ et l'action à faire — sans jamais afficher la
valeur d'un secret.

> **Règle d'or :** une valeur secrète (clé, jeton, secret) se colle
> **uniquement** dans Vercel → *Settings* → *Environment Variables*. Jamais
> dans un e-mail, un chat ou un document. Si cela arrive, régénérez-la tout de
> suite.

**Générer une valeur secrète sans terminal :** ouvrez n'importe quelle page
en `https://`, appuyez sur **F12** (ou clic droit → *Inspecter*), onglet
**Console**, tapez `crypto.randomUUID() + crypto.randomUUID()` puis Entrée.
Copiez le texte affiché **sans les guillemets** (72 caractères). Un
générateur de mots de passe (64 caractères, lettres et chiffres) convient
aussi.

**Où sont les variables dans Vercel :** [vercel.com](https://vercel.com) →
votre projet `colisexpress-shopin30` → onglet **Settings** → **Environment
Variables**. Pour chaque variable : *Key* = le nom exact, *Value* = la
valeur, et cochez l'**environnement** (*Production*, *Preview*,
*Development*). Après tout changement : onglet **Deployments** → menu **⋯**
du dernier déploiement → **Redeploy** (les variables ne sont lues qu'au
déploiement).

---

## Étape 1 — Vercel Blob : photos et logos

Le disque de Vercel est **en lecture seule** : sans Blob, les photos de
preuve et les logos d'agence ne peuvent pas être enregistrés.

1. Vercel → votre projet → onglet **Storage** → **Create Database** →
   choisissez **Blob** → nom libre (ex. `colisexpress-photos`) → **Create**.
2. Cliquez **Connect to Project** → sélectionnez le projet → cochez
   *Production*, *Preview*, *Development* → **Connect**. Vercel ajoute
   automatiquement la variable `BLOB_READ_WRITE_TOKEN`.
3. **Redeploy**.

**Contrôle :** console → *Mise en service* → ligne « Photos et logos
(Vercel Blob) » = ✓. Test réel : dans une agence, Paramètres → Suivi
personnalisé → envoyez un logo PNG → il s'affiche sur la page de suivi d'un
colis.

## Étape 2 — Une base de préversion séparée (Neon)

La préversion (*Preview*) ne doit **jamais** toucher la vraie base.

1. [console.neon.tech](https://console.neon.tech) → votre projet →
   **Branches** → **Create branch**. Nom : `preview`. Si l'option
   **« Schema only »** (schéma seulement, sans les données) est proposée,
   choisissez-la : la préversion démarre vide, sans données réelles. Sinon,
   choisissez *Current data* et sachez que la branche contient une copie
   figée des données du moment.
2. Dans la branche `preview` → **Connection string** → copiez la valeur
   (elle commence par `postgresql://`).
3. Vercel → *Environment Variables* → `DATABASE_URL` : il doit exister
   **deux** valeurs, une cochée *Production* (base principale) et une cochée
   *Preview* (branche `preview`). Si une seule ligne couvre les deux : éditez-la
   pour ne garder que *Production*, puis **Add** une nouvelle `DATABASE_URL`
   avec la valeur de la branche `preview`, cochée *Preview* seulement.
4. **Cas de l'intégration Neon** (Vercel → *Integrations* → Neon) : si
   `DATABASE_URL` est marquée « managed by Neon », l'intégration crée
   elle-même une branche par déploiement de préversion — c'est l'équivalent.
   Vérifiez dans Neon → *Integrations* → Vercel que l'option **« Create a
   branch for each preview deployment »** est activée. Ne modifiez pas la
   variable à la main dans ce cas.
5. **Redeploy**.

**Contrôle :** ouvrez le panneau *Mise en service* sur la production
(`https://colisexpress-shopin30.vercel.app/plateforme.html`) puis sur une
préversion (URL `…-git-….vercel.app` dans *Deployments*) : la ligne « Base de
données » montre une **empreinte** (10 caractères). Les deux empreintes
doivent être **différentes**.

## Étape 3 — SESSION_SECRET distincte en Production et en Preview

Signe les cookies de connexion. Depuis le LOT 8, elle doit faire **au moins
32 caractères** dès qu'une vraie base est branchée ; sinon toutes les
connexions sont refusées avec un message clair.

1. Générez une valeur (voir en haut). Vercel → **Add** : *Key*
   `SESSION_SECRET`, *Value* = la valeur, cochez **Production** seulement →
   **Save**.
2. Générez une **autre** valeur. **Add** : `SESSION_SECRET`, cochez
   **Preview** seulement → **Save**.
3. **Redeploy**.

**Contrôle :** *Mise en service* → « SESSION_SECRET » = ✓ dans les deux
environnements. Les agences devront se reconnecter une fois (normal).

## Étape 4 — Premier compte console, puis plans des agences

1. Générez un jeton. Vercel → **Add** : `PLATEFORME_PREMIER_ADMIN_JETON`,
   *Production* → **Save** → **Redeploy**.
2. Ouvrez `https://colisexpress-shopin30.vercel.app/plateforme.html` : le
   cadre **« Créer le premier administrateur »** apparaît (seulement s'il
   n'existe encore aucun compte console). Saisissez le jeton, votre e-mail,
   votre nom et un mot de passe d'**au moins 12 caractères** → **Créer**.
   Vous êtes connecté à la console.
3. **Supprimez** la variable `PLATEFORME_PREMIER_ADMIN_JETON` (⋯ →
   *Remove*) → **Redeploy**. L'amorçage est de toute façon fermé pour
   toujours.
4. Refaites les étapes 1 à 3 avec un autre jeton pour la **Preview** si vous
   voulez une console sur la préversion (base séparée = comptes séparés).
5. **Plans des agences existantes** : console → tableau *Agences* →
   **Gérer** → pendant le pilote, par exemple plan **Réseau**, quota vide
   (= illimité), prix mensuel **0** → *Appliquer le plan*. Revenez au plan
   Gratuit ou Pro quand vous facturez.

**Contrôle :** le cadre d'amorçage a disparu ; la ligne *Agences* montre le
plan choisi.

## Étape 5 — SasPay (abonnements et recharges uniquement)

Rappel : **Shopin30 n'encaisse jamais l'argent des colis**. SasPay sert
seulement à l'abonnement et aux recharges de portefeuille, sur le compte
marchand de Shopin30.

1. **Compte et KYC** : [app.saspay.me](https://app.saspay.me) → créez le
   compte, vérifiez l'e-mail, créez le **marchand** (« Shopin30 »), puis
   soumettez le dossier **KYC** (pièce d'identité, selfie, RCCM et document
   fiscal pour un KYC entreprise). Attendez l'e-mail de validation : tant que
   le statut n'est pas « VERIFIED », aucun paiement n'est possible.
2. **Clé de test (Preview)** : tableau de bord → *Clés API* → **Créer** :
   nom « Preview », environnement **SANDBOX**, scope **PAYIN**. La clé
   complète (`sk_test_…`) n'est affichée **qu'une fois** : copiez-la aussitôt
   dans Vercel → **Add** `SASPAY_SECRET_KEY`, cochez **Preview** seulement.
3. **Clé réelle (Production)** : *Clés API* → **Créer** : nom
   « Production », environnement **LIVE**, scope **PAYIN** (ou BOTH). Copiez
   `sk_live_…` dans Vercel → **Add** `SASPAY_SECRET_KEY`, cochez
   **Production** seulement. ⚠ Jamais l'inverse : l'application désactive
   d'elle-même une clé `sk_test_` en production et une clé `sk_live_` en
   préversion.
4. **Webhook** : tableau de bord → *Webhooks* → **Créer** : URL
   `https://colisexpress-shopin30.vercel.app/api/paiements/webhook`,
   environnement LIVE, abonnements **transaction.success**,
   **transaction.failed**, **transaction.cancelled**. Le **secret de
   signature** est affiché **une seule fois** : copiez-le dans Vercel →
   **Add** `SASPAY_WEBHOOK_SECRET`, **Production**. (Perdu ? *Webhooks →
   Changer le secret*, puis remplacez la variable.) Pour la préversion, créez
   si vous voulez un second webhook SANDBOX vers l'URL de la préversion ; si
   la protection Vercel (*Deployment Protection*) bloque l'appel, ce n'est
   pas grave : la vérification au retour du paiement suffit.
5. **APP_URL** : **Add** `APP_URL` = `https://colisexpress-shopin30.vercel.app`
   (sans barre finale), **Production seulement**. Laissez-la **vide en
   Preview** pour que le retour de paiement revienne sur la préversion.
6. **SASPAY_MODE_FRAIS** (facultatif) : `ADD_ON` (le payeur supporte les
   frais) ou `DEDUCTED` (Shopin30 les absorbe). Pour qu'elle soit prise en
   compte, activez dans SasPay → *Paramètres* → *Frais* l'option « Autoriser
   le choix du mode de frais par l'API ».
7. **Redeploy**.

**Contrôle :** *Mise en service* → « Paiement en ligne SasPay » = ✓ mode
`live` en production, `test` en préversion ; « SASPAY_WEBHOOK_SECRET » = ✓ ;
« APP_URL » = ✓. Puis SasPay → *Webhooks* → **Envoyer un test** : la ligne
« Dernier webhook SasPay reçu » affiche `webhook.test`. Enfin, sur la
préversion, faites une recharge de 100 FCFA avec la clé de test : le
portefeuille de l'agence est crédité.

## Étape 6 — Tâche quotidienne (LOT 11) et variables des notifications (LOT 12)

La tâche Vercel se lance automatiquement **chaque jour à 05:00 UTC**. Elle
ouvre le mois pour les agences, balaie les incidents (24 h / file plateforme
> 7 j), les colis qui dorment et les colis en souffrance, puis crée les rappels
d'abonnement à J-2, le jour de l'échéance et en retard. La console permet
également une exécution manuelle.

### Ajouter `CRON_SECRET` (Production seulement)

1. Dans votre navigateur, ouvrez une page quelconque du site. Ouvrez les
   outils développeur (**F12**) puis l'onglet **Console**. Saisissez
   `crypto.randomUUID() + crypto.randomUUID()` puis **Entrée**. Copiez le
   résultat sans le partager : il dépasse les 32 caractères requis.
2. Vercel → votre projet → **Settings** → **Environment Variables** →
   **Add New**. *Key* : `CRON_SECRET`. *Value* : le résultat généré. Cochez
   **Production** seulement (ne cochez pas Preview) → **Save**.
3. Vercel → **Deployments** → menu ⋯ du dernier déploiement Production →
   **Redeploy** → confirmez **Redeploy**.
4. Ouvrez `https://colisexpress-shopin30.vercel.app/plateforme.html`,
   connectez-vous à la console (compte plateforme distinct des comptes
   agence), descendez à **Tâche quotidienne** et cliquez **Exécuter
   maintenant**. Le tableau doit afficher une exécution « Réussie ».
5. Dans **Mise en service**, la ligne « Tâche quotidienne » passe à ✓. Vercel
   exécutera ensuite la tâche à 05:00 UTC chaque jour.

### Configurer WhatsApp Cloud (facultatif, Production)

⚠ Une fois activé, les notifications réelles partent vers les agences
concernées. Commencez par un numéro d'agence de test que vous contrôlez.

1. Meta for Developers → **My Apps** → **Create App** (type Business), puis
   **Add product** → **WhatsApp**. Dans *WhatsApp → API Setup*, reliez le
   compte WhatsApp Business et copiez le **Phone number ID** (identifiant
   numérique, pas le numéro de téléphone).
2. WhatsApp Manager → **Message templates** → **Create template** : nom
   `colisexpress_notification`, catégorie *Utility*, langue *French*. Dans le
   corps, mettez exactement deux variables de texte sur deux lignes :
   `{{1}}` puis `{{2}}`. Soumettez le modèle et attendez le statut **Approved**.
   L'application envoie le titre dans `{{1}}` et le message dans `{{2}}`.
3. Meta Business Settings → **Users** → **System users** → créez/sélectionnez
   un utilisateur système → **Generate new token**. Choisissez votre
   application et les permissions WhatsApp demandées par Meta, dont
   `whatsapp_business_messaging`. Copiez le jeton tout de suite ; ne le
   partagez pas et ne le collez jamais dans un message.
4. Dans Vercel → projet **colisexpress-shopin30** → **Settings** →
   **Environment Variables** → **Add New**, créez ces quatre variables,
   toutes cochées **Production seulement** :
   - `WHATSAPP_TOKEN` = jeton d'accès Meta ;
   - `WHATSAPP_PHONE_ID` = Phone number ID ;
   - `WHATSAPP_MODELE` = `colisexpress_notification` ;
   - `WHATSAPP_API_VERSION` = version Graph actuellement prise en charge,
     au format `vNN.0` (celle affichée par Meta pour votre application).
   Cliquez **Save** après chaque variable, puis **Redeploy** le dernier
   déploiement Production.

### Configurer Orange SMS Côte d'Ivoire (facultatif, repli)

1. Orange Developer → créez/ouvrez votre application → activez l'API SMS
   Messaging pour la Côte d'Ivoire. Obtenez le **Client ID** et le
   **Client Secret** (OAuth client credentials) et faites approuver l'adresse
   d'expéditeur par Orange.
2. Vercel → projet → **Settings** → **Environment Variables** → **Add New**.
   Ajoutez en **Production seulement** : `ORANGE_SMS_CLIENT_ID`,
   `ORANGE_SMS_CLIENT_SECRET` et `ORANGE_SMS_NOM_EXPEDITEUR`. Pour
   `ORANGE_SMS_NOM_EXPEDITEUR`, saisissez l'adresse numérique autorisée, soit
   les 10 chiffres ivoiriens, soit le format `tel:+225XXXXXXXXXX` fourni par
   Orange. Cliquez **Save** après chaque ligne, puis **Redeploy**.
3. Le système essaie WhatsApp d'abord, puis Orange SMS si WhatsApp échoue ; si
   aucun transport n'est configuré ou si les deux sont indisponibles, le
   message reste dans le journal en **simulation**. La console → **Transports
   de notifications** affiche le canal effectif et le journal, sans afficher
   de numéro ni de secret. L'agence de test doit recevoir un message conforme
   au modèle approuvé.

`WHATSAPP_PHONE_NUMBER_ID` est également accepté comme alias de
`WHATSAPP_PHONE_ID`. Laissez les variables de transports absentes en Preview
pour conserver la simulation.

`NOTIFICATIONS_CANAL` est facultative : absente = ordre automatique WhatsApp
→ SMS → simulation ; `simulation` force la simulation ; `sms` force Orange
avec simulation en repli. Ajoutez-la dans Vercel uniquement si vous voulez
forcer ce comportement.

| Variable | Production | Preview | Rôle |
|---|---|---|---|
| `WHATSAPP_TOKEN` | facultatif | vide (recommandé) | Jeton Meta secret. |
| `WHATSAPP_PHONE_ID` (ou `WHATSAPP_PHONE_NUMBER_ID`) | facultatif | vide | Phone number ID de Meta. |
| `WHATSAPP_MODELE` | facultatif | vide | Nom du modèle approuvé (ex. `colisexpress_notification`). |
| `WHATSAPP_API_VERSION` | facultatif | vide | Version Graph au format `vNN.0`. |
| `ORANGE_SMS_CLIENT_ID` | facultatif | vide | Identifiant Orange Developer. |
| `ORANGE_SMS_CLIENT_SECRET` | facultatif | vide | Secret OAuth Orange. |
| `ORANGE_SMS_NOM_EXPEDITEUR` | facultatif | vide | Expéditeur numérique approuvé par Orange. |
| `NOTIFICATIONS_CANAL` | facultatif | facultatif | `auto`, `whatsapp`, `sms` ou `simulation` (défaut `auto`). |

En l'absence de transports, les notifications restent en **simulation** ;
elles ne sont jamais perdues.

## Étape 7 — Vérifications finales

1. Production, non connecté : la page d'accueil, le devis public et le suivi
   d'un colis (`suivi.html?code=…`) fonctionnent, sans donnée personnelle.
2. Une agence se connecte, crée un colis, prend une photo : OK (Blob).
3. La console affiche *Mise en service* avec **0 ✗** en production. Après
   une exécution réussie, la ligne Cron est ✓. Les notifications restent en
   simulation tant que les transports facultatifs ne sont pas configurés.
4. Les relevés mensuels PDF ne nécessitent aucune variable Vercel : ils sont
   téléchargeables depuis Abonnement et la console, et le Cron archive le
   mois précédent le 1er de chaque mois.
5. Préversion : empreinte de base différente, mode de paiement `test`,
   `APP_URL` vide.
6. Les variables d'amorçage (`PLATEFORME_PREMIER_ADMIN_JETON`) ont été
   supprimées.

> **Vue d'ensemble** : [`docs/recapitulatif-global.md`](recapitulatif-global.md)
> résume les 13 lots, toutes les pull requests, la liste complète des
> variables Vercel (par environnement) et les étapes restantes côté
> plateforme.

---

## Tableau des variables

Jamais de valeur réelle ici : seulement le nom, l'environnement, le format
attendu et le rôle.

| Variable | Production | Preview | Format attendu | Rôle |
|---|---|---|---|---|
| `DATABASE_URL` | ✔ (base principale) | ✔ (branche `preview`) | `postgresql://…neon.tech/…?sslmode=require` | Connexion à la base Neon (valeurs différentes). |
| `SESSION_SECRET` | ✔ | ✔ (autre valeur) | ≥ 32 caractères aléatoires | Signature des cookies de connexion (agences et console). |
| `BLOB_READ_WRITE_TOKEN` | ✔ | ✔ | ajoutée par Vercel (`vercel_blob_rw_…`) | Stockage des photos de preuve et des logos. |
| `PLATEFORME_PREMIER_ADMIN_JETON` | temporaire | temporaire | ≥ 32 caractères | Création du premier compte console, puis **à supprimer**. |
| `SASPAY_SECRET_KEY` | ✔ `sk_live_…` | ✔ `sk_test_…` | `sk_live_…` ou `sk_test_…` | Clé secrète SasPay (abonnement et recharges seulement). |
| `SASPAY_WEBHOOK_SECRET` | ✔ | facultatif | chaîne affichée une fois par SasPay | Vérification de la signature des webhooks. |
| `APP_URL` | ✔ `https://colisexpress-shopin30.vercel.app` | **vide** | URL sans barre finale | Adresse de retour après paiement. |
| `SASPAY_MODE_FRAIS` | facultatif | facultatif | `ADD_ON` ou `DEDUCTED` | Qui paie les frais SasPay. Absente = réglage du compte. |
| `PAIEMENTS_SIMULATION` | **jamais** | facultatif `1` | `1` | Simulation de paiement sans clé (préversion uniquement). |
| `NOTIFICATIONS_CANAL` | facultatif | facultatif | `auto`, `whatsapp`, `sms`, `simulation` | Ordre des transports (LOT 12) ; défaut WhatsApp → SMS → simulation. |
| `CRON_SECRET` | ✔ (Production seulement) | — | ≥ 32 caractères | Authentifie Vercel Cron à 05:00 UTC. |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` (ou `WHATSAPP_PHONE_NUMBER_ID`) / `WHATSAPP_MODELE` / `WHATSAPP_API_VERSION` | facultatif | vide recommandé | jeton / ID numérique / modèle approuvé / `vNN.0` | WhatsApp Cloud, prioritaire sur SMS. |
| `ORANGE_SMS_CLIENT_ID` / `ORANGE_SMS_CLIENT_SECRET` / `ORANGE_SMS_NOM_EXPEDITEUR` | facultatif | vide recommandé | OAuth / expéditeur numérique agréé | Repli Orange SMS CI. |
| `VERCEL_ENV`, `VERCEL` | automatiques | automatiques | — | Définies par Vercel : ne pas les créer. |
