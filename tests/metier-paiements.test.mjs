/*
 * Règles métier du LOT 7 — paiements en ligne (js/metier-paiements.js) :
 * montants décimaux SasPay, validation des demandes, statuts de session et
 * conformité stricte de la transaction vérifiée.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVISE,
  PAYS,
  fcfaDepuisDecimal,
  libelleAvecMode,
  libelleModePaiement,
  libelleObjetPaiement,
  libelleStatutPaiement,
  montantDecimal,
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

test("demandes : reste d'un colis, abonnement du mois, recharge bornée", () => {
  assert.deepEqual(validerDemandePaiement({ objet: "colis", parcelId: " abc " }).valeur, { objet: "colis", parcelId: "abc" });
  assert.match(validerDemandePaiement({ objet: "colis" }).error, /colis à régler/);
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
  assert.equal(libelleObjetPaiement("colis"), "Reste à payer d'un colis");
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

test("traçabilité : le mode non réel est rappelé dans les libellés de caisse et de portefeuille", () => {
  assert.equal(libelleAvecMode("Paiement SasPay", "live"), "Paiement SasPay");
  assert.equal(libelleAvecMode("Paiement SasPay", "test"), "Paiement SasPay (test)");
  assert.equal(libelleAvecMode("Paiement SasPay", "simulation"), "Paiement SasPay (simulation)");
});
