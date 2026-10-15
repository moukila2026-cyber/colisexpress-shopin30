/*
 * Plans, quotas, portefeuille et échéances (LOT 6) — règles partagées
 * client/serveur (aucune dépendance : importable par le navigateur et Node).
 *
 * - Gratuit : 50 colis par mois inclus ; au-delà, 30 FCFA par colis,
 *   PRÉPAYÉS sur le portefeuille de l'agence.
 * - Pro : 10 000 FCFA par mois, 500 colis inclus ; au-delà, même règle
 *   (30 FCFA par colis prépayés).
 * - Réseau : sur devis — quota et montant mensuel négociés, fixés par la
 *   console plateforme (quota vide = illimité).
 *
 * Invariants (appliqués côté serveur, lib/facturation.js + lib/app.js) :
 * - seule l'agence EXPÉDITRICE (celle qui enregistre le colis) est comptée :
 *   l'agence de destination ne paie jamais ;
 * - seule la CRÉATION d'un nouveau colis peut être refusée (quota atteint et
 *   portefeuille insuffisant) : un solde impayé ne bloque JAMAIS un colis en
 *   cours — lecture, progression, réception, contrôle, retour restent garantis.
 */

export const PRIX_DEPASSEMENT_FCFA = 30;
/** Délai de paiement d'un abonnement, à compter de l'ouverture du mois (ou de la souscription). */
export const DELAI_ECHEANCE_JOURS = 7;
export const MAX_RECHARGE_FCFA = 1_000_000;
export const MAX_QUOTA_RESEAU = 1_000_000;
export const MAX_PRIX_RESEAU_FCFA = 10_000_000;

export const PLANS = Object.freeze({
  gratuit: Object.freeze({
    id: "gratuit",
    label: "Gratuit",
    prixMensuelFCFA: 0,
    quotaMensuel: 50,
    depassementFCFA: PRIX_DEPASSEMENT_FCFA,
    surDevis: false,
    description: "50 colis par mois inclus, puis 30 FCFA par colis, prépayés sur le portefeuille."
  }),
  pro: Object.freeze({
    id: "pro",
    label: "Pro",
    prixMensuelFCFA: 10_000,
    quotaMensuel: 500,
    depassementFCFA: PRIX_DEPASSEMENT_FCFA,
    surDevis: false,
    description: "10 000 FCFA par mois, 500 colis inclus, puis 30 FCFA par colis prépayés."
  }),
  reseau: Object.freeze({
    id: "reseau",
    label: "Réseau",
    prixMensuelFCFA: null,
    quotaMensuel: null,
    depassementFCFA: PRIX_DEPASSEMENT_FCFA,
    surDevis: true,
    description: "Sur devis : volume et prix mensuel négociés avec Shopin30 pour les réseaux d'agences."
  })
});

export const IDS_PLANS = Object.freeze(Object.keys(PLANS));

export const TYPES_MOUVEMENT = Object.freeze({
  recharge: "Recharge",
  depassement: "Colis hors forfait",
  abonnement: "Abonnement",
  ajustement: "Ajustement"
});

const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"
];

function texte(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function estPlan(id) {
  return typeof id === "string" && Object.hasOwn(PLANS, id);
}

export function libellePlan(id) {
  return PLANS[id]?.label ?? "Plan inconnu";
}

export function libelleMouvement(type) {
  return TYPES_MOUVEMENT[type] ?? "Mouvement";
}

export function formatNombre(value) {
  return new Intl.NumberFormat("fr-FR").format(Number(value) || 0).replace(/\u202f|\u00a0/g, " ");
}

/* --------------------------------- périodes --------------------------------- */

/**
 * Clé de la période mensuelle « AAAA-MM ». Le fuseau d'Abidjan est UTC+0 sans
 * heure d'été : les bornes UTC sont exactement celles du mois ivoirien.
 */
export function clePeriode(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function estClePeriode(cle) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(cle ?? ""));
}

export function bornesPeriode(cle) {
  const [annee, mois] = String(cle).split("-").map(Number);
  return {
    debutISO: new Date(Date.UTC(annee, mois - 1, 1)).toISOString(),
    finISO: new Date(Date.UTC(annee, mois, 1)).toISOString()
  };
}

