/*
 * Facturation (LOT 6) — périodes mensuelles, compteur de colis, portefeuille
 * prépayé et abonnements. Les règles pures (plans, quotas, échéances) sont
 * dans js/metier-plans.js ; ce module n'applique que les écritures en base.
 *
 * Garanties :
 * - compteur atomique (UPDATE … RETURNING) : chaque colis a un rang unique
 *   dans le mois, même quand deux agents enregistrent en même temps ;
 * - débit conditionnel (UPDATE … WHERE solde >= montant) doublé de la
 *   contrainte CHECK (portefeuille_fcfa >= 0) : jamais de solde négatif ;
 * - chaque mouvement est journalisé DANS LA MÊME instruction SQL que la
 *   variation du solde (CTE) : solde et journal ne divergent jamais ;
 * - seule `reserverCreation()` peut refuser quelque chose, et uniquement la
 *   création d'un NOUVEAU colis par l'agence expéditrice. Rien ici n'est
 *   appelé par la lecture, la progression, la réception, le contrôle ou le
 *   retour d'un colis : un solde impayé ne bloque jamais un colis en cours.
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import {
  calculerEcheance,
  clePeriode,
  conditionsPlan,
  decisionCreation,
  echeancesFacturation,
  libelleMouvement,
  libellePeriode,
  libellePlan,
  messageQuotaAtteint,
  normaliserPeriode,
  resumeFacturation,
  validerChangementPlan
} from "../js/metier-plans.js";

async function lirePeriode(agencyId, cle) {
  const { rows } = await query("SELECT * FROM facturation_periodes WHERE agency_id = $1 AND periode = $2", [agencyId, cle]);
  return rows[0] || null;
}

async function lireAgence(agencyId) {
  const { rows } = await query(
    "SELECT id, plan, plan_suivant, quota_negocie, prix_negocie_fcfa, portefeuille_fcfa FROM agencies WHERE id = $1",
    [agencyId]
  );
  return rows[0] || null;
}

function estViolationSolde(error) {
  return /23514|check constraint/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`);
}

/** Ligne SQL `portefeuille_mouvements` → mouvement métier (camelCase). */
export function normaliserMouvement(row = {}) {
  return {
    id: row.id,
    type: row.type,
    libelleType: libelleMouvement(row.type),
    montantFCFA: Number(row.montant_fcfa ?? 0),
    soldeApresFCFA: Number(row.solde_apres_fcfa ?? 0),
    periode: row.periode ?? null,
    parcelId: row.parcel_id ?? null,
    libelle: row.libelle,
    reference: row.reference ?? "",
    acteurNom: row.acteur_nom ?? "",
    createdAtISO: row.created_at_iso
  };
}

/**
 * Règle l'abonnement dû d'une période depuis le portefeuille, si le solde le
 * permet. Statut, solde et journal changent dans une seule instruction.
 * Renvoie true si un règlement a eu lieu.
 */
export async function reglerAbonnement(agencyId, cle = clePeriode(), now = new Date()) {
  const ligne = await lirePeriode(agencyId, cle);
  if (!ligne || ligne.abonnement_statut !== "du") return false;
  const nowISO = new Date(now).toISOString();
  try {
    const { rows } = await query(
      `WITH periode AS (
         UPDATE facturation_periodes SET abonnement_statut = 'paye', paye_le_iso = $3
         WHERE agency_id = $1 AND periode = $2 AND abonnement_statut = 'du'
           AND abonnement_fcfa <= (SELECT portefeuille_fcfa FROM agencies WHERE id = $1)
         RETURNING abonnement_fcfa
       ), debit AS (
         UPDATE agencies SET portefeuille_fcfa = portefeuille_fcfa - (SELECT abonnement_fcfa FROM periode)
         WHERE id = $1 AND EXISTS (SELECT 1 FROM periode)
         RETURNING portefeuille_fcfa
       )
       INSERT INTO portefeuille_mouvements (id, agency_id, type, montant_fcfa, solde_apres_fcfa, periode, libelle, created_at_iso)
       SELECT $4, $1, 'abonnement', -periode.abonnement_fcfa, debit.portefeuille_fcfa, $2, $5, $3
       FROM periode, debit
       RETURNING solde_apres_fcfa`,
      [agencyId, cle, nowISO, crypto.randomUUID(), `Abonnement ${libellePlan(ligne.plan)} — ${libellePeriode(cle)}`]
    );
    return rows.length > 0;
  } catch (error) {
    // Course rare avec un débit concurrent : la contrainte CHECK (solde >= 0)
    // annule l'instruction entière — l'abonnement reste dû, rien n'est perdu.
    if (estViolationSolde(error)) return false;
    throw error;
  }
}

