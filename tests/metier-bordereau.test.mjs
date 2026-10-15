/*
 * Tests des bordereaux d'acheminement (LOT 4) : js/metier-bordereau.js —
 * validation de création, colis embarquables, étapes par acteur, contrôle
 * d'arrivée et projection publique.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COLIS_BORDEREAU,
  STATUTS_BORDEREAU,
  STATUTS_COLIS_EMBARQUABLES,
  agenceDeControle,
  bordereauPublic,
  normaliserBordereau,
  peutControler,
  prochaineEtapeBordereau,
  resoudreControle,
  validerColisEmbarquables,
  validerCreationBordereau
} from "../js/metier-bordereau.js";

const VALEURS = { carrierName: "Gbaka Express", carrierPhone: "0700000055", vehicleRef: "car Bouaké 07 h", parcelIds: ["p1", "p2"] };

test("validerCreationBordereau accepte un lot valide et normalise le téléphone", () => {
  const ok = validerCreationBordereau({ ...VALEURS, carrierPhone: "+225 07-00-00-00-55" });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.valeur, { carrierName: "Gbaka Express", carrierPhone: "0700000055", vehicleRef: "car Bouaké 07 h", parcelIds: ["p1", "p2"] });
});

test("validerCreationBordereau refuse les lots mal formés (0, >200, doublons, transporteur)", () => {
  assert.match(validerCreationBordereau({ ...VALEURS, parcelIds: [] }).error, /au moins un colis/i);
  assert.match(validerCreationBordereau({ ...VALEURS, parcelIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }).error, /200/);
  assert.equal(validerCreationBordereau({ ...VALEURS, parcelIds: ["p1", "p1", "p2"] }).valeur.parcelIds.length, 2, "les doublons sont dédupliqués");
  assert.match(validerCreationBordereau({ ...VALEURS, carrierName: "X" }).error, /transporteur/i);
  assert.match(validerCreationBordereau({ ...VALEURS, carrierPhone: "123" }).error, /téléphone/i);
  assert.match(validerCreationBordereau({ ...VALEURS, vehicleRef: "x".repeat(121) }).error, /véhicule/i);
  assert.equal(MAX_COLIS_BORDEREAU, 200);
  assert.deepEqual(STATUTS_COLIS_EMBARQUABLES, ["Enregistré", "Expédié"]);
});

function colis(id, options = {}) {
  return {
    id, trackingCode: `CLI-${id}`, ownerId: "A", status: "Expédié",
    destinationAgencyId: "B", destinationAgencyName: "Agence B", destinationCity: "Bouaké",
    originCity: "Abidjan", bordereauId: null, ...options
  };
}

test("validerColisEmbarquables exige même expéditeur, même destination, statut embarquable, hors bordereau", () => {
  assert.equal(validerColisEmbarquables({ parcels: [colis("p1")], agencyId: "A" }).error, undefined);
  assert.match(validerColisEmbarquables({ parcels: [], agencyId: "A" }).error, /au moins un colis/i);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1")], agencyId: "autre" }).error, /appartient pas à votre agence/);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1", { status: "En transit" })], agencyId: "A" }).error, /ne peut plus être bordé/);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1", { bordereauId: "b1" })], agencyId: "A" }).error, /déjà partie d'un bordereau/);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1"), colis("p2", { destinationAgencyId: "C" })], agencyId: "A" }).error, /même agence de destination/);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1"), colis("p2", { destinationAgencyId: null, destinationCity: "Korhogo" })], agencyId: "A" }).error, /même agence de destination/);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1"), colis("p2", { destinationCity: "Man" })], agencyId: "A" }).error, /même ville d'arrivée/);
  assert.match(validerColisEmbarquables({ parcels: [colis("p1"), colis("p2", { originCity: "Man" })], agencyId: "A" }).error, /partir de la même ville/);

  // Deux colis vers une agence non rattachée mais même ville : autorisé.
  const nonRattaches = validerColisEmbarquables({
    parcels: [colis("p1", { destinationAgencyId: null, destinationCity: "Korhogo" }), colis("p2", { destinationAgencyId: null, destinationCity: "korhogo " })],
    agencyId: "A"
  });
  assert.equal(nonRattaches.error, undefined);
  assert.equal(nonRattaches.destination.toAgencyId, null);
  assert.equal(nonRattaches.destination.toCity, "Korhogo");
});

const B = { id: "b1", code: "BDR-TEST01", fromAgencyId: "A", toAgencyId: "B", status: "Préparé", parcelCount: 2 };

test("les étapes du bordereau sont verrouillées par acteur", () => {
  assert.deepEqual(STATUTS_BORDEREAU, ["Préparé", "Remis", "En route", "Arrivé", "Contrôlé", "Écart"]);
  assert.equal(prochaineEtapeBordereau({ bordereau: B, agencyId: "A" }), "Remis");
  assert.equal(prochaineEtapeBordereau({ bordereau: B, agencyId: "B" }), null, "la destination n'émarge pas la remise");
  assert.equal(prochaineEtapeBordereau({ bordereau: { ...B, status: "Remis" }, agencyId: "A" }), "En route");
  assert.equal(prochaineEtapeBordereau({ bordereau: { ...B, status: "En route" }, agencyId: "A" }), null);
  assert.equal(prochaineEtapeBordereau({ bordereau: { ...B, status: "En route" }, agencyId: "B" }), "Arrivé");
  assert.equal(prochaineEtapeBordereau({ bordereau: { ...B, status: "Arrivé" }, agencyId: "B" }), null, "l'arrivée passe par le contrôle");
  assert.equal(prochaineEtapeBordereau({ bordereau: { ...B, status: "Contrôlé" }, agencyId: "A" }), null);

  // Destination non rattachée : l'expéditrice déclare l'arrivée et contrôle.
  const nonRattache = { ...B, toAgencyId: null };
  assert.equal(agenceDeControle(nonRattache), "A");
  assert.equal(prochaineEtapeBordereau({ bordereau: { ...nonRattache, status: "En route" }, agencyId: "A" }), "Arrivé");
  assert.equal(peutControler({ bordereau: { ...nonRattache, status: "Arrivé" }, agencyId: "A" }), true);
  assert.equal(peutControler({ bordereau: { ...B, status: "Arrivé" }, agencyId: "B" }), true);
  assert.equal(peutControler({ bordereau: { ...B, status: "Arrivé" }, agencyId: "A" }), false);
  assert.equal(peutControler({ bordereau: { ...B, status: "En route" }, agencyId: "B" }), false, "pas de contrôle avant l'arrivée");
});

test("resoudreControle : tout présent → Contrôlé, un absent → Écart", () => {
  const complet = resoudreControle({ bordereau: B, parcelIds: ["p1", "p2"], absentParcelIds: [] });
  assert.equal(complet.status, "Contrôlé");
  assert.deepEqual(complet.presents, ["p1", "p2"]);
  assert.deepEqual(complet.absents, []);

  const ecart = resoudreControle({ bordereau: B, parcelIds: ["p1", "p2"], absentParcelIds: ["p2", "pX"] });
  assert.equal(ecart.status, "Écart");
  assert.deepEqual(ecart.absents, ["p2"], "un identifiant hors lot est ignoré");
  assert.deepEqual(ecart.presents, ["p1"]);

  assert.match(resoudreControle({ bordereau: B, parcelIds: [], absentParcelIds: [] }).error, /Aucun colis/);
});

test("bordereauPublic ne contient aucune donnée personnelle", () => {
  const bordereau = normaliserBordereau({
    id: "b1", code: "BDR-TEST01", from_agency_id: "A", from_agency_name: "Agence A", from_city: "Abidjan",
    to_agency_id: "B", to_agency_name: "Agence B", to_city: "Bouaké",
    carrier_name: "Gbaka Express", carrier_phone: "0700000055", vehicle_ref: "car 07 h",
    parcel_count: 1, status: "Contrôlé", checked_at: "2026-10-10T10:00:00.000Z",
    missing_parcel_ids: JSON.stringify(["p1"]), created_at_iso: "2026-10-09T10:00:00.000Z"
  }, ["p1"]);
  assert.deepEqual(bordereau.missingParcelIds, ["p1"]);

  const projection = bordereauPublic(
    { ...bordereau, carrierPhone: "" },
    [{ id: "p1", trackingCode: "CLI-TEST01", status: "En transit" }],
    "2026-10-10T10:00:00.000Z"
  );
  const brut = JSON.stringify(projection);
  assert.ok(!brut.includes("0700000055"), "le téléphone du transporteur ne sort jamais en public");
  assert.ok(!brut.includes('"id"'), "aucun identifiant interne de colis ou d'agence");
  assert.deepEqual(projection.parcels, [{ trackingCode: "CLI-TEST01", status: "En transit", present: false }]);
  assert.equal(projection.parcelCount, 1);
  assert.equal(projection.status, "Contrôlé");
});
