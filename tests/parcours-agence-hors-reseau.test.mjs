/*
 * Parcours complet « agence de destination non inscrite », rejoué avec la logique
 * réelle de l'application (js/metier-colis.js) et l'oracle des règles Firestore.
 *
 * Le sandbox n'a pas accès à Firebase : ce test prouve l'enchaînement métier et le
 * respect du contrat de sécurité à chaque écriture. La confirmation visuelle dans
 * Firebase Console reste nécessaire (voir README, section « republier les règles »).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  changementsRattachement,
  construireColis,
  construireSuiviPublic,
  prochaineEtape,
  resoudreDestination
} from "../js/metier-colis.js";

const AGENCE_A = { id: "uid-ABIDJAN", name: "Shopin30 Abidjan", city: "Abidjan" };
const AGENCE_B = { id: "uid-KORHOGO", name: "Flash Koloko Korhogo", city: "Korhogo" };

/** Rejoue `firestore.rules` (même traduction que tests/regles-firestore.test.mjs). */
const CLES_AUTORISEES_APRES_RATTACHEMENT = new Set([
  "destinationAgencyId", "destinationAgencyName", "destinationAgencyCity",
  "destinationAgencyAttachedAt", "destinationAgencyAttachedBy", "destinationCity",
  "history", "updatedAt"
]);
const CLES_AUTORISEES_PROGRESSION = new Set(["status", "history", "updatedAt", "collectedBy"]);

function clefsModifiees(before, after) {
  const modifiees = new Set();
  for (const cle of Object.keys(after)) {
    if (!(cle in before) || JSON.stringify(before[cle]) !== JSON.stringify(after[cle])) modifiees.add(cle);
  }
  for (const cle of Object.keys(before)) if (!(cle in after)) modifiees.add(cle);
  return modifiees;
}

function ecritureAutorisee(before, after, { auth, annuaire }) {
  // `allow update: if canReadParcel(resource.data) && (...)` : on ne peut écrire
  // un colis que si on est autorisé à le lire.
  if (!voir(before, auth)) return false;
  const modifiees = [...clefsModifiees(before, after)];
  const progression = modifiees.every((cle) => CLES_AUTORISEES_PROGRESSION.has(cle)) &&
    after.ownerId === before.ownerId && after.trackingCode === before.trackingCode &&
    (after.destinationAgencyId ?? null) === (before.destinationAgencyId ?? null);
  const rattachement = before.ownerId === auth && (before.destinationAgencyId ?? null) === null &&
    annuaire.includes(after.destinationAgencyId) && after.destinationAgencyId !== auth &&
    after.status === before.status &&
    JSON.stringify(after.unregisteredDestinationAgency) === JSON.stringify(before.unregisteredDestinationAgency) &&
    modifiees.every((cle) => CLES_AUTORISEES_APRES_RATTACHEMENT.has(cle));
  return progression || rattachement;
}

function voir(parcel, uid) {
  return Boolean(uid) && (parcel.ownerId === uid || (parcel.destinationAgencyId ?? null) === uid);
}