/**
 * Ouvre (idempotent) la période du mois : applique un retour au Gratuit
 * programmé, fige plan et quota, crée l'abonnement dû (échéance à J+7) puis
 * le prélève sur le portefeuille si le solde le permet.
 */
export async function ouvrirPeriode(agencyId, now = new Date()) {
  const cle = clePeriode(now);
  const existante = await lirePeriode(agencyId, cle);
  if (existante) return existante;
  await query(
    "UPDATE agencies SET plan = plan_suivant, plan_suivant = NULL WHERE id = $1 AND plan_suivant IS NOT NULL",
    [agencyId]
  );
  const agence = await lireAgence(agencyId);
  if (!agence) return null;
  const conditions = conditionsPlan({
    plan: agence.plan,
    quotaNegocie: agence.quota_negocie,
    prixNegocieFCFA: agence.prix_negocie_fcfa
  });
  const payant = conditions.abonnementFCFA > 0;
  await query(
    `INSERT INTO facturation_periodes (agency_id, periode, plan, quota, abonnement_fcfa, abonnement_statut, echeance_iso, created_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (agency_id, periode) DO NOTHING`,
    [
      agencyId, cle, conditions.plan, conditions.quota, conditions.abonnementFCFA,
      payant ? "du" : "sans_frais", payant ? calculerEcheance(now) : null, new Date(now).toISOString()
    ]
  );
  if (payant) await reglerAbonnement(agencyId, cle, now);
  return lirePeriode(agencyId, cle);
}

/** Crédite le portefeuille (recharge, remboursement) — solde et journal ensemble. */
export async function crediter({
  agencyId, montantFCFA, type = "recharge", libelle, reference = null, acteurNom = null,
  periode = null, parcelId = null, now = new Date()
}) {
  const { rows } = await query(
    `WITH credit AS (
       UPDATE agencies SET portefeuille_fcfa = portefeuille_fcfa + $2 WHERE id = $1 RETURNING portefeuille_fcfa
     )
     INSERT INTO portefeuille_mouvements (id, agency_id, type, montant_fcfa, solde_apres_fcfa, periode, parcel_id, libelle, reference, acteur_nom, created_at_iso)
     SELECT $3, $1, $4, $2, credit.portefeuille_fcfa, $5, $6, $7, $8, $9, $10 FROM credit
     RETURNING solde_apres_fcfa`,
    [agencyId, montantFCFA, crypto.randomUUID(), type, periode, parcelId, libelle, reference, acteurNom, new Date(now).toISOString()]
  );
  return rows[0]?.solde_apres_fcfa ?? null;
}

/**
 * Réserve la création d'un colis pour l'agence EXPÉDITRICE : rang atomique
 * dans le mois puis, au-delà du quota effectif, débit prépayé de 30 FCFA.
 * Refus (402) seulement si le quota est atteint ET le portefeuille
 * insuffisant. `annuler()` rend la réservation (compteur + remboursement
 * journalisé) si l'enregistrement du colis échoue ensuite.
 */
