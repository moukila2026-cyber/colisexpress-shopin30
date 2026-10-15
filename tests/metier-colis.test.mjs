/*
 * Tests de la logique métier des colis.
 * Exécution : node --test tests/   (aucune dépendance, aucun accès réseau)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ETAPES_DESTINATION,
  ETAPES_EXPEDITEUR,
  agenceDeclaree,
  agencesRattachables,
  attendUnRattachement,
  changementsRattachement,
  construireColis,
  construireSuiviPublic,
  etapeValideeParExpediteur,
  lireAgenceDeclaree,
  peutRattacher,
  prochaineEtape,
  resoudreDestination,
  validerColis,
  villeDivergente
} from "../js/metier-colis.js";

const AGENCE = { id: "uid-BOUAKE", name: "Rapid Bouaké", city: "Bouaké" };
const AGENCE_BKE = { id: "uid-2", name: "Acces Bke", city: "Bouaké" };
const AGENCE_YKO = { id: "uid-3", name: "Delta Yamoussoukro", city: "Yamoussoukro" };
const AGENCE_C1 = { id: "uid-4", name: "Coral Abidjan", city: "Abidjan" };
const EXPEDITRICE = { id: "uid-1", name: "Shopin30 Abidjan", city: "Abidjan" };

function valeurs(partial = {}) {
  return {
    senderFirstName: "Awa",
    senderLastName: "Traore",
    senderPhone: "0700000001",
    senderCni: "ci12345678",
    recipientFirstName: "Ibrahim",
    recipientLastName: "Kone",
    recipientPhone: "0500000002",
    packageNature: "Vêtements",
    weightKg: "2.5",
    priceFCFA: "3500",
    originCity: "Abidjan",
    destinationCity: "Bouaké",
    destinationAgencyId: "uid-2",
    ...partial
  };
}

/* ----------------------------- validation ----------------------------- */

test("un colis avec agence inscrite est valide", () => {
  assert.equal(validerColis({ values: valeurs(), agencyNotRegistered: false }), null);
});

test("sans agence et sans cocher « non inscrite », l'erreur propose le compromis", () => {
  const error = validerColis({ values: valeurs({ destinationAgencyId: "" }), agencyNotRegistered: false });
  assert.match(error, /agence de destination/i);
  assert.match(error, /pas encore inscrite/);
});

test("le téléphone et la CNI de l'expéditeur restent contrôlés", () => {
  assert.match(validerColis({ values: valeurs({ senderPhone: "0700" }) }), /téléphone ivoirien valide/);
  assert.match(validerColis({ values: valeurs({ senderCni: "abc" }) }), /CNI/);
  assert.match(validerColis({ values: valeurs({ recipientPhone: "+2250102" }) }), /destinataire/);
});

