/*
 * Tests de la grille tarifaire et des options de prix (LOT 2).
 * Exécution : node --test tests/   (aucune dépendance, aucun accès réseau)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MODES_ENCAISSEMENT,
  TRANCHES_DEFAUT,
  cleVille,
  estModeEncaissement,
  normaliserTarif,
  optionsPrix,
  poidsDansTranche,
  tarifsApplicables,
  trancheLibelle,
  trouverTarif,
  validerTarif
} from "../js/metier-tarifs.js";

function tarif(partial = {}) {
  return normaliserTarif({
    id: partial.id || "t-1",
    agency_id: "agence-1",
    origin_city: "Abidjan",
    destination_city: "Bouaké",
    weight_min_kg: 0,
    weight_max_kg: 2,
    price_fcfa: 2500,
    active: true,
    created_at_iso: "2026-10-01T00:00:00.000Z",
    ...partial
  });
}

const GRILLE = [
  tarif({ id: "t-1", destination_city: "Bouaké", weight_min_kg: 0, weight_max_kg: 2, price_fcfa: 2500 }),
  tarif({ id: "t-2", destination_city: "Bouaké", weight_min_kg: 2, weight_max_kg: 5, price_fcfa: 3500, created_at_iso: "2026-10-02T00:00:00.000Z" }),
  tarif({ id: "t-3", destination_city: "Bouaké", weight_min_kg: 5, weight_max_kg: 10, price_fcfa: 5000, created_at_iso: "2026-10-03T00:00:00.000Z" }),
  tarif({ id: "t-4", destination_city: "Bouaké", weight_min_kg: 10, weight_max_kg: null, price_fcfa: 7500, created_at_iso: "2026-10-04T00:00:00.000Z" }),
  tarif({ id: "t-5", destination_city: "", weight_min_kg: 0, weight_max_kg: 2, price_fcfa: 3000, created_at_iso: "2026-10-05T00:00:00.000Z" }),
  tarif({ id: "t-6", destination_city: "", weight_min_kg: 2, weight_max_kg: 5, price_fcfa: 4200, created_at_iso: "2026-10-06T00:00:00.000Z" }),
  tarif({ id: "t-7", destination_city: "Korhogo", weight_min_kg: 0, weight_max_kg: null, price_fcfa: 6000, created_at_iso: "2026-10-07T00:00:00.000Z" }),
  tarif({ id: "t-8", origin_city: "Bouaké", destination_city: "Abidjan", weight_min_kg: 0, weight_max_kg: 5, price_fcfa: 3200, created_at_iso: "2026-10-08T00:00:00.000Z" })
];

/* ------------------------------ tranches ---------------------------------- */

test("les tranches par défaut couvrent 0-2, 2-5, 5-10 et +10 kg", () => {
  assert.equal(TRANCHES_DEFAUT.length, 4);
  assert.deepEqual(TRANCHES_DEFAUT.map((t) => t.cle), ["0-2", "2-5", "5-10", "10+"]);
  assert.equal(trancheLibelle(2, 5), "2 – 5 kg");
  assert.equal(trancheLibelle(10, null), "+ 10 kg");
  assert.equal(trancheLibelle(2.5, 7.5), "2,5 – 7,5 kg");
});

test("un poids tombe dans une tranche [min ; max[ (max null = ouvert)", () => {
  const bande = tarif({ weight_min_kg: 2, weight_max_kg: 5 });
  assert.equal(poidsDansTranche(2, bande), true, "2 kg exact → tranche 2-5");
  assert.equal(poidsDansTranche(1.99, bande), false, "1,99 kg → tranche précédente");
  assert.equal(poidsDansTranche(4.99, bande), true);
  assert.equal(poidsDansTranche(5, bande), false, "5 kg exact → tranche suivante");
  const ouverte = tarif({ weight_min_kg: 10, weight_max_kg: null });
  assert.equal(poidsDansTranche(250, ouverte), true);
});

/* ------------------------------- recherche -------------------------------- */

test("la destination exacte prime sur « toutes destinations »", () => {
  const trouve = trouverTarif({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 2.5 });
  assert.equal(trouve.id, "t-2");
  assert.equal(trouve.priceFCFA, 3500);
});

test("sans destination exacte, la ligne « toutes destinations » s'applique", () => {
  const trouve = trouverTarif({ tarifs: GRILLE, originCity: "abidjan", destinationCity: "Man", weightKg: 1 });
  assert.equal(trouve.id, "t-5");
  assert.equal(trouve.priceFCFA, 3000);
});