export async function reserverCreation({ agencyId, parcelId, trackingCode, acteurNom = null, now = new Date() }) {
  const ligne = await ouvrirPeriode(agencyId, now);
  const cle = ligne.periode;
  const periode = normaliserPeriode(ligne, now);
  const { rows: compte } = await query(
    "UPDATE facturation_periodes SET colis_comptes = colis_comptes + 1 WHERE agency_id = $1 AND periode = $2 RETURNING colis_comptes",
    [agencyId, cle]
  );
  const decision = decisionCreation({ rang: compte[0].colis_comptes, quota: periode.quotaEffectif });
  const rendreRang = () =>
    query(
      "UPDATE facturation_periodes SET colis_comptes = colis_comptes - 1 WHERE agency_id = $1 AND periode = $2 AND colis_comptes > 0",
      [agencyId, cle]
    );
  if (decision.type === "inclus") return { ok: true, decision, periode: cle, annuler: rendreRang };

  const { rows: debit } = await query(
    `WITH debit AS (
       UPDATE agencies SET portefeuille_fcfa = portefeuille_fcfa - $2
       WHERE id = $1 AND portefeuille_fcfa >= $2
       RETURNING portefeuille_fcfa
     )
     INSERT INTO portefeuille_mouvements (id, agency_id, type, montant_fcfa, solde_apres_fcfa, periode, parcel_id, libelle, acteur_nom, created_at_iso)
     SELECT $3, $1, 'depassement', -$2, debit.portefeuille_fcfa, $4, $5, $6, $7, $8 FROM debit
     RETURNING solde_apres_fcfa`,
    [
      agencyId, decision.montantFCFA, crypto.randomUUID(), cle, parcelId,
      `Colis hors forfait — ${trackingCode}`, acteurNom, new Date(now).toISOString()
    ]
  );
  if (!debit[0]) {
    await rendreRang();
    const agence = await lireAgence(agencyId);
    return {
      ok: false,
      status: 402,
      error: messageQuotaAtteint({
        plan: periode.plan,
        quota: periode.quotaEffectif,
        soldeFCFA: agence?.portefeuille_fcfa ?? 0,
        montantFCFA: decision.montantFCFA,
        enRetard: periode.abonnement.enRetard
      })
    };
  }
  await query(
    "UPDATE facturation_periodes SET colis_depassement = colis_depassement + 1 WHERE agency_id = $1 AND periode = $2",
    [agencyId, cle]
  );
  const annuler = async () => {
    await rendreRang();
    await query(
      "UPDATE facturation_periodes SET colis_depassement = colis_depassement - 1 WHERE agency_id = $1 AND periode = $2 AND colis_depassement > 0",
      [agencyId, cle]
    );
    await crediter({
      agencyId, montantFCFA: decision.montantFCFA, type: "ajustement",
      libelle: `Remboursement — colis ${trackingCode} non enregistré`, periode: cle, parcelId, now
    });
  };
  return { ok: true, decision: { ...decision, soldeApresFCFA: debit[0].solde_apres_fcfa }, periode: cle, annuler };
}

/**
 * Applique de nouvelles conditions à la période en cours (changement de
 * plan) : quota immédiat ; un abonnement déjà payé reste acquis, sinon il est
 * remplacé (nouveau montant, échéance à J+7).
 */
async function appliquerConditionsPeriode({ agencyId, cle, conditions, now = new Date() }) {
  await query(
    `UPDATE facturation_periodes SET
       plan = $3,
       quota = $4,
       abonnement_fcfa = CASE WHEN abonnement_statut = 'paye' THEN abonnement_fcfa ELSE $5 END,
       echeance_iso = CASE WHEN abonnement_statut = 'paye' THEN echeance_iso WHEN $5 > 0 THEN $6 ELSE NULL END,
       abonnement_statut = CASE WHEN abonnement_statut = 'paye' THEN 'paye' WHEN $5 > 0 THEN 'du' ELSE 'sans_frais' END
     WHERE agency_id = $1 AND periode = $2`,
    [agencyId, cle, conditions.plan, conditions.quota, conditions.abonnementFCFA, calculerEcheance(now)]
  );
}

/**
 * Changement de plan demandé par le gérant (Gratuit ↔ Pro). Montée en Pro :
 * immédiate, abonnement prélevé si possible. Retour au Gratuit : programmé au
 * début du mois suivant. Renvoie { effet } ou { error }.
 */
