# Résoudre `permission-denied` à l'enregistrement d'un colis

## Symptôme

L'enregistrement d'un colis échoue avec `permission-denied` (phase
`transaction-colis-suivi` dans `nouveau-colis.html`), et une sonde minimale —
un document `colis` **pourtant conforme** à `firestore.rules` — est refusée
avec le même code.

## Ce que le diagnostic a établi

1. Le document minimal de la sonde satisfait **toutes** les conditions de
   `allow create` dans [`firestore.rules`](../firestore.rules) : les 9 clés
   exigées, `ownerId == auth.uid`, statut « Enregistré », historique non vide,
   villes 2–60 caractères, et la branche « agence non inscrite »
   (`destinationAgencyId == null` + `isValidDeclaredAgency` : nom, ville et
   téléphone `^0[1-9][0-9]{8}$`).
2. Les tests locaux (59/59, dont l'oracle de `tests/regles-firestore.test.mjs`)
   confirment cette analyse : la forme exacte de la sonde passe l'oracle.
3. Le commit GitHub « Update firestore.rules » n'a supprimé que des
   commentaires (logique inchangée, octet pour octet après retrait).

⇒ Conclusion : **les règles exécutées par Firestore ne sont pas celles du
dépôt**. Tant que `firestore.rules` n'est pas publié, toute écriture prévue
uniquement par la version du dépôt (dont « agence de destination non
inscrite ») est refusée. Vercel ne publie **jamais** les règles : seule la
publication manuelle ci-dessous les active.

## Étape 0 — Diagnostic (à coller dans la console du navigateur)

Se connecter à l'espace agence, puis coller ce script (F12 → Console) :

```js
(async () => {
  const { getFirestore, doc, getDoc, setDoc, collection, getDocs, query, limit } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js");
  const app = (await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js")).getApps()[0];
  const db = getFirestore(app);
  const user = getAuth(app).currentUser;
  if (!user) { console.error("Connectez-vous d'abord à l'espace agence"); return; }
  const now = new Date().toISOString();
  const history = [{ status: "Enregistré", date: now, agencyName: "Sonde", city: "Abidjan" }];

  // S1 — lecture publique (toujours autorisée par les règles du dépôt)
  try { await getDoc(doc(db, "suivis", "SONDE-LECTURE")); console.info("S1 lecture suivis : OK"); }
  catch (e) { console.error("S1 lecture suivis : ECHEC", e?.code); }

  // S2 — création vers une agence INSCRITE (ancien format de règles)
  let destId = null;
  try {
    const snap = await getDocs(query(collection(db, "agences"), limit(6)));
    destId = snap.docs.find((d) => d.id !== user.uid)?.id || null;
    console.info("S2 annuaire :", snap.size, "agence(s) — destination test :", destId || "aucune");
  } catch (e) { console.error("S2 annuaire : ECHEC", e?.code); }
  if (destId) {
    try {
      await setDoc(doc(db, "colis", "sonde2-" + Date.now()), {
        trackingCode: "CLI-SONDE2-" + Date.now().toString().slice(-4),
        ownerId: user.uid, destinationAgencyId: destId,
        destinationAgencyName: "Agence Sonde", destinationAgencyCity: "Abidjan",
        originCity: "Abidjan", destinationCity: "Abidjan", status: "Enregistré", history
      });
      console.info("S2 colis agence inscrite : OK");
    } catch (e) { console.error("S2 colis agence inscrite : ECHEC", e?.code); }
  }

  // S3 — création vers une agence NON inscrite (format actuel des règles)
  try {
    await setDoc(doc(db, "colis", "sonde3-" + Date.now()), {
      trackingCode: "CLI-SONDE3-" + Date.now().toString().slice(-4),
      ownerId: user.uid, destinationAgencyId: null,
      destinationAgencyName: "Agence Diagnostic",
      destinationAgencyCity: "Abidjan",
      originCity: "Abidjan", destinationCity: "Abidjan",
      status: "Enregistré", history,
      unregisteredDestinationAgency: { name: "Agence Diagnostic", city: "Abidjan", phone: "0700000009" }
    });
    console.info("S3 colis agence non inscrite : OK");
  } catch (e) { console.error("S3 colis agence non inscrite : ECHEC", e?.code); }
})();
```

Interprétation :

| Résultat | Cause | Action |
|---|---|---|
| S1 OK, S2 OK, **S3 ECHEC** | Règles anciennes, sans la branche « agence non inscrite » | Étape 1 (publication) |
| S1 OK, S2 ECHEC, S3 ECHEC | Règles très différentes (tout `create` refusé) | Étape 1, en vérifiant projet + base `(default)` |
| S1 ECHEC | Tout est fermé : règles locked, mauvaise base, **ou App Check avec enforcement** | Étape 1 + vérifier l'onglet App Check |
| Tout OK | Règles déjà à jour | Retester `nouveau-colis.html` ; si l'app échoue encore, le problème est applicatif (phase du diagnostic) |

> Remarque : chaque exécution laisse un document `sonde*-*` (jamais supprimable,
> `allow delete: if false`) visible dans le tableau de bord. Inoffensif, mais
> gardez les sondes rares.

## Étape 1 — Publier les règles

### Procédure A — Firebase Console (recommandée, 2 minutes)

1. Ouvrir [console.firebase.google.com](https://console.firebase.google.com) →
   projet **`colisexpress-shopin30`**.
2. **Firestore Database** → onglet **Rules**. Vérifier que la base affichée est
   **`(default)`**.
3. Sélectionner **tout** le texte de l'éditeur (Ctrl+A) et le remplacer par le
   contenu **intégral** de [`firestore.rules`](../firestore.rules)
   ([version raw](https://raw.githubusercontent.com/moukila2026-cyber/colisexpress-shopin30/main/firestore.rules)).
   Le fichier fait ~142 lignes et commence par `rules_version = '2';`.
4. Cliquer **Publish**. En cas d'erreur de validation, copier le message exact :
   le fichier du dépôt est syntaxiquement valide, l'erreur viendrait d'une
   copie incomplète.
5. Relancer le script de l'étape 0 : attendu `S1/S2/S3 : OK`.

### Procédure B — Ligne de commande (autre moyen)

Sur une machine où vous êtes connecté à votre compte Google :

```bash
npm install -g firebase-tools
firebase login
cd colisexpress-shopin30
firebase use colisexpress-shopin30
firebase deploy --only firestore:rules
```

Le fichier `firebase.json` du dépôt pointe déjà vers `firestore.rules`.
Vérifier ensuite avec le script de l'étape 0.

## Étape 2 — Recette

1. Script de l'étape 0 : `S1/S2/S3 : OK`.
2. `nouveau-colis.html` : enregistrer un colis vers une agence **non inscrite**
   (nom, ville, téléphone `07xxxxxxxx`) : le reçu et le code de suivi doivent
   apparaître.
3. `suivi.html` : rechercher ce code : le statut « Enregistré » s'affiche.
4. `colis.html` : rattacher une agence inscrite, puis faire avancer le statut.

## Si ça bloque encore après publication

- **Contenu de l'onglet Rules** : le comparer ligne à ligne avec
  `firestore.rules` (une copie tronquée ou un autre projet annule l'effet).
- **App Check** : si l'onglet App Check indique « enforcement » sur Firestore,
  toutes les requêtes sans jeton valide sont refusées en `permission-denied`,
  même avec les bonnes règles.
- **Base de données** : le SDK écrit dans la base `(default)` ; des règles
  publiées sur une autre base ne s'appliquent pas.
- En cas d'échec persistant, relever les codes du script (S1/S2/S3) et la phase
  du diagnostic (`session`, `lecture-suivi`, `construction`,
  `transaction-colis-suivi`) : ils isolent l'opération refusée.
