# COLIS EXPRESS

Application web statique, **100 % en français**, de gestion d'envoi et de réception de colis multi-agences. Elle fonctionne avec Firebase Authentication et Cloud Firestore, sans framework ni serveur applicatif.

- Interface mobile-first (vert foncé / orange)
- Montants en **FCFA**
- Suivi public en temps réel avec code `CLI-XXXXXX`
- Données privées (téléphone, CNI) séparées du suivi public
- Visuels (accueil, suivi, espace agence, connexion) dans `assets/img/`
- Menu mobile, FAQ, états vides guidés, QR code sur le reçu
- Partage du suivi par WhatsApp (destinataire et expéditeur)
- Pages Conditions d'utilisation, Confidentialité et 404
- Déploiement direct sur GitHub Pages ou Vercel (instructions Vercel ci-dessous)

## Arborescence

```text
colis-express/
├── assets/css/style.css
├── js/
│   ├── firebase-config.js     # le seul fichier à compléter avec la config Firebase
│   ├── firebase.js
│   ├── auth.js
│   ├── layout.js
│   ├── utils.js
│   ├── metier-colis.js        # validation, construction du colis, rattachement (testable sans Firebase)
│   ├── public.js
│   ├── suivi.js
│   ├── inscription.js
│   ├── connexion.js
│   ├── dashboard.js
│   ├── nouveau-colis.js
│   ├── colis.js
│   ├── parametres.js
│   └── vendor/qrcode-generator.js   # génération du QR code (MIT, Kazuhiko Arase)
├── assets/img/                # visuels du site et favicon
├── conditions.html            # conditions d'utilisation
├── confidentialite.html       # politique de confidentialité
├── 404.html                   # page introuvable
├── index.html
├── suivi.html
├── inscription.html
├── connexion.html
├── dashboard.html
├── nouveau-colis.html
├── colis.html
├── parametres.html
├── firestore.rules
├── tests/                     # tests Node (npm n'est pas nécessaire) : node --test 'tests/**/*.test.mjs'
├── docs/ameliorations.md      # note stratégique : besoins des agences, pistes anti-perte de colis
├── firestore.rules
└── vercel.json
```

## 1. Créer et configurer Firebase