test("aucune ligne applicable → prix libre (repli de compatibilité)", () => {
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Yamoussoukro", destinationCity: "Bouaké", weightKg: 3 }), null);
  assert.equal(trouverTarif({ tarifs: [], originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 3 }), null);
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: Number.NaN }), null);
});

test("les lignes hors grille (active = FALSE) sont ignorées", () => {
  const avecHorsGrille = GRILLE.map((t) => (t.id === "t-2" ? { ...t, active: false } : t));
  const trouve = trouverTarif({ tarifs: avecHorsGrille, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 2.5 });
  assert.equal(trouve.id, "t-6", "la ligne « toutes destinations » 2-5 kg prend le relais");
});

test("les bornes de la grille sont celles du tableau de bord", () => {
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 0.5 }).priceFCFA, 2500);
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 2 }).priceFCFA, 3500);
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 5 }).priceFCFA, 5000);
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 10 }).priceFCFA, 7500);
  assert.equal(trouverTarif({ tarifs: GRILLE, originCity: "Bouaké", destinationCity: "Abidjan", weightKg: 3 }).priceFCFA, 3200, "axe inversé = autre ligne");
});

test("tarifsApplicables trie du plus spécifique au moins spécifique", () => {
  const applicable = tarifsApplicables({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 2.5 });
  assert.equal(applicable.length, 2, "destination exacte + toutes destinations");
  assert.equal(applicable[0].destinationCity, "Bouaké");
  assert.equal(applicable[1].destinationCity, "");
});

/* -------------------------------- options --------------------------------- */

test("optionsPrix construit les libellés du menu déroulant", () => {
  const options = optionsPrix({ tarifs: GRILLE, originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 2.5 });
  assert.equal(options.length, 2);
  assert.equal(options[0].priceFCFA, 3500);
  assert.match(options[0].label, /^3.?500 FCFA/);
  assert.match(options[0].label, /2 – 5 kg/);
  assert.equal(options[0].tarifId, "t-2");
  assert.deepEqual(optionsPrix({ tarifs: [], originCity: "Abidjan", destinationCity: "Bouaké", weightKg: 2.5 }), []);
});

test("modes d'encaissement : espèces et mobile money seulement", () => {
  assert.deepEqual(MODES_ENCAISSEMENT.map((m) => m.id), ["especes", "mobile_money"]);
  assert.equal(estModeEncaissement("especes"), true);
  assert.equal(estModeEncaissement("mobile_money"), true);
  assert.equal(estModeEncaissement("cheque"), false);
  assert.equal(estModeEncaissement(""), false);
});

test("cleVille normalise la casse et les espaces", () => {
  assert.equal(cleVille("  Bouaké "), "bouaké");
  assert.equal(cleVille(undefined), "");
});

/* ----------------------------- validation grille -------------------------- */

test("validerTarif accepte une ligne valide et « toutes destinations »", () => {
  const ok = validerTarif({ originCity: " Abidjan ", destinationCity: "", weightMinKg: "2", weightMaxKg: "5", priceFCFA: "3500" });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.valeur, {
    originCity: "Abidjan",
    destinationCity: "",
    weightMinKg: 2,
    weightMaxKg: 5,
    priceFCFA: 3500
  });

  const ouverte = validerTarif({ originCity: "Abidjan", destinationCity: "Bouaké", weightMinKg: 10, weightMaxKg: null, priceFCFA: 7500 });
  assert.equal(ouverte.error, undefined);
  assert.equal(ouverte.valeur.weightMaxKg, null);
});

test("validerTarif refuse les lignes mal formées", () => {
  assert.match(validerTarif({ originCity: "A", destinationCity: "", weightMinKg: 0, weightMaxKg: 2, priceFCFA: 100 }).error, /ville de départ/);
  assert.match(validerTarif({ originCity: "Abidjan", destinationCity: "", weightMinKg: -1, weightMaxKg: 2, priceFCFA: 100 }).error, /positif/);
  assert.match(validerTarif({ originCity: "Abidjan", destinationCity: "", weightMinKg: 5, weightMaxKg: 2, priceFCFA: 100 }).error, /supérieur/);
  assert.match(validerTarif({ originCity: "Abidjan", destinationCity: "", weightMinKg: 0, weightMaxKg: 2, priceFCFA: -5 }).error, /entier/);
  assert.match(validerTarif({ originCity: "Abidjan", destinationCity: "", weightMinKg: 0, weightMaxKg: 2, priceFCFA: "abc" }).error, /montant/);
});