export async function changerPlanGerant({ agencyId, planDemande, now = new Date() }) {
  const ligne = await ouvrirPeriode(agencyId, now);
  const agence = await lireAgence(agencyId);
  const controle = validerChangementPlan({ planActuel: agence.plan, planSuivant: agence.plan_suivant, planDemande });
  if (controle.error) return { error: controle.error };
  const { plan, effet } = controle.valeur;
  if (effet === "annulation") {
    await query("UPDATE agencies SET plan_suivant = NULL WHERE id = $1", [agencyId]);
  } else if (effet === "periode_suivante") {
    await query("UPDATE agencies SET plan_suivant = $2 WHERE id = $1", [agencyId, plan]);
  } else {
    await query(
      "UPDATE agencies SET plan = $2, plan_suivant = NULL, quota_negocie = NULL, prix_negocie_fcfa = NULL WHERE id = $1",
      [agencyId, plan]
    );
    await appliquerConditionsPeriode({ agencyId, cle: ligne.periode, conditions: conditionsPlan({ plan }), now });
    await reglerAbonnement(agencyId, ligne.periode, now);
  }
  return { effet };
}

/** Plan fixé par la console plateforme (tous plans, Réseau négocié) : effet immédiat. */
export async function changerPlanPlateforme({ agencyId, valeur, now = new Date() }) {
  const ligne = await ouvrirPeriode(agencyId, now);
  await query(
    "UPDATE agencies SET plan = $2, plan_suivant = NULL, quota_negocie = $3, prix_negocie_fcfa = $4 WHERE id = $1",
    [agencyId, valeur.plan, valeur.quotaNegocie, valeur.prixNegocieFCFA]
  );
  await appliquerConditionsPeriode({
    agencyId,
    cle: ligne.periode,
    conditions: conditionsPlan({ plan: valeur.plan, quotaNegocie: valeur.quotaNegocie, prixNegocieFCFA: valeur.prixNegocieFCFA }),
    now
  });
  await reglerAbonnement(agencyId, ligne.periode, now);
}

/**
 * Recharge du portefeuille (console plateforme aujourd'hui, paiement en ligne
 * au LOT 7) ; l'abonnement dû du mois est réglé automatiquement dès que le
 * solde le permet.
 */
export async function rechargerPortefeuille({ agencyId, montantFCFA, reference, acteurNom, now = new Date() }) {
  const ligne = await ouvrirPeriode(agencyId, now);
  await crediter({
    agencyId, montantFCFA, type: "recharge", libelle: "Recharge du portefeuille", reference, acteurNom, now
  });
  const abonnementRegle = await reglerAbonnement(agencyId, ligne.periode, now);
  // Solde final, après l'éventuel règlement automatique de l'abonnement.
  const agence = await lireAgence(agencyId);
  return { soldeFCFA: Number(agence?.portefeuille_fcfa ?? 0), abonnementRegle };
}

/** État complet de la facturation d'une agence (page Abonnement, console). */
export async function etatFacturation(agencyId, now = new Date()) {
  const ligne = await ouvrirPeriode(agencyId, now);
  const agence = await lireAgence(agencyId);
  const { rows: mouvements } = await query(
    "SELECT * FROM portefeuille_mouvements WHERE agency_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
    [agencyId]
  );
  const { rows: periodes } = await query(
    "SELECT * FROM facturation_periodes WHERE agency_id = $1 ORDER BY periode DESC LIMIT 12",
    [agencyId]
  );
  const periode = normaliserPeriode(ligne, now);
  const soldeFCFA = Number(agence.portefeuille_fcfa ?? 0);
  return {
    plan: agence.plan,
    planSuivant: agence.plan_suivant ?? null,
    quotaNegocie: agence.quota_negocie ?? null,
    prixNegocieFCFA: agence.prix_negocie_fcfa ?? null,
    periode,
    resume: resumeFacturation({ periode, soldeFCFA }),
    echeances: echeancesFacturation({
      periode,
      plan: agence.plan,
      planSuivant: agence.plan_suivant,
      quotaNegocie: agence.quota_negocie,
      prixNegocieFCFA: agence.prix_negocie_fcfa
    }),
    portefeuille: { soldeFCFA, mouvements: mouvements.map(normaliserMouvement) },
    periodes: periodes.map((row) => normaliserPeriode(row, now))
  };
}