export function periodeSuivante(cle) {
  return clePeriode(bornesPeriode(cle).finISO);
}

export function libellePeriode(cle) {
  if (!estClePeriode(cle)) return "—";
  const [annee, mois] = String(cle).split("-").map(Number);
  return `${MOIS[mois - 1]} ${annee}`;
}

/** Échéance d'un abonnement ouvert (ou souscrit) à `date` : 7 jours plus tard. */
export function calculerEcheance(date = new Date()) {
  return new Date(new Date(date).getTime() + DELAI_ECHEANCE_JOURS * 86_400_000).toISOString();
}

/* ------------------------------- plans et quotas ------------------------------ */

/**
 * Conditions d'un plan pour une nouvelle période : quota inclus (null =
 * illimité) et montant de l'abonnement mensuel. Réseau : valeurs négociées.
 */
export function conditionsPlan({ plan, quotaNegocie = null, prixNegocieFCFA = null } = {}) {
  if (plan === "reseau") {
    return {
      plan: "reseau",
      quota: Number.isInteger(quotaNegocie) && quotaNegocie > 0 ? quotaNegocie : null,
      abonnementFCFA: Number.isInteger(prixNegocieFCFA) && prixNegocieFCFA > 0 ? prixNegocieFCFA : 0
    };
  }
  const definition = PLANS[plan] ?? PLANS.gratuit;
  return { plan: definition.id, quota: definition.quotaMensuel, abonnementFCFA: definition.prixMensuelFCFA };
}

/**
 * État de l'abonnement d'une période : `sans_frais` (rien à payer), `paye`,
 * ou `du` — `enRetard` quand l'échéance est dépassée.
 */
export function etatAbonnement({ montantFCFA = 0, statut = "sans_frais", echeanceISO = null, now = new Date() } = {}) {
  if (!(Number(montantFCFA) > 0) || statut === "sans_frais") return { statut: "sans_frais", enRetard: false };
  if (statut === "paye") return { statut: "paye", enRetard: false };
  const enRetard = Boolean(echeanceISO) && new Date(now).getTime() > new Date(echeanceISO).getTime();
  return { statut: "du", enRetard };
}

export function libelleStatutAbonnement({ statut, enRetard } = {}) {
  if (statut === "paye") return "Payé";
  if (statut === "du") return enRetard ? "Impayé — échéance dépassée" : "À régler";
  return "Sans frais";
}

/**
 * Quota de colis inclus réellement appliqué. Abonnement impayé après
 * l'échéance : quota ramené à celui du plan Gratuit tant qu'il n'est pas
 * réglé — seule la création de NOUVEAUX colis est concernée, jamais un colis
 * en cours. `quota` null = illimité.
 */
export function quotaEffectif({ quota = null, abonnement = null, now = new Date() } = {}) {
  const enRetard = abonnement ? etatAbonnement({ ...abonnement, now }).enRetard : false;
  if (!enRetard) return quota;
  const plafond = PLANS.gratuit.quotaMensuel;
  return quota === null ? plafond : Math.min(quota, plafond);
}

/**
 * Décision pour le `rang`-ième colis enregistré dans la période (1 = premier) :
 * inclus dans le forfait, ou dépassement à 30 FCFA prépayés.
 */
export function decisionCreation({ rang, quota, depassementFCFA = PRIX_DEPASSEMENT_FCFA }) {
  if (quota === null || quota === undefined || rang <= quota) return { type: "inclus", montantFCFA: 0 };
  return { type: "depassement", montantFCFA: depassementFCFA };
}

/** Message (français, prêt à afficher) du refus de création : quota atteint + portefeuille insuffisant. */
export function messageQuotaAtteint({ plan, quota, soldeFCFA = 0, montantFCFA = PRIX_DEPASSEMENT_FCFA, enRetard = false }) {
  const raison = enRetard
    ? `L'abonnement ${libellePlan(plan)} est impayé après son échéance : le quota est ramené à ${quota} colis ce mois-ci.`
    : `Le quota du plan ${libellePlan(plan)} est atteint (${quota} colis ce mois-ci).`;
  return `${raison} Chaque colis supplémentaire coûte ${montantFCFA} FCFA, prépayés sur le portefeuille (solde : ${formatNombre(soldeFCFA)} FCFA). Rechargez le portefeuille ou changez de plan depuis la page Abonnement. Les colis déjà enregistrés continuent d'avancer normalement.`;
}