test("parcours : enregistrer, recevoir le reçu, inscrire l'agence, la rattacher, la rendre visible", () => {
  const annuaire = [AGENCE_A.id];

  // 1. Enregistrement vers une agence qui n'a pas encore de compte.
  const values = {
    senderFirstName: "Awa", senderLastName: "Traore", senderPhone: "0700000001", senderCni: "ci12345678",
    recipientFirstName: "Ibrahim", recipientLastName: "Kone", recipientPhone: "0500000002",
    packageNature: "Pièces détachées", weightKg: "8", priceFCFA: "6000",
    originCity: "Abidjan", destinationCity: "Korhogo", destinationAgencyId: "",
    declaredAgencyName: "Flash Koloko", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009"
  };
  const destination = resoudreDestination({
    values, agencies: annuaire.map((id) => AGENCE_A), currentAgencyId: AGENCE_A.id, agencyNotRegistered: true
  });
  assert.equal(destination.ok, true);
  const creation = construireColis({
    values, currentAgency: AGENCE_A, destination: destination.destination,
    parcelId: "colis-42", trackingCode: "CLI-K7M2QX", nowISO: "2026-10-14T08:00:00.000Z"
  });
  const parcel = { ...creation.parcel, createdAt: null, updatedAt: null };
  const suivi = creation.publicTracking;

  // 2. Le reçu et le suivi public sont exploitables malgré l'absence de compte.
  assert.equal(parcel.destinationAgencyId, null);
  assert.equal(parcel.destinationAgencyName, "Flash Koloko");
  assert.equal(parcel.unregisteredDestinationAgency.phone, "0700000009");
  assert.equal(parcel.trackingCode, "CLI-K7M2QX");
  assert.equal(suivi.history.length, 1);
  assert.equal(JSON.stringify(suivi).includes("0700000009"), false, "le téléphone de l'agence ne va pas dans le suivi public");
  assert.equal(voir(parcel, AGENCE_B.id), false, "sans compte, l'agence de destination ne voit rien encore");

  // 3. L'expéditeur fait avancer le colis lui-même, y compris l'arrivée et le retrait.
  assert.equal(prochaineEtape({ parcel, agencyId: AGENCE_A.id }), "Expédié");
  let etat = parcel;
  for (const statut of ["Expédié", "En transit", "Arrivé à l'agence de destination", "Retiré"]) {
    const suivant = prochaineEtape({ parcel: etat, agencyId: AGENCE_A.id });
    assert.equal(suivant, statut, `l'expéditeur doit pouvoir valider « ${statut} » tant que rien n'est rattaché`);
    const apres = {
      ...etat,
      status: statut,
      history: [...etat.history, { status: statut, date: "2026-10-14T12:00:00.000Z", agencyName: AGENCE_A.name }],
      updatedAt: "2026-10-14T12:00:00.000Z"
    };
    assert.equal(ecritureAutorisee(etat, apres, { auth: AGENCE_A.id, annuaire }), true);
    etat = apres;
  }
  assert.equal(prochaineEtape({ parcel: etat, agencyId: AGENCE_A.id }), null, "colis clôturé : plus d'étape");

  // 4. L'agence de destination crée son compte : elle entre dans l'annuaire.
  annuaire.push(AGENCE_B.id);
  const enCours = { ...parcel, status: "En transit", history: [...parcel.history, { status: "En transit", date: "2026-10-14T10:00:00.000Z" }] };

  // 5. Rattachement depuis la fiche colis, en transaction avec le suivi public.
  const now = "2026-10-14T15:00:00.000Z";
  const changes = changementsRattachement({ parcel: enCours, agency: AGENCE_B, ownerAgency: AGENCE_A, now });
  const apresRattachement = { ...enCours, ...changes, updatedAt: now };
  assert.equal(ecritureAutorisee(enCours, apresRattachement, { auth: AGENCE_A.id, annuaire }), true);
  assert.equal(apresRattachement.status, "En transit", "le rattachement ne fait pas avancer le colis");
  assert.equal(apresRattachement.history.at(-1).status, "Agence de retrait confirmée");
  assert.equal(apresRattachement.unregisteredDestinationAgency.name, "Flash Koloko", "la déclaration d'origine reste en trace");

  const suiviApres = construireSuiviPublic(apresRattachement, now);
  assert.equal(suiviApres.history.length, enCours.history.length + 1);
  assert.equal(suiviApres.originCity, "Abidjan");
  assert.equal(suiviApres.destinationCity, "Korhogo");
  assert.equal(JSON.stringify(suiviApres).includes("0700000009"), false);

  // 6. L'agence de destination voit le colis et prend la main sur la suite.
  assert.equal(voir(apresRattachement, AGENCE_B.id), true, "where(destinationAgencyId == uid) renvoie le colis");
  assert.equal(voir(apresRattachement, AGENCE_A.id), true, "l'expéditeur le voit toujours");
  assert.equal(prochaineEtape({ parcel: apresRattachement, agencyId: AGENCE_B.id }), "Arrivé à l'agence de destination");
  assert.equal(prochaineEtape({ parcel: apresRattachement, agencyId: AGENCE_A.id }), null);
  const arrivee = {
    ...apresRattachement,
    status: "Arrivé à l'agence de destination",
    history: [...apresRattachement.history, { status: "Arrivé à l'agence de destination", date: now, agencyName: AGENCE_B.name }],
    updatedAt: now
  };
  assert.equal(ecritureAutorisee(apresRattachement, arrivee, { auth: AGENCE_B.id, annuaire }), true, "l'agence rattachée écrit l'arrivée");
  assert.equal(ecritureAutorisee(apresRattachement, arrivee, { auth: "uid-INTRUS", annuaire }), false, "une autre agence ne peut pas");
  assert.equal(ecritureAutorisee(apresRattachement, { ...arrivee, destinationAgencyId: "uid-INTRUS" }, { auth: AGENCE_B.id, annuaire }), false, "pas de re-rattachement par l'agence de destination");
  // Un colis non rattaché reste hors de portée des autres agences, y compris pour écrire.
  assert.equal(ecritureAutorisee(enCours, { ...enCours, status: "Arrivé à l'agence de destination", history: [...enCours.history, { status: "x" }] }, { auth: AGENCE_B.id, annuaire }), false, "avant rattachement, l'agence B ne peut rien écrire");
});