test("une agence non inscrite exige nom, ville et téléphone", () => {
  const incomplete = { destinationAgencyId: "", declaredAgencyName: "  ", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" };
  assert.match(validerColis({ values: valeurs(incomplete), agencyNotRegistered: true }), /nom de l.agence de destination/);
  assert.match(validerColis({ values: valeurs({ ...incomplete, declaredAgencyName: "Flash Koloko", declaredAgencyCity: "" }), agencyNotRegistered: true }), /ville de l.agence/);
  assert.match(validerColis({ values: valeurs({ ...incomplete, declaredAgencyName: "Flash Koloko", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700" }), agencyNotRegistered: true }), /téléphone ivoirien/);
  assert.equal(validerColis({ values: valeurs({ ...incomplete, declaredAgencyName: "Flash Koloko", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" }), agencyNotRegistered: true }), null);
});

test("les coordonnées déclarées sont nettoyées et le téléphone normalisé", () => {
  const declared = lireAgenceDeclaree(valeurs({
    declaredAgencyName: "  Flash\n   Koloko  ",
    declaredAgencyCity: " Korhogo ",
    declaredAgencyPhone: "+225 07-00-00-00-09"
  }));
  assert.deepEqual(declared, { name: "Flash Koloko", city: "Korhogo", phone: "0700000009" });
});

test("la longueur des coordonnées déclarées est bornée", () => {
  const long = "A".repeat(121);
  assert.match(validerColis({ values: valeurs({ declaredAgencyName: long, declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" }), agencyNotRegistered: true }), /120 caractères/);
});

/* --------------------------- destination ---------------------------- */

test("agence inscrite : destinationAgencyId pointé sur le compte", () => {
  const result = resoudreDestination({ values: valeurs(), agencies: [AGENCE, AGENCE_BKE], currentAgencyId: EXPEDITRICE.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.destination, {
    destinationAgencyId: "uid-2",
    destinationAgencyName: "Acces Bke",
    destinationAgencyCity: "Bouaké"
  });
  assert.equal("unregisteredDestinationAgency" in result.destination, false);
});

test("agence inscrite introuvable dans l'annuaire : refus", () => {
  const result = resoudreDestination({ values: valeurs(), agencies: [AGENCE], currentAgencyId: EXPEDITRICE.id });
  assert.equal(result.ok, false);
  assert.match(result.error, /n'est plus disponible/);
});

test("impossible de s'envoyer un colis à soi-même", () => {
  const result = resoudreDestination({ values: valeurs({ destinationAgencyId: "uid-1" }), agencies: [EXPEDITRICE, AGENCE], currentAgencyId: "uid-1" });
  assert.equal(result.ok, false);
  assert.match(result.error, /différente/);
});

test("agence non inscrite : destinationAgencyId est null et la déclaration est stockée", () => {
  const result = resoudreDestination({
    values: valeurs({ destinationAgencyId: "", declaredAgencyName: "Flash Koloko", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" }),
    agencies: [AGENCE],
    currentAgencyId: EXPEDITRICE.id,
    agencyNotRegistered: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.destination.destinationAgencyId, null);
  assert.deepEqual(result.destination.unregisteredDestinationAgency, {
    name: "Flash Koloko", city: "Korhogo", phone: "0700000009"
  });
  assert.equal(result.destination.destinationAgencyName, "Flash Koloko");
  assert.equal(result.destination.destinationAgencyCity, "Korhogo");
});

test("agence non inscrite : coordonnées incomplètes refusées à l'écriture", () => {
  const result = resoudreDestination({
    values: valeurs({ declaredAgencyName: "Flash", declaredAgencyCity: "", declaredAgencyPhone: "" }),
    agencyNotRegistered: true
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /nom, la ville et le téléphone/);
});

/* ------------------------- document du colis ------------------------- */

test("construireColis produit un colis et son suivi public cohérents", () => {
  const destination = resoudreDestination({
    values: valeurs({ declaredAgencyName: "Flash Koloko", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" }),
    agencyNotRegistered: true
  }).destination;
  const { parcel, publicTracking } = construireColis({
    values: valeurs({ destinationAgencyId: "" }),
    currentAgency: EXPEDITRICE,
    destination,
    parcelId: "colis-1",
    trackingCode: "CLI-ABC234",
    nowISO: "2026-10-14T09:00:00.000Z"
  });

  assert.equal(parcel.id, "colis-1");
  assert.equal(parcel.ownerId, "uid-1");
  assert.equal(parcel.destinationAgencyId, null);
  assert.equal(parcel.status, "Enregistré");
  assert.equal(parcel.weightKg, 2.5);
  assert.equal(parcel.priceFCFA, 3500);
  assert.equal(parcel.sender.cni, "CI12345678");
  assert.equal(parcel.recipient.phone, "0500000002");
  assert.deepEqual(parcel.history, [{
    status: "Enregistré", date: "2026-10-14T09:00:00.000Z", agencyName: "Shopin30 Abidjan", city: "Abidjan"
  }]);
  assert.equal(parcel.unregisteredDestinationAgency.city, "Korhogo");
  // Le reçu et les listes s'appuient encore sur le nom/ville de destination.
  assert.equal(parcel.destinationAgencyName, "Flash Koloko");
  assert.equal(parcel.destinationCity, "Bouaké");

  assert.deepEqual(Object.keys(publicTracking).sort(), [
    "code", "colisId", "destinationCity", "history", "lastUpdatedAtISO", "originCity", "status"
  ]);
  assert.equal(publicTracking.colisId, "colis-1");
  // Aucune donnée personnelle dans le document public.
  const json = JSON.stringify(publicTracking);
  assert.equal(/0500000002|CI12345678|Ibrahim|Flash Koloko/.test(json), false);
});

test("colis vers une agence inscrite : pas de champ unregisteredDestinationAgency", () => {
  const destination = resoudreDestination({ values: valeurs(), agencies: [AGENCE_BKE] }).destination;
  const { parcel } = construireColis({
    values: valeurs(),
    currentAgency: EXPEDITRICE,
    destination,
    parcelId: "c2",
    trackingCode: "CLI-XYZ234",
    nowISO: "2026-10-14T09:00:00.000Z"
  });
  assert.equal("unregisteredDestinationAgency" in parcel, false);
  assert.equal(parcel.destinationAgencyId, "uid-2");
});

test("les horaires serveur sont ajoutés par l'appelant, pas par le métier", () => {
  const destination = resoudreDestination({ values: valeurs(), agencies: [AGENCE_BKE] }).destination;
  const { parcel } = construireColis({ values: valeurs(), currentAgency: EXPEDITRICE, destination, parcelId: "c3", trackingCode: "CLI-AABBCC", nowISO: "2026-10-14T09:00:00.000Z" });
  assert.equal("createdAt" in parcel, false);
  assert.equal("updatedAt" in parcel, false);
  assert.equal(parcel.createdAtISO, "2026-10-14T09:00:00.000Z");
});

/* --------------------------- progression ---------------------------- */

function colis(partial = {}) {
  return {
    id: "colis-1",
    trackingCode: "CLI-ABC234",
    ownerId: "uid-1",
    destinationAgencyId: "uid-2",
    status: "Enregistré",
    history: [],
    originCity: "Abidjan",
    destinationCity: "Bouaké",
    ...partial
  };
}

test("l'expéditeur ouvre la chaîne, la destination la ferme", () => {
  assert.deepEqual(ETAPES_EXPEDITEUR, ["Expédié", "En transit"]);
  assert.deepEqual(ETAPES_DESTINATION, ["Arrivé à l'agence de destination", "Retiré"]);
  assert.equal(prochaineEtape({ parcel: colis(), agencyId: "uid-1" }), "Expédié");
  assert.equal(prochaineEtape({ parcel: colis({ status: "Expédié" }), agencyId: "uid-1" }), "En transit");
  assert.equal(prochaineEtape({ parcel: colis({ status: "En transit" }), agencyId: "uid-1" }), null, "l'arrivée relève de la destination une fois rattachée");
  assert.equal(prochaineEtape({ parcel: colis({ status: "En transit" }), agencyId: "uid-2" }), "Arrivé à l'agence de destination");
  assert.equal(prochaineEtape({ parcel: colis({ status: "Arrivé à l'agence de destination" }), agencyId: "uid-2" }), "Retiré");
});

test("une agence tierce ne peut rien valider", () => {
  assert.equal(prochaineEtape({ parcel: colis(), agencyId: "uid-INCONNU" }), null);
  assert.equal(prochaineEtape({ parcel: colis({ status: "En transit" }), agencyId: "uid-INCONNU" }), null);
});

test("colis clôturé : plus aucune étape", () => {
  assert.equal(prochaineEtape({ parcel: colis({ status: "Retiré" }), agencyId: "uid-2" }), null);
  assert.equal(prochaineEtape({ parcel: colis({ status: "Retiré" }), agencyId: "uid-1" }), null);
});

test("statut inconnu ou agence absente : aucune étape", () => {
  assert.equal(prochaineEtape({ parcel: colis({ status: "Perdu" }), agencyId: "uid-1" }), null);
  assert.equal(prochaineEtape({ parcel: null, agencyId: "uid-1" }), null);
  assert.equal(prochaineEtape({ parcel: colis(), agencyId: null }), null);
});

test("tant que l'agence de destination n'est pas inscrite, l'expéditeur clôture lui-même", () => {
  const pending = colis({ destinationAgencyId: null, status: "En transit" });
  assert.equal(attendUnRattachement(pending), true);
  assert.equal(prochaineEtape({ parcel: pending, agencyId: "uid-1" }), "Arrivé à l'agence de destination");
  assert.equal(prochaineEtape({ parcel: { ...pending, status: "Arrivé à l'agence de destination" }, agencyId: "uid-1" }), "Retiré");
  assert.equal(etapeValideeParExpediteur({ parcel: pending, agencyId: "uid-1", nextStatus: "Arrivé à l'agence de destination" }), true);
  assert.equal(etapeValideeParExpediteur({ parcel: pending, agencyId: "uid-1", nextStatus: "En transit" }), false);
  assert.equal(etapeValideeParExpediteur({ parcel: colis(), agencyId: "uid-1", nextStatus: "En transit" }), false, "plus d'avertissement une fois rattaché");
  assert.equal(prochaineEtape({ parcel: { ...pending, destinationAgencyId: "uid-2" }, agencyId: "uid-1" }), null);
});

/* ---------------------------- rattachement --------------------------- */

const HORS_RESEAU = { name: "Flash Koloko", city: "Korhogo", phone: "0700000009" };
const nonRattache = colis({ destinationAgencyId: null, unregisteredDestinationAgency: HORS_RESEAU, destinationAgencyName: "Flash Koloko", status: "Enregistré" });

test("seule l'agence expéditrice peut rattacher, et une seule fois", () => {
  assert.equal(peutRattacher({ parcel: nonRattache, agencyId: "uid-1" }), true);
  assert.equal(peutRattacher({ parcel: nonRattache, agencyId: "uid-9" }), false);
  assert.equal(peutRattacher({ parcel: { ...nonRattache, destinationAgencyId: "uid-2" }, agencyId: "uid-1" }), false);
  assert.equal(peutRattacher({ parcel: null, agencyId: "uid-1" }), false);
  assert.equal(attendUnRattachement({ ...nonRattache, destinationAgencyId: "uid-2" }), false);
});

test("l'agence rattachée ne peut pas être l'expéditrice, et la liste est triée", () => {
  const agencies = [
    { id: "uid-1", name: "Shopin30 Abidjan", city: "Abidjan" },
    { id: "uid-3", name: "Delta Yako", city: "Yamoussoukro" },
    { id: "uid-2", name: "Acces Bouake", city: "Bouaké" }
  ];
  const propositions = agencesRattachables({ parcel: nonRattache, agencies, currentAgencyId: "uid-1" });
  assert.deepEqual(propositions.map((agency) => agency.id), ["uid-2", "uid-3"]);
  assert.deepEqual(agencesRattachables({ parcel: nonRattache, agencies, currentAgencyId: "uid-9" }), []);
});

test("les écritures de rattachement respectent le contrat des règles", () => {
  const before = JSON.parse(JSON.stringify(nonRattache));
  const changes = changementsRattachement({
    parcel: before,
    agency: AGENCE_BKE,
    ownerAgency: EXPEDITRICE,
    now: "2026-10-15T08:30:00.000Z"
  });
  assert.deepEqual(Object.keys(changes).sort(), [
    "destinationAgencyAttachedAt", "destinationAgencyAttachedBy", "destinationAgencyCity",
    "destinationAgencyId", "destinationAgencyName", "destinationCity", "history"
  ]);
  assert.equal(changes.destinationAgencyId, "uid-2");
  assert.equal(changes.destinationAgencyName, "Acces Bke");
  assert.equal(changes.destinationAgencyAttachedBy, "Shopin30 Abidjan");
  assert.equal(changes.destinationAgencyAttachedAt, "2026-10-15T08:30:00.000Z");
  // Ni statut, ni propriétaire, ni code de suivi, ni coordonnées personnelles.
  for (const cleInterdite of ["status", "ownerId", "trackingCode", "sender", "recipient", "collectedBy", "unregisteredDestinationAgency"]) {
    assert.equal(cleInterdite in changes, false, `${cleInterdite} ne doit pas être modifié au rattachement`);
  }
  // Historique : ajout d'une étape, sans écraser le passé, et sans muter l'objet d'origine.
  assert.equal(changes.history.length, 1);
  assert.equal(changes.history[0].status, "Agence de retrait confirmée");
  assert.match(changes.history[0].note, /Acces Bke/);
  assert.deepEqual(JSON.parse(JSON.stringify(before)), JSON.parse(JSON.stringify(nonRattache)));
});

test("la ville de retrait peut être corrigée au rattachement", () => {
  const changes = changementsRattachement({
    parcel: nonRattache,
    agency: { id: "uid-3", name: "Delta Yako", city: "Yamoussoukro" },
    ownerAgency: EXPEDITRICE,
    now: "2026-10-15T08:30:00.000Z",
    destinationCity: "  Yamoussoukro "
  });
  assert.equal(changes.destinationCity, "Yamoussoukro");
  assert.match(changes.history[0].city, /^Yamoussoukro$/);

  const vide = changementsRattachement({ parcel: nonRattache, agency: AGENCE_BKE, ownerAgency: EXPEDITRICE, now: "x", destinationCity: "   " });
  assert.equal(vide.destinationCity, "Bouaké", "une ville vide ne doit pas effacer celle du colis");
});

test("divergence de ville signalée, jamais bloquante", () => {
  assert.equal(villeDivergente({ parcel: nonRattache, agency: AGENCE_YKO }), true);
  assert.equal(villeDivergente({ parcel: nonRattache, agency: { ...AGENCE_BKE, city: " bouaké " } }), false);
  assert.equal(villeDivergente({ parcel: nonRattache, agency: { id: "x", name: "Sans ville" } }), false);
});

test("agenceDeclaree renvoie les coordonnées seulement tant que rien n'est rattaché", () => {
  assert.deepEqual(agenceDeclaree(nonRattache), HORS_RESEAU);
  assert.equal(agenceDeclaree({ ...nonRattache, destinationAgencyId: "uid-2" }), null);
  assert.equal(agenceDeclaree(null), null);
});

test("le suivi public reconstruit à partir des changements reste fidèle au colis", () => {
  const changes = changementsRattachement({ parcel: nonRattache, agency: AGENCE_BKE, ownerAgency: EXPEDITRICE, now: "2026-10-15T08:30:00.000Z" });
  const after = { ...nonRattache, ...changes };
  const suivi = construireSuiviPublic(after, "2026-10-15T08:30:00.000Z");
  assert.equal(suivi.status, "Enregistré", "le rattachement ne change pas le statut visible");
  assert.equal(suivi.history.length, 1);
  assert.equal(suivi.colisId, "colis-1");
});

test("les villes de départ et de destination sont validées sur 2 à 60 caractères", () => {
  assert.match(validerColis({ values: valeurs({ originCity: "A" }) }), /villes de départ et de destination/);
  assert.match(validerColis({ values: valeurs({ destinationCity: "" }) }), /villes de départ et de destination/);
  assert.equal(validerColis({ values: valeurs({ originCity: "  Abidjan  ", destinationCity: "Bouaké" }) }), null);
});

/* --------------------------- traçabilité agent (LOT 1) ---------------------- */

test("l'acteur est écrit dans l'historique seulement quand il est fourni", () => {
  const destination = resoudreDestination({
    values: valeurs(),
    agencies: [AGENCE_BKE],
    currentAgencyId: EXPEDITRICE.id
  }).destination;

  const sansActeur = construireColis({
    values: valeurs(),
    currentAgency: EXPEDITRICE,
    destination,
    parcelId: "colis-a",
    trackingCode: "CLI-ACTR01",
    nowISO: "2026-10-14T09:00:00.000Z"
  });
  assert.equal("actorId" in sansActeur.parcel.history[0], false);
  assert.equal("actorName" in sansActeur.parcel.history[0], false);

  const avecActeur = construireColis({
    values: valeurs(),
    currentAgency: EXPEDITRICE,
    destination,
    parcelId: "colis-b",
    trackingCode: "CLI-ACTR02",
    nowISO: "2026-10-14T09:00:00.000Z",
    actor: { id: "agent-7", name: "Koffi N'Guessan" }
  });
  assert.equal(avecActeur.parcel.history[0].actorId, "agent-7");
  assert.equal(avecActeur.parcel.history[0].actorName, "Koffi N'Guessan");
  assert.equal(avecActeur.parcel.history[0].status, "Enregistré");
});

test("le rattachement trace l'acteur sur son étape d'historique", () => {
  const changes = changementsRattachement({
    parcel: nonRattache,
    agency: AGENCE_BKE,
    ownerAgency: EXPEDITRICE,
    now: "2026-10-15T08:30:00.000Z",
    actor: { id: "agent-7", name: "Koffi N'Guessan" }
  });
  assert.equal(changes.history[0].actorId, "agent-7");
  assert.equal(changes.history[0].actorName, "Koffi N'Guessan");

  const sansActeur = changementsRattachement({
    parcel: nonRattache,
    agency: AGENCE_BKE,
    ownerAgency: EXPEDITRICE,
    now: "2026-10-15T08:30:00.000Z"
  });
  assert.equal("actorId" in sansActeur.history[0], false);
});

test("le suivi public projette les étapes sans jamais exposer l'acteur", () => {
  const suivi = construireSuiviPublic(
    {
      id: "colis-pub",
      trackingCode: "CLI-PUBL01",
      status: "En transit",
      originCity: "Abidjan",
      destinationCity: "Bouaké",
      history: [
        {
          status: "Expédié",
          date: "2026-10-14T09:00:00.000Z",
          agencyName: "Shopin30 Abidjan",
          city: "Abidjan",
          actorId: "agent-7",
          actorName: "Koffi N'Guessan",
          note: "Étape validée au guichet"
        }
      ]
    },
    "2026-10-15T08:30:00.000Z"
  );
  assert.deepEqual(suivi.history[0], {
    status: "Expédié",
    date: "2026-10-14T09:00:00.000Z",
    agencyName: "Shopin30 Abidjan",
    city: "Abidjan",
    note: "Étape validée au guichet"
  });
  assert.equal(/agent-7|Koffi/.test(JSON.stringify(suivi)), false);
});
