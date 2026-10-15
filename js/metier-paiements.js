/*
 * Paiements en ligne (LOT 7) — règles partagées client/serveur.
 *
 * Trois objets payables par le paiement hébergé SasPay :
 * - `colis` : le reste à payer d'un colis → caisse du jour de l'agence qui
 *   encaisse (mode mobile money, libellé « Paiement SasPay ») ;
 * - `abonnement` : l'abonnement dû du mois → portefeuille crédité puis
 *   abonnement réglé ;
 * - `recharge` : recharge du portefeuille prépayé.
 *
 * Un paiement n'est appliqué qu'après vérification côté serveur auprès du
 * prestataire (statut de la session, puis transaction « SUCCESS » au bon
 * montant et en XOF) — jamais sur la seule foi du retour navigateur.
 */

export const DEVISE = "XOF";
export const PAYS = "CI";
export const MIN_RECHARGE_EN_LIGNE_FCFA = 100;
export const MAX_PAIEMENT_EN_LIGNE_FCFA = 1_000_000;
export const OBJETS_PAIEMENT = Object.freeze(["colis", "abonnement", "recharge"]);
export const STATUTS_PAIEMENT = Object.freeze(["en_attente", "paye", "echec", "expire", "annule"]);

const LIBELLES_OBJET = { colis: "Reste à payer d'un colis", abonnement: "Abonnement du mois", recharge: "Recharge du portefeuille" };
const LIBELLES_STATUT = { en_attente: "En attente", paye: "Payé", echec: "Échoué", expire: "Expiré", annule: "Annulé" };
const LIBELLES_MODE = { simulation: "Simulation", test: "Test", live: "Réel", desactive: "Désactivé" };

export function libelleObjetPaiement(objet) {
  return LIBELLES_OBJET[objet] ?? "Paiement";
}

export function libelleStatutPaiement(statut) {
  return LIBELLES_STATUT[statut] ?? "—";
}

export function libelleModePaiement(mode) {
  return LIBELLES_MODE[mode] ?? "—";
}

/** Montant FCFA entier → chaîne décimale attendue par SasPay (« 3500.00 »), jamais de flottant. */
export function montantDecimal(fcfa) {
  const entier = Math.round(Number(fcfa));
  if (!Number.isSafeInteger(entier) || entier < 0) return null;
  return `${entier}.00`;
}

/** Chaîne décimale SasPay → FCFA entier (null si illisible ou fractionnaire). */
export function fcfaDepuisDecimal(valeur) {
  const texte = String(valeur ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(texte)) return null;
  const [entier, decimales = ""] = texte.split(".");
  if (Number(decimales || "0") !== 0) return null;
  return Number(entier);
}

/** Libellé suffixé du mode (traçabilité en caisse et au portefeuille). */
export function libelleAvecMode(libelle, mode) {
  return mode === "live" ? libelle : `${libelle} (${mode === "test" ? "test" : "simulation"})`;
}

/** Validation d'une demande de paiement (avant tout appel au prestataire). */
export function validerDemandePaiement(input = {}) {
  const objet = String(input.objet ?? "").trim();
  if (!OBJETS_PAIEMENT.includes(objet)) {
    return { error: "Choisissez ce qui est payé : le reste d'un colis, l'abonnement ou une recharge." };
  }
  if (objet === "colis") {
    const parcelId = String(input.parcelId ?? "").trim();
    if (!parcelId) return { error: "Indiquez le colis à régler." };
    return { valeur: { objet, parcelId } };
  }
  if (objet === "recharge") {
    const montant = Number(input.montantFCFA);
    if (!Number.isInteger(montant) || montant < MIN_RECHARGE_EN_LIGNE_FCFA || montant > MAX_PAIEMENT_EN_LIGNE_FCFA) {
      return { error: `Le montant de la recharge doit être un nombre entier entre ${MIN_RECHARGE_EN_LIGNE_FCFA} et 1 000 000 FCFA.` };
    }
    return { valeur: { objet, montantFCFA: montant } };
  }
  return { valeur: { objet } };
}

/**
 * Statut local déduit de la session du prestataire (PENDING, PAID, EXPIRED,
 * CANCELLED) : « paye » n'est qu'un candidat — la transaction doit encore
 * être vérifiée (`transactionConforme`).
 */
export function statutDepuisSession(statutSession) {
  switch (String(statutSession ?? "").toUpperCase()) {
    case "PAID": return "paye";
    case "EXPIRED": return "expire";
    case "CANCELLED": return "annule";
    default: return "en_attente";
  }
}

/**
 * Transaction vérifiée conforme : statut SUCCESS, devise XOF et montant
 * demandé égal au montant attendu (aucun paiement partiel ou détourné).
 */
export function transactionConforme(verification = {}, montantAttenduFCFA) {
  if (String(verification.status ?? "").toUpperCase() !== "SUCCESS") return { ok: false, raison: "transaction non confirmée" };
  if (String(verification.currency ?? "").toUpperCase() !== DEVISE) return { ok: false, raison: "devise inattendue" };
  const demande = fcfaDepuisDecimal(verification.requested_amount ?? verification.amount);
  if (demande === null || demande !== Math.round(Number(montantAttenduFCFA))) return { ok: false, raison: "montant inattendu" };
  return { ok: true };
}
