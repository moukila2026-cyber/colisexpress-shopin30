/*
 * Règles métier du LOT 7 — paiements en ligne (js/metier-paiements.js) :
 * montants décimaux SasPay, validation des demandes, statuts de session et
 * conformité stricte de la transaction vérifiée.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVISE,
  MESSAGE_COLIS_GUICHET,
  MODES_FRAIS_SASPAY,
  OBJETS_PAIEMENT,
  OBJETS_PAIEMENT_CREATION,
  PAYS,
  fcfaDepuisDecimal,
  libelleAvecMode,
  libelleModePaiement,
  libelleObjetPaiement,
  libelleStatutPaiement,
  montantDecimal,
  montantDemandeFCFA,
  normaliserModeFrais,
  statutDepuisSession,
  transactionConforme,
  validerDemandePaiement
} from "../js/metier-paiements.js";

test("montants : chaînes décimales SasPay, jamais de flottant ni de centimes", () => {
  assert.equal(DEVISE, "XOF");
  assert.equal(PAYS, "CI");
  assert.equal(montantDecimal(3500), "3500.00");
  assert.equal(montantDecimal("10000"), "10000.00");
  assert.equal(montantDecimal(-1), null);
  assert.equal(montantDecimal("abc"), null);
  assert.equal(fcfaDepuisDecimal("3500.00"), 3500);
  assert.equal(fcfaDepuisDecimal("3500"), 3500);
  assert.equal(fcfaDepuisDecimal("3500.50"), null, "le FCFA n'a pas de centimes");
  assert.equal(fcfaDepuisDecimal("3,500"), null);
  assert.equal(fcfaDepuisDecimal(null), null);
});

test("demandes (LOT 8) : le colis est refusé (403, guichet), abonnement du mois et recharge bornée", () => {
  assert.deepEqual([...OBJETS_PAIEMENT_CREATION], ["abonnement", "recharge"], "seuls l'abonnement et la recharge se paient en ligne");
  assert.ok(OBJETS_PAIEMENT.includes("colis"), "l'objet colis reste reconnu dans l'historique");
  const colis = validerDemandePaiement({ objet: "colis", parcelId: "abc" });
  assert.equal(colis.status, 403);
  assert.equal(colis.error, MESSAGE_COLIS_GUICHET);
  assert.match(colis.error, /guichet/);
  assert.match(colis.error, /abonnement et les recharges/);
  assert.equal(validerDemandePaiement({ objet: "colis" }).status, 403);
  assert.deepEqual(validerDemandePaiement({ objet: "abonnement" }).valeur, { objet: "abonnement" });
  assert.deepEqual(validerDemandePaiement({ objet: "recharge", montantFCFA: 5000 }).valeur, { objet: "recharge", montantFCFA: 5000 });
  for (const montant of [0, 99, 12.5, "x", 1_000_001]) {
    assert.match(validerDemandePaiement({ objet: "recharge", montantFCFA: montant }).error, /entre 100 et 1 000 000 FCFA/);
  }
  assert.match(validerDemandePaiement({ objet: "don" }).error, /Choisissez ce qui est payé/);
});

test("statuts : la session « PAID » n'est qu'un candidat, expirée et annulée sont terminales", () => {
  assert.equal(statutDepuisSession("PAID"), "paye");
  assert.equal(statutDepuisSession("paid"), "paye");
  assert.equal(statutDepuisSession("EXPIRED"), "expire");
  assert.equal(statutDepuisSession("CANCELLED"), "annule");
  assert.equal(statutDepuisSession("PENDING"), "en_attente");
  assert.equal(statutDepuisSession(undefined), "en_attente");
  assert.equal(libelleStatutPaiement("paye"), "Payé");
  assert.equal(libelleObjetPaiement("colis"), "Reste à payer d'un colis (historique)");
  assert.equal(libelleModePaiement("simulation"), "Simulation");
});

test("transaction conforme : SUCCESS, XOF et montant demandé exact — sinon rien n'est appliqué", () => {
  assert.deepEqual(transactionConforme({ status: "SUCCESS", currency: "XOF", requested_amount: "3500.00" }, 3500), { ok: true });
  assert.equal(transactionConforme({ status: "PENDING", currency: "XOF", requested_amount: "3500.00" }, 3500).ok, false);
  assert.equal(transactionConforme({ status: "FAILED", currency: "XOF", requested_amount: "3500.00" }, 3500).ok, false);
  assert.equal(transactionConforme({ status: "SUCCESS", currency: "XAF", requested_amount: "3500.00" }, 3500).raison, "devise inattendue");
  assert.equal(transactionConforme({ status: "SUCCESS", currency: "XOF", requested_amount: "100.00" }, 3500).raison, "montant inattendu");
  assert.equal(transactionConforme({ status: "SUCCESS", currency: "XOF" }, 3500).raison, "montant inattendu");
  assert.equal(transactionConforme({}, 3500).ok, false);
});

test("frais SasPay : requested_amount fait foi dans les deux modes ; replis cohérents avec fee_charge_mode", () => {
  assert.deepEqual([...MODES_FRAIS_SASPAY], ["ADD_ON", "DEDUCTED"]);
  assert.equal(normaliserModeFrais(" deducted "), "DEDUCTED");
  assert.equal(normaliserModeFrais("add_on"), "ADD_ON");
  assert.equal(normaliserModeFrais("autre"), null);
  assert.equal(normaliserModeFrais(undefined), null);
  // ADD_ON : le client paie 2537.50, le marchand reçoit 2500 ; demandé = 2500.
  const addOn = { status: "SUCCESS", currency: "XOF", requested_amount: "2500.00", debited_amount: "2537.50", net_amount: "2500.00", fee_charge_mode: "ADD_ON" };
  assert.deepEqual(transactionConforme(addOn, 2500), { ok: true });
  assert.equal(montantDemandeFCFA(addOn), 2500);
  // DEDUCTED : le client paie exactement 2500, le marchand reçoit 2462.50 ; demandé = 2500.
  const deduit = { status: "SUCCESS", currency: "XOF", requested_amount: "2500.00", debited_amount: "2500.00", net_amount: "2462.50", fee_charge_mode: "DEDUCTED" };
  assert.deepEqual(transactionConforme(deduit, 2500), { ok: true }, "les frais retenus ne rendent pas le paiement non conforme");
  assert.equal(transactionConforme(deduit, 2462).ok, false, "le montant crédité reste le montant demandé, pas le net");
  // Sans requested_amount : repli sur le champ égal au montant demandé selon le mode.
  assert.equal(montantDemandeFCFA({ net_amount: "2500.00", debited_amount: "2537.50", fee_charge_mode: "ADD_ON" }), 2500);
  assert.equal(montantDemandeFCFA({ net_amount: "2462.50", debited_amount: "2500.00", fee_charge_mode: "DEDUCTED" }), 2500);
  assert.equal(montantDemandeFCFA({ amount: "2500.00" }), 2500);
  assert.equal(montantDemandeFCFA({ net_amount: "2462.50", debited_amount: "2500.00" }), null, "mode inconnu et pas de montant demandé : refus");
});

test("traçabilité : le mode non réel est rappelé dans les libellés de caisse et de portefeuille", () => {
  assert.equal(libelleAvecMode("Paiement SasPay", "live"), "Paiement SasPay");
  assert.equal(libelleAvecMode("Paiement SasPay", "test"), "Paiement SasPay (test)");
  assert.equal(libelleAvecMode("Paiement SasPay", "simulation"), "Paiement SasPay (simulation)");
});