/* ------------------------------ validations ------------------------------ */

/**
 * Changement de plan demandé par le gérant : Gratuit ↔ Pro (Réseau = sur
 * devis, fixé par la plateforme). Montée en Pro immédiate (abonnement dû tout
 * de suite, prélevé sur le portefeuille si le solde le permet) ; retour au
 * Gratuit au début du mois suivant (le mois payé reste acquis). Redemander le
 * plan actuel annule un retour programmé.
 */
export function validerChangementPlan({ planActuel, planSuivant = null, planDemande }) {
  if (!estPlan(planDemande)) return { error: "Le plan demandé est inconnu (gratuit, pro ou réseau)." };
  if (planDemande === "reseau") {
    return { error: "Le plan Réseau est sur devis : contactez Shopin30 pour le mettre en place." };
  }
  if (planActuel === "reseau") {
    return { error: "Votre plan Réseau est géré par Shopin30 : contactez-nous pour le modifier." };
  }
  if (planDemande === planActuel) {
    if (planSuivant && planSuivant !== planActuel) return { valeur: { plan: planDemande, effet: "annulation" } };
    return { error: `Votre agence est déjà au plan ${libellePlan(planDemande)}.` };
  }
  if (planSuivant === planDemande) {
    return { error: `Le passage au plan ${libellePlan(planDemande)} est déjà programmé pour le mois prochain.` };
  }
  return { valeur: { plan: planDemande, effet: planDemande === "pro" ? "immediat" : "periode_suivante" } };
}

function entierOptionnel(value) {
  if (value === null || value === undefined || texte(value) === "") return { vide: true };
  const nombre = Number(value);
  return Number.isInteger(nombre) ? { nombre } : { invalide: true };
}

/** Plan fixé par la console plateforme (Réseau : quota et prix négociés). */
export function validerPlanPlateforme({ plan, quotaMensuel, prixMensuelFCFA } = {}) {
  if (!estPlan(plan)) return { error: "Le plan demandé est inconnu (gratuit, pro ou réseau)." };
  if (plan !== "reseau") return { valeur: { plan, quotaNegocie: null, prixNegocieFCFA: null } };
  const quota = entierOptionnel(quotaMensuel);
  if (quota.invalide || (!quota.vide && (quota.nombre < 1 || quota.nombre > MAX_QUOTA_RESEAU))) {
    return { error: `Le quota négocié doit être un nombre entier de colis entre 1 et ${formatNombre(MAX_QUOTA_RESEAU)} (vide = illimité).` };
  }
  const prix = entierOptionnel(prixMensuelFCFA);
  if (prix.vide || prix.invalide || prix.nombre < 0 || prix.nombre > MAX_PRIX_RESEAU_FCFA) {
    return { error: `Indiquez le prix mensuel négocié en FCFA (nombre entier entre 0 et ${formatNombre(MAX_PRIX_RESEAU_FCFA)}).` };
  }
  return { valeur: { plan, quotaNegocie: quota.vide ? null : quota.nombre, prixNegocieFCFA: prix.nombre } };
}

/** Recharge du portefeuille (console plateforme ; paiement en ligne au LOT 7). */
export function validerRecharge({ montantFCFA, reference } = {}) {
  const montant = Number(montantFCFA);
  if (!Number.isInteger(montant) || montant < 1 || montant > MAX_RECHARGE_FCFA) {
    return { error: `Le montant de la recharge doit être un nombre entier de FCFA entre 1 et ${formatNombre(MAX_RECHARGE_FCFA)}.` };
  }
  const ref = texte(reference);
  if (ref.length < 3 || ref.length > 120) {
    return { error: "Indiquez la référence du paiement reçu (3 à 120 caractères), par exemple le numéro de transaction mobile money." };
  }
  return { valeur: { montantFCFA: montant, reference: ref } };
}

/* ------------------------------ projections ------------------------------ */

