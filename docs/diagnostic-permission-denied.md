# Diagnostic permission-denied — enregistrement d'un colis

Ce diagnostic est minimal et sûr : il n'exporte aucun jeton ni donnée personnelle.
Seuls le code d'erreur Firebase, la phase et le projectId sont journalisés.

## Phases instrumentées dans js/nouveau-colis.js

1. `session` : vérification de `auth.currentUser` et correspondance avec `currentAgency.id`.
2. `lecture-suivi` : lecture de `suivis/{code}` pour garantir l'unicité du code.
3. `construction` : construction des documents colis et suivi public.
4. `transaction-colis-suivi` : transaction `runTransaction` écrivant `colis/{id}` puis `suivis/{code}`.

## Procédure

1. Ouvrir la console du navigateur (F12) sur `nouveau-colis.html`.
2. Se connecter avec un compte agence valide.
3. Remplir le formulaire (agence inscrite ou non inscrite) avec des données fictives.
4. Soumettre.
5. En cas d'échec, relever dans la console la ligne :
   `[COLIS EXPRESS][diagnostic] { code, phase, projectId }`.

## Interprétation

- `phase: "session"` : problème d'authentification ou de profil agence.
- `phase: "lecture-suivi"` : lecture de `suivis/{code}` refusée (peu probable, lecture publique).
- `phase: "transaction-colis-suivi"` : refus d'écriture par les règles Firestore.
  Vérifier alors :
  - publication effective des règles de `firestore.rules` dans Firebase Console ;
  - correspondance entre `currentAgency.id` et `auth.currentUser.uid` ;
  - villes de 2 à 60 caractères ;
  - agence de destination inscrite présente dans `/agences` si applicable.

## Limites

Ce diagnostic ne prouve pas l'exécution des règles Firebase : il isole l'opération
refusée côté client. La confirmation finale nécessite la recette navigateur.
