/*
 * Règles métier du LOT 6 (js/metier-plans.js) : plans, périodes, quotas,
 * dépassements prépayés, échéances, validations et projections.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DELAI_ECHEANCE_JOURS,
  IDS_PLANS,
  PLANS,
  PRIX_DEPASSEMENT_FCFA,
  bornesPeriode,
  calculerEcheance,
  clePeriode,
  conditionsPlan,
  decisionCreation,
  echeancesFacturation,
  estClePeriode,
  etatAbonnement,
  libellePeriode,
  libelleStatutAbonnement,
  messageQuotaAtteint,
  normaliserPeriode,
  periodeSuivante,
  quotaEffectif,
  resumeFacturation,
  validerChangementPlan,
  validerPlanPlateforme,
  validerRecharge
} from "../js/metier-plans.js";

test("catalogue : Gratuit 50 colis + 30 FCFA prépayés, Pro 10 000 FCFA / 500 colis, Réseau sur devis", () => {
  assert.deepEqual(IDS_PLANS, ["gratuit", "pro", "reseau"]);
  assert.equal(PLANS.gratuit.quotaMensuel, 50);
  assert.equal(PLANS.gratuit.prixMensuelFCFA, 0);
  assert.equal(PLANS.gratuit.depassementFCFA, 30);
  assert.equal(PLANS.pro.prixMensuelFCFA, 10_000);
  assert.equal(PLANS.pro.quotaMensuel, 500);
  assert.equal(PLANS.reseau.surDevis, true);
  assert.equal(PLANS.reseau.prixMensuelFCFA, null);
  assert.equal(PRIX_DEPASSEMENT_FCFA, 30);
  assert.ok(Object.isFrozen(PLANS) && Object.isFrozen(PLANS.pro), "le catalogue n'est pas modifiable à l'exécution");
});

test("périodes mensuelles (fuseau d'Abidjan = UTC) : clé, bornes, mois suivant, libellé", () => {
  assert.equal(clePeriode(new Date("2026-10-15T08:00:00Z")), "2026-10");
  assert.equal(clePeriode(new Date("2026-10-31T23:59:59Z")), "2026-10");
  assert.equal(clePeriode(new Date("2026-11-01T00:00:00Z")), "2026-11");
  assert.deepEqual(bornesPeriode("2026-12"), { debutISO: "2026-12-01T00:00:00.000Z", finISO: "2027-01-01T00:00:00.000Z" });
  assert.equal(periodeSuivante("2026-12"), "2027-01");
  assert.equal(libellePeriode("2026-10"), "octobre 2026");
  assert.equal(libellePeriode("2026-02"), "février 2026");
  assert.ok(estClePeriode("2026-01") && !estClePeriode("2026-13") && !estClePeriode("26-01"));
  assert.equal(calculerEcheance("2026-10-01T00:00:00.000Z"), "2026-10-08T00:00:00.000Z");
  assert.equal(DELAI_ECHEANCE_JOURS, 7);
});

test("conditions d'un plan : Réseau négocié (quota vide = illimité)", () => {
  assert.deepEqual(conditionsPlan({ plan: "gratuit" }), { plan: "gratuit", quota: 50, abonnementFCFA: 0 });
  assert.deepEqual(conditionsPlan({ plan: "pro" }), { plan: "pro", quota: 500, abonnementFCFA: 10_000 });
  assert.deepEqual(conditionsPlan({ plan: "reseau", quotaNegocie: 2000, prixNegocieFCFA: 45_000 }), { plan: "reseau", quota: 2000, abonnementFCFA: 45_000 });
  assert.deepEqual(conditionsPlan({ plan: "reseau" }), { plan: "reseau", quota: null, abonnementFCFA: 0 });
  assert.deepEqual(conditionsPlan({ plan: "inconnu" }), { plan: "gratuit", quota: 50, abonnementFCFA: 0 }, "repli prudent sur le Gratuit");
});

test("abonnement : sans frais, payé, dû, en retard après l'échéance", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  assert.deepEqual(etatAbonnement({ montantFCFA: 0, statut: "sans_frais", now }), { statut: "sans_frais", enRetard: false });
  assert.deepEqual(etatAbonnement({ montantFCFA: 10_000, statut: "paye", echeanceISO: "2026-10-08T00:00:00Z", now }), { statut: "paye", enRetard: false });
  assert.deepEqual(etatAbonnement({ montantFCFA: 10_000, statut: "du", echeanceISO: "2026-10-20T00:00:00Z", now }), { statut: "du", enRetard: false });
  assert.deepEqual(etatAbonnement({ montantFCFA: 10_000, statut: "du", echeanceISO: "2026-10-08T00:00:00Z", now }), { statut: "du", enRetard: true });
  assert.equal(libelleStatutAbonnement({ statut: "du", enRetard: true }), "Impayé — échéance dépassée");
  assert.equal(libelleStatutAbonnement({ statut: "paye" }), "Payé");
});

test("quota effectif : un abonnement impayé après échéance ramène au quota Gratuit (création seulement)", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  const enRetard = { montantFCFA: 10_000, statut: "du", echeanceISO: "2026-10-08T00:00:00Z" };
  const aJour = { montantFCFA: 10_000, statut: "du", echeanceISO: "2026-10-20T00:00:00Z" };
  assert.equal(quotaEffectif({ quota: 500, abonnement: aJour, now }), 500, "délai de paiement : quota Pro conservé");
  assert.equal(quotaEffectif({ quota: 500, abonnement: enRetard, now }), 50);
  assert.equal(quotaEffectif({ quota: null, abonnement: enRetard, now }), 50, "Réseau illimité en retard → 50");
  assert.equal(quotaEffectif({ quota: null, now }), null, "Réseau illimité à jour");
  assert.equal(quotaEffectif({ quota: 50, now }), 50);
});

test("décision de création : inclus jusqu'au quota, puis 30 FCFA prépayés ; illimité = toujours inclus", () => {
  assert.deepEqual(decisionCreation({ rang: 50, quota: 50 }), { type: "inclus", montantFCFA: 0 });
  assert.deepEqual(decisionCreation({ rang: 51, quota: 50 }), { type: "depassement", montantFCFA: 30 });
  assert.deepEqual(decisionCreation({ rang: 501, quota: 500 }), { type: "depassement", montantFCFA: 30 });
  assert.deepEqual(decisionCreation({ rang: 100_000, quota: null }), { type: "inclus", montantFCFA: 0 });
  const message = messageQuotaAtteint({ plan: "gratuit", quota: 50, soldeFCFA: 10 });
  assert.match(message, /quota du plan Gratuit est atteint \(50 colis/);
  assert.match(message, /30 FCFA/);
  assert.match(message, /solde : 10 FCFA/);
  assert.match(message, /colis déjà enregistrés continuent d'avancer/, "le message rassure : rien n'est bloqué en cours de route");
  assert.match(messageQuotaAtteint({ plan: "pro", quota: 50, enRetard: true }), /impayé après son échéance/);
});

test("changement de plan par le gérant : Pro immédiat, Gratuit le mois suivant, Réseau sur devis", () => {
  assert.deepEqual(validerChangementPlan({ planActuel: "gratuit", planDemande: "pro" }).valeur, { plan: "pro", effet: "immediat" });
  assert.deepEqual(validerChangementPlan({ planActuel: "pro", planDemande: "gratuit" }).valeur, { plan: "gratuit", effet: "periode_suivante" });
  assert.deepEqual(validerChangementPlan({ planActuel: "pro", planSuivant: "gratuit", planDemande: "pro" }).valeur, { plan: "pro", effet: "annulation" });
  assert.match(validerChangementPlan({ planActuel: "pro", planSuivant: "gratuit", planDemande: "gratuit" }).error, /déjà programmé/);
  assert.match(validerChangementPlan({ planActuel: "gratuit", planDemande: "gratuit" }).error, /déjà au plan Gratuit/);
  assert.match(validerChangementPlan({ planActuel: "gratuit", planDemande: "reseau" }).error, /sur devis/);
  assert.match(validerChangementPlan({ planActuel: "reseau", planDemande: "gratuit" }).error, /géré par Shopin30/);
  assert.match(validerChangementPlan({ planActuel: "gratuit", planDemande: "vip" }).error, /inconnu/);
});

test("plan fixé par la plateforme et recharge : validations", () => {
  assert.deepEqual(validerPlanPlateforme({ plan: "pro" }).valeur, { plan: "pro", quotaNegocie: null, prixNegocieFCFA: null });
  assert.deepEqual(validerPlanPlateforme({ plan: "reseau", quotaMensuel: "2000", prixMensuelFCFA: "45000" }).valeur, { plan: "reseau", quotaNegocie: 2000, prixNegocieFCFA: 45_000 });
  assert.deepEqual(validerPlanPlateforme({ plan: "reseau", quotaMensuel: "", prixMensuelFCFA: 0 }).valeur, { plan: "reseau", quotaNegocie: null, prixNegocieFCFA: 0 });
  assert.match(validerPlanPlateforme({ plan: "reseau", quotaMensuel: "0", prixMensuelFCFA: 1 }).error, /quota négocié/);
  assert.match(validerPlanPlateforme({ plan: "reseau", quotaMensuel: "12.5", prixMensuelFCFA: 1 }).error, /quota négocié/);
  assert.match(validerPlanPlateforme({ plan: "reseau", quotaMensuel: "" }).error, /prix mensuel négocié/);
  assert.match(validerPlanPlateforme({ plan: "or" }).error, /inconnu/);

  assert.deepEqual(validerRecharge({ montantFCFA: 3000, reference: "  MM 123  456 " }).valeur, { montantFCFA: 3000, reference: "MM 123 456" });
  for (const montant of [0, -5, 12.5, "abc", 1_000_001]) {
    assert.match(validerRecharge({ montantFCFA: montant, reference: "MM-1" }).error, /entre 1 et 1 000 000/);
  }
  assert.match(validerRecharge({ montantFCFA: 100, reference: "x" }).error, /référence/);
});

test("projections : période normalisée, synthèse et échéances à venir", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  const periode = normaliserPeriode({
    periode: "2026-10", plan: "pro", quota: 500, colis_comptes: 498, colis_depassement: 0,
    abonnement_fcfa: 10_000, abonnement_statut: "du", echeance_iso: "2026-10-20T00:00:00.000Z"
  }, now);
  assert.equal(periode.libelle, "octobre 2026");
  assert.equal(periode.quotaEffectif, 500);
  assert.equal(periode.inclusRestants, 2);
  assert.deepEqual(periode.abonnement, { montantFCFA: 10_000, statut: "du", enRetard: false, echeanceISO: "2026-10-20T00:00:00.000Z", payeLeISO: null });

  const resume = resumeFacturation({ periode, soldeFCFA: 95 });
  assert.equal(resume.colisPrepayes, 3);
  assert.equal(resume.prochainColis.type, "inclus");
  assert.match(resume.alerte, /Plus que 2 colis inclus/);
  const plein = resumeFacturation({ periode: { ...periode, compteur: 500 }, soldeFCFA: 0 });
  assert.equal(plein.prochainColis.type, "depassement");
  assert.match(plein.alerte, /portefeuille insuffisant/);
  assert.match(plein.alerte, /jamais bloqués/);

  const echeances = echeancesFacturation({ periode, plan: "pro" });
  assert.equal(echeances.length, 2);
  assert.deepEqual(echeances[0], { libelle: "Abonnement Pro — octobre 2026", montantFCFA: 10_000, echeanceISO: "2026-10-20T00:00:00.000Z", statut: "a_regler" });
  assert.deepEqual(echeances[1], { libelle: "Abonnement Pro — novembre 2026", montantFCFA: 10_000, echeanceISO: "2026-11-08T00:00:00.000Z", statut: "a_venir" });
  assert.deepEqual(echeancesFacturation({ periode: { ...periode, abonnement: { statut: "paye" } }, plan: "pro", planSuivant: "gratuit" }), [], "retour au Gratuit programmé : plus d'échéance");
});
