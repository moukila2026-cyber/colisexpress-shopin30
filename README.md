# COLIS EXPRESS

Application web statique, **100 % en français**, de gestion d'envoi et de réception de colis multi-agences. Elle fonctionne avec Firebase Authentication et Cloud Firestore, sans framework ni serveur applicatif.

- Interface mobile-first (vert foncé / orange)
- Montants en **FCFA**
- Suivi public en temps réel avec code `CLI-XXXXXX`
- Données privées (téléphone, CNI) séparées du suivi public
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
│   ├── public.js
│   ├── suivi.js
│   ├── inscription.js
│   ├── connexion.js
│   ├── dashboard.js
│   ├── nouveau-colis.js
│   ├── colis.js
│   └── parametres.js
├── index.html
├── suivi.html
├── inscription.html
├── connexion.html
├── dashboard.html
├── nouveau-colis.html
├── colis.html
├── parametres.html
├── firestore.rules
└── vercel.json
```

## 1. Créer et configurer Firebase

1. Ouvrez [Firebase Console](https://console.firebase.google.com/) puis **Ajouter un projet**.
2. Dans ce projet, cliquez sur l'icône **Web** (`</>`) et enregistrez une application Web, par exemple `colis-express-web`.
3. Firebase affiche un objet `firebaseConfig`. Ouvrez `js/firebase-config.js` et remplacez **toutes** les valeurs `REMPLACEZ_…` par les valeurs de cet objet.

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
- Les CNI et téléphones restent dans `/colis`, donc ne sont jamais accessibles depuis le suivi public.
- `/suivis/{code}` est lisible publiquement, mais son écriture exige une agence connectée et un contenu fidèle au colis privé associé.
- L'annuaire `/agences` est disponible uniquement aux agences connectées : il sert à sélectionner l'agence de destination.

> **Important :** le fichier de règles doit impérativement être publié avant d'utiliser l'application. Ne laissez pas les règles de test Firebase en production.

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
