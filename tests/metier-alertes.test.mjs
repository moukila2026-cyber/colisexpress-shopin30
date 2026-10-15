/*
 * Tests des alertes « colis qui dorment » (LOT 4) : js/metier-alertes.js —
 * sans mouvement > 48 h, non retiré > 72 h, non rattaché > 7 j, souffrance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SEUIL_NON_RATTACHE_J,
  SEUIL_NON_RETIRE_H,
  SEUIL_SANS_MOUVEMENT_H,
  SEUIL_SOUFFRANCE_J,
  alertesParSignal,
  dateArriveeDestinantion,
  estEnSouffrance,
  evaluerAlertes,
  joursDepuis
} from "../js/metier-alertes.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const heures = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function colis(overrides = {}) {
  return {
    id: "p1", trackingCode: "CLI-TEST01", status: "En transit",
    createdAtISO: heures(1), updatedAtISO: heures(1),
    destinationAgencyId: "B", originCity: "Abidjan", destinationCity: "Bouaké",
    history: [], ...overrides
  };
}

test("sans mouvement : Expédié/En transit immobiles depuis plus de 48 h", () => {
  assert.deepEqual(evaluerAlertes(colis({ updatedAtISO: heures(47) }), NOW), [], "sous le seuil : rien");
  const alertes = evaluerAlertes(colis({ status: "Expédié", updatedAtISO: heures(49) }), NOW);
  assert.equal(alertes.length, 1);
  assert.equal(alertes[0].cle, "sans_mouvement");
  assert.equal(alertes[0].heures, 49);

  // Un colis enregistré/arrivé/retiré ne déclenche pas ce signal.
  assert.deepEqual(evaluerAlertes(colis({ status: "Enregistré", updatedAtISO: heures(200) }), NOW).filter((a) => a.cle === "sans_mouvement"), []);
  assert.deepEqual(evaluerAlertes(colis({ status: "Retiré", updatedAtISO: heures(200) }), NOW), []);
});

test("non retiré : arrivé depuis plus de 72 h (date d'arrivée prise dans l'historique)", () => {
  const history = [
    { status: "Enregistré", date: heures(200) },
    { status: "Arrivé à l'agence de destination", date: heures(80) }
  ];
  const alertes = evaluerAlertes(colis({ status: "Arrivé à l'agence de destination", history, updatedAtISO: heures(80) }), NOW);
  assert.ok(alertes.some((a) => a.cle === "non_retire" && a.heures === 80));
  assert.equal(dateArriveeDestinantion(colis({ history })), heures(80));

  const recent = evaluerAlertes(colis({
    status: "Arrivé à l'agence de destination",
    history: [{ status: "Arrivé à l'agence de destination", date: heures(10) }]
  }), NOW);
  assert.deepEqual(recent, []);
});

test("souffrance : arrivé non retiré depuis plus de 7 jours, sauf retour terminé", () => {
  const history = [{ status: "Arrivé à l'agence de destination", date: heures(8 * 24) }];
  const souffrant = colis({ status: "Arrivé à l'agence de destination", history, updatedAtISO: heures(8 * 24) });
  const alertes = evaluerAlertes(souffrant, NOW);
  assert.ok(alertes.some((a) => a.cle === "non_retire"));
  assert.ok(alertes.some((a) => a.cle === "souffrance"));
  assert.equal(estEnSouffrance(souffrant, NOW), true);
  assert.equal(estEnSouffrance(colis({ ...souffrant, retourStatus: "termine" }), NOW), false, "un retour terminé sort de la souffrance");
  assert.equal(joursDepuis(heures(8 * 24), NOW), 8);
});

test("non rattaché : aucune agence de destination depuis plus de 7 jours", () => {
  const alertes = evaluerAlertes(colis({ status: "Enregistré", destinationAgencyId: null, createdAtISO: heures(8 * 24), updatedAtISO: heures(8 * 24) }), NOW);
  assert.deepEqual(alertes.map((a) => a.cle), ["non_rattache"]);
  assert.deepEqual(evaluerAlertes(colis({ destinationAgencyId: null, createdAtISO: heures(24) }), NOW), [], "sous 7 jours : rien");
  assert.deepEqual(evaluerAlertes(colis({ status: "Enregistré", createdAtISO: heures(30 * 24), updatedAtISO: heures(30 * 24) }), NOW), [], "rattaché : rien");
});

test("alertesParSignal regroupe et trie par ancienneté décroissante", () => {
  const parcels = [
    colis({ id: "p1", trackingCode: "CLI-TEST01", status: "En transit", updatedAtISO: heures(50) }),
    colis({ id: "p2", trackingCode: "CLI-TEST02", status: "Expédié", updatedAtISO: heures(100) }),
    colis({ id: "p3", trackingCode: "CLI-TEST03", status: "Enregistré", destinationAgencyId: null, createdAtISO: heures(9 * 24), updatedAtISO: heures(9 * 24) })
  ];
  const groupes = alertesParSignal(parcels, NOW);
  assert.deepEqual(groupes.sans_mouvement.map((item) => item.trackingCode), ["CLI-TEST02", "CLI-TEST01"], "le plus ancien d'abord");
  assert.deepEqual(groupes.non_rattache.map((item) => item.id), ["p3"]);
  assert.deepEqual(groupes.non_retire, []);
  assert.deepEqual(groupes.souffrance, []);

  assert.equal(SEUIL_SANS_MOUVEMENT_H, 48);
  assert.equal(SEUIL_NON_RETIRE_H, 72);
  assert.equal(SEUIL_NON_RATTACHE_J, 7);
  assert.equal(SEUIL_SOUFFRANCE_J, 7);
});