1. Ouvrez [Firebase Console](https://console.firebase.google.com/) puis **Ajouter un projet**.
2. Dans ce projet, cliquez sur l'icône **Web** (`</>`) et enregistrez une application Web, par exemple `colis-express-web`.
3. Firebase affiche un objet `firebaseConfig`. Ouvrez `js/firebase-config.js` et, si ce n'est pas déjà fait, remplacez les valeurs `REMPLACEZ_…` par celles de cet objet. Le projet de production est déjà configuré.

   ```js
   export const firebaseConfig = {
     apiKey: "…",
     authDomain: "…",
     projectId: "…",
     storageBucket: "…",
     messagingSenderId: "…",
     appId: "…"
   };
   ```

> La configuration Web Firebase n'est pas un secret à cacher : les règles Firestore et Authentication protègent les données. Ne placez toutefois jamais de clé de compte de service ou d'autres secrets dans ce dépôt.

### Activer Authentication

1. Firebase Console → **Authentication** → **Get started**.
2. Onglet **Sign-in method** → activez **E-mail/Mot de passe**.
3. Après le premier déploiement, ouvrez **Authentication → Settings → Authorized domains** et ajoutez votre domaine Vercel (par exemple `mon-projet.vercel.app`) ainsi que votre domaine personnalisé le cas échéant.

### Créer Firestore et publier les règles

1. Firebase Console → **Firestore Database** → **Create database**.
2. Choisissez la région la plus adaptée à votre activité. Pour démarrer, vous pouvez choisir le mode production.
3. Ouvrez l'onglet **Rules**, remplacez le contenu par celui de `firestore.rules`, puis cliquez sur **Publish**.

Les règles fournies appliquent notamment les protections suivantes :

- `/colis/{id}` est lisible seulement par l'agence expéditrice ou l'agence de destination.
- Un colis peut être enregistré **sans agence de destination inscrite** (`destinationAgencyId == null`) à condition que le nom, la ville et le téléphone de cette agence soient déclarés et valides.
- Le **rattachement** ultérieur d'une agence de destination n'est possible que pour l'agence expéditrice, **une seule fois**, uniquement vers une agence existant dans `/agences`, jamais vers elle-même, et sans changer le statut du colis.
- Un colis non rattaché reste invisible aux autres agences : la visibilité de l'agence de destination naît du rattachement.
- Les CNI et téléphones restent dans `/colis`, donc ne sont jamais accessibles depuis le suivi public.
- `/suivis/{code}` est lisible publiquement, mais son écriture exige une agence connectée et un contenu fidèle au colis privé associé.
- L'annuaire `/agences` est disponible uniquement aux agences connectées : il sert à sélectionner l'agence de destination.

> **Important :** le fichier de règles doit impérativement être publié avant d'utiliser l'application. Ne laissez pas les règles de test Firebase en production.

### ⚠️ Après la fusion « agence de destination non inscrite » : republier les règles

Les règles de ce dépôt ne sont **pas** déployées automatiquement (Vercel ne publie pas `firestore.rules`, et aucun outil CLI n'est nécessaire) :

1. Firebase Console → projet `colisexpress-shopin30` → **Firestore Database** → onglet **Rules**.
2. Copiez **tout** le contenu de [`firestore.rules`](firestore.rules) dans l'éditeur.
3. Cliquez sur **Publish**.
4. Vérifiez dans **Firestore Database → Documents** qu'un test d'enregistrement sans agence de destination aboutit (voir le parcours de test ci-dessous).

Tant que cette étape n'est pas faite, l'enregistrement d'un colis vers une agence non inscrite échoue avec `permission-denied`, et le rattachement depuis la fiche colis est refusé aussi.

## 2. Exécuter localement

L'application est composée de fichiers statiques et de modules ES. Servez le dossier avec un petit serveur HTTP :

```bash
cd colis-express
python3 -m http.server 8080
```

Puis ouvrez `http://localhost:8080`. Évitez de double-cliquer directement sur les fichiers HTML (`file://`), car les modules JavaScript et Firebase nécessitent un serveur HTTP.

## 3. Utilisation fonctionnelle

1. Créez au moins **deux agences** via `inscription.html` si vous voulez tester un transfert entre agences.
2. Connectez-vous à une agence et créez un colis dans **Nouveau colis**.
3. Le reçu affiche le code de suivi unique. Le code est aussi consultable sur `suivi.html` par toute personne.
4. Les étapes respectent la chaîne :
   `Enregistré → Expédié → En transit → Arrivé à l'agence de destination → Retiré`.
5. À l'arrivée, l'agence de destination obtient un lien WhatsApp pré-rempli. Lors du retrait, le nom et la CNI de la personne qui récupère le colis sont demandés et restent privés.

### Enregistrer vers une agence de destination non inscrite

1. **Nouveau colis** → section « Colis et acheminement » → cochez **« Mon agence de destination n'est pas encore inscrite »**.
   Le sélecteur se désactive et trois champs apparaissent : **nom**, **ville** et **téléphone** de l'agence. Le bouton
   « Inviter l'agence par WhatsApp » prépare un message d'inscription pré-rempli au numéro saisi.
2. Enregistrez : le colis est créé avec `destinationAgencyId = null`. Le reçu mentionne l'agence « à confirmer »,
   et le tableau de bord affiche un macaron **Agence à rattacher** sur la ligne du colis.
3. Le colis reste lisible uniquement par votre agence. Faute d'agence de destination inscrite, **c'est l'agence
   expéditrice qui valide l'arrivée et le retrait** (sinon le colis resterait bloqué « En transit ») ; un encart le rappelle sur la fiche.
4. Une fois l'agence partenaire inscrite (`inscription.html`), ouvrez la fiche du colis : la carte
   **« Agence de destination à rattacher »** liste les agences inscrites, signale une ville divergente, permet de corriger
   la ville de retrait puis de valider. L'opération est atomique : le colis privé et le suivi public sont écrits ensemble.
5. Après rattachement, l'agence de destination voit le colis dans son tableau de bord (`where destinationAgencyId == uid`)
   et peut valider les étapes qui la concernent. L'historique conserve l'événement « Agence de retrait confirmée »,
   et la déclaration d'origine reste consultable en cas de litige.

### Recette du correctif d'enregistrement (SDK Web)

La création utilise désormais une transaction `runTransaction` avec `transaction.set` :
`WriteBatch.create` n'existe pas dans le SDK Web. Le code de suivi est relu **dans la
transaction**, avant les deux écritures, pour refuser une collision concurrente sans
écraser de suivi. En cas de collision, l'utilisateur est invité à réessayer (nouveau
code). Le modèle de données et les règles Firestore sont inchangés.

Après déploiement, avec des données fictives :
- [ ] Recharger `nouveau-colis.html` sans cache et créer un colis vers une agence non inscrite.
- [ ] Vérifier le reçu, le colis dans le dashboard et son suivi public sans données personnelles.
- [ ] Créer aussi un colis vers une agence inscrite ; vérifier reçu et suivi.
- [ ] Inscrire l'agence B, rattacher depuis A, puis vérifier la visibilité chez B.
- [ ] Vérifier les refus de double rattachement, changement de code et écriture tierce
      via le SDK client authentifié (pas via une écriture administrateur en Console).

**Testé localement :** protocole de transaction avec un double du SDK (deux destinations,
collision, rejeu simulé, propagation d'échec), intégrité statique et tests métier/règles.
**Non testé ici :** SDK distant dans le navigateur, exécution réelle des règles, concurrence
réelle et parcours Firebase/Vercel. La publication des règles a été confirmée par
l'utilisateur ; la recette de l'issue #3 reste à terminer. Aucun changement de règles
n'est requis pour ce correctif.

### Diagnostic permission-denied

La page `nouveau-colis.html` journalise désormais, en cas d'échec, uniquement le
code d'erreur Firebase, la phase (`session`, `lecture-suivi`, `construction` ou
`transaction-colis-suivi`) et le `projectId`. Voir `docs/diagnostic-permission-denied.md`.
Aucun nom, téléphone, CNI, jeton ni document complet n'est journalisé.

## 3 bis. Tests automatisés

Aucune dépendance npm : les tests utilisent le moteur `node:test` de Node 20+.

```bash
node --test 'tests/**/*.test.mjs'
```

- `tests/metier-colis.test.mjs` : validation du formulaire, coordonnées d'agence déclarée, matrice des étapes, rattachement.
- `tests/regles-firestore.test.mjs` : invariants de `firestore.rules`, concordance des clés écrites par l'application avec les
  listes `hasOnly`/`hasAll` du fichier, et oracle refusant les écritures abusives (usurpation d'expéditeur, rattachement double,
  destination hors annuaire, fuite de CNI dans le suivi public…).
- `tests/integration-page.test.mjs` : syntaxe des modules, imports/exports, identifiants DOM réellement présents, liens internes.

Ces tests valident le **contrat** client ↔ règles ; l'exécution réelle des règles par Firestore doit être vérifiée dans
Firebase Console (règles publiées) ou avec l'émulateur `firebase emulators:execute` côté poste de développement.

## 4. Pousser sur GitHub

Depuis le dossier parent du projet :

```bash
cd colis-express
git init
git add .
git commit -m "Initialisation de COLIS EXPRESS"
git branch -M main
git remote add origin https://github.com/VOTRE-COMPTE/colis-express.git
git push -u origin main
```

Avant un dépôt public, vérifiez que `js/firebase-config.js` ne contient que la configuration Web Firebase (pas de secret de serveur). Vous pouvez conserver ce fichier tel quel avec ses valeurs de remplacement, puis compléter la configuration depuis votre environnement de livraison.

## 5. Déployer sur Vercel

1. Créez un compte sur [Vercel](https://vercel.com/) et cliquez sur **Add New → Project**.
2. Importez le dépôt GitHub `colis-express`.
3. Vercel détecte un projet statique : ne renseignez ni commande de build ni répertoire de sortie.
4. Cliquez sur **Deploy**.
5. Copiez le domaine créé dans Firebase Authentication → **Settings → Authorized domains**.
6. Ouvrez le site Vercel et testez inscription, connexion, création de colis, suivi public et changement de statut.

Le fichier `vercel.json` active les URL propres et ajoute des en-têtes de sécurité adaptés au site statique.

## Améliorations de l'expérience

- **Accueil** : menu mobile accessible au clavier (Échap pour fermer), FAQ, section retrait et lien d'évitement pour les lecteurs d'écran.
- **Reçu** : QR code vers la page de suivi, boutons « Envoyer le code au destinataire » et « à l'expéditeur » (WhatsApp, numéro pré-rempli), impression sans les boutons.
- **Fiche colis** : partage du lien de suivi aux deux parties à tout moment.
- **Suivi public** : barre de progression des cinq étapes et lien d'aide WhatsApp.
- **Tableau de bord** : états vides distincts (aucun colis / aucun résultat de filtre) avec action directe.
- **Messages d'erreur** : formulés en langage courant pour les erreurs Firebase fréquentes (connexion, réseau, droits d'accès).

Pour modifier les visuels, remplacez les fichiers de `assets/img/` en conservant leurs noms.

Les pistes d'évolution priorisées (besoins terrain des agences, lutte contre la perte de colis) sont détaillées dans
[`docs/ameliorations.md`](docs/ameliorations.md).

## Modèle de données Firestore

### `agences/{uid}`

```js
{
  name, city, phone, email,
  createdAt, createdAtISO
}
```

### `colis/{id}` — privé

Contient les agences concernées, expéditeur (avec CNI), destinataire, nature, poids, prix FCFA, statut, historique et éventuellement les informations de la personne ayant retiré le colis.

Champs liés à l'agence de destination :

| Champ | Contenu |
| --- | --- |
| `destinationAgencyId` | `uid` du compte agence, ou **`null`** si l'agence n'est pas encore inscrite |
| `destinationAgencyName`, `destinationAgencyCity` | Libellés affichés (agence inscrite ou déclaration manuelle) |
| `unregisteredDestinationAgency` | `{ name, city, phone }` saisis à la main, conservés même après rattachement (trace) |
| `destinationAgencyAttachedAt`, `destinationAgencyAttachedBy` | Date ISO et nom de l'agence expéditrice au moment du rattachement |

### `suivis/{code}` — public

```js
{
  code, colisId, status, history,
  originCity, destinationCity, lastUpdatedAtISO
}
```

Cette collection ne contient **aucun nom, téléphone ni numéro CNI**. À la création comme à chaque évolution de statut, l'application écrit le colis privé et le suivi public dans la même opération atomique (batch ou transaction).

## Notes de sécurité et exploitation

- La validation côté navigateur améliore l'expérience, mais les règles Firestore restent la protection principale des données.
- Utilisez des mots de passe robustes et ne partagez pas un compte d'agence entre plusieurs personnes si vous avez besoin d'une traçabilité individuelle.
- Les documents de colis ne sont pas supprimables par défaut afin de préserver l'historique opérationnel. Adaptez les règles et prévoyez une politique d'archivage si nécessaire.
- Pour la production à grande échelle, prévoyez un contrôle d'accès plus fin (rôles, audit serveur via Cloud Functions) et une politique de conservation des CNI conforme à vos obligations légales.