/** Ligne SQL `facturation_periodes` → période métier (camelCase) avec quota effectif. */
export function normaliserPeriode(row = {}, now = new Date()) {
  const cle = row.periode;
  const quota = row.quota ?? null;
  const abonnementBrut = {
    montantFCFA: Number(row.abonnement_fcfa ?? 0),
    statut: row.abonnement_statut ?? "sans_frais",
    echeanceISO: row.echeance_iso ?? null
  };
  const etat = etatAbonnement({ ...abonnementBrut, now });
  const quotaApplique = quotaEffectif({ quota, abonnement: abonnementBrut, now });
  const compteur = Number(row.colis_comptes ?? 0);
  return {
    cle,
    libelle: libellePeriode(cle),
    ...bornesPeriode(cle),
    plan: row.plan,
    quota,
    quotaEffectif: quotaApplique,
    compteur,
    depassements: Number(row.colis_depassement ?? 0),
    inclusRestants: quotaApplique === null ? null : Math.max(0, quotaApplique - compteur),
    abonnement: {
      montantFCFA: abonnementBrut.montantFCFA,
      statut: etat.statut,
      enRetard: etat.enRetard,
      echeanceISO: abonnementBrut.echeanceISO,
      payeLeISO: row.paye_le_iso ?? null
    }
  };
}

/** Synthèse pour l'interface : jauge, prochain colis, colis prépayés, alerte. */
export function resumeFacturation({ periode, soldeFCFA = 0 }) {
  const quota = periode?.quotaEffectif ?? null;
  const compteur = periode?.compteur ?? 0;
  const prochainColis = decisionCreation({ rang: compteur + 1, quota });
  const colisPrepayes = Math.floor(Math.max(0, soldeFCFA) / PRIX_DEPASSEMENT_FCFA);
  const pourcentage = quota === null ? 0 : Math.min(100, Math.round((compteur / Math.max(1, quota)) * 100));
  let alerte = null;
  if (periode?.abonnement?.enRetard) {
    alerte = "Abonnement impayé après échéance : le quota est ramené à celui du plan Gratuit jusqu'au règlement.";
  } else if (prochainColis.type === "depassement" && soldeFCFA < prochainColis.montantFCFA) {
    alerte = "Quota atteint et portefeuille insuffisant : les nouveaux colis seront refusés jusqu'à la recharge. Les colis en cours ne sont jamais bloqués.";
  } else if (prochainColis.type === "depassement") {
    alerte = `Quota atteint : chaque nouveau colis est prélevé de ${PRIX_DEPASSEMENT_FCFA} FCFA sur le portefeuille (${colisPrepayes} colis prépayés).`;
  } else if (quota !== null && quota - compteur <= Math.max(5, Math.ceil(quota * 0.1))) {
    alerte = `Plus que ${quota - compteur} colis inclus ce mois-ci.`;
  }
  return { prochainColis, colisPrepayes, pourcentage, alerte };
}

/**
 * Échéances à afficher : abonnement du mois en cours s'il reste dû, puis
 * prochain abonnement (mois suivant) selon le plan — ou le plan programmé.
 */
export function echeancesFacturation({ periode, plan, planSuivant = null, quotaNegocie = null, prixNegocieFCFA = null }) {
  const echeances = [];
  if (periode?.abonnement?.statut === "du") {
    echeances.push({
      libelle: `Abonnement ${libellePlan(periode.plan)} — ${periode.libelle}`,
      montantFCFA: periode.abonnement.montantFCFA,
      echeanceISO: periode.abonnement.echeanceISO,
      statut: periode.abonnement.enRetard ? "en_retard" : "a_regler"
    });
  }
  if (periode?.cle) {
    const suivante = periodeSuivante(periode.cle);
    const conditions = conditionsPlan({ plan: planSuivant || plan, quotaNegocie, prixNegocieFCFA });
    if (conditions.abonnementFCFA > 0) {
      echeances.push({
        libelle: `Abonnement ${libellePlan(conditions.plan)} — ${libellePeriode(suivante)}`,
        montantFCFA: conditions.abonnementFCFA,
        echeanceISO: calculerEcheance(bornesPeriode(suivante).debutISO),
        statut: "a_venir"
      });
    }
  }
  return echeances;
}

export function libelleStatutEcheance(statut) {
  return { en_retard: "Échéance dépassée", a_regler: "À régler", a_venir: "À venir" }[statut] ?? "—";
}
