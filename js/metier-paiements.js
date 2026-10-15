/*
 * Paiements en ligne (LOT 7, resserré au LOT 8) — règles partagées
 * client/serveur.
 *
 * Shopin30 n'encaisse JAMAIS l'argent des colis : les agences encaissent
 * elles-mêmes au guichet (espèces, mobile money). Seuls deux objets peuvent
 * donc être payés en ligne (compte marchand SasPay de Shopin30) :
 * - `abonnement` : l'abonnement dû du mois → portefeuille crédité puis
 *   abonnement réglé ;
 * - `recharge` : recharge du portefeuille prépayé.
 * L'objet `colis` (LOT 7) n'est plus accepté à la création ; il reste RECONNU
 * dans l'historique pour que les lignes déjà enregistrées restent lisibles.
 *
 * Un paiement n'est appliqué qu'après vérification côté serveur auprès du
 * prestataire (statut de la session, puis transaction « SUCCESS » au bon
 * montant et en XOF) — jamais sur la seule foi du retour navigateur.
 *
 * Frais SasPay (`fee_charge_mode`, docs.saspay.me) : `requested_amount` est
 * TOUJOURS le montant demandé à la création. En ADD_ON le client est débité
 * du montant + frais (`debited_amount`) et le marchand reçoit le montant
 * plein (`net_amount`) ; en DEDUCTED le client est débité exactement du
 * montant et les frais sont retenus sur `net_amount`. Le contrôle de
 * conformité compare donc le montant attendu à `requested_amount`, et le
 * portefeuille de l'agence est crédité du montant demandé dans les deux cas
 * (les frais sont à la charge de Shopin30 en DEDUCTED, du payeur en ADD_ON).
 */

export const DEVISE = "XOF";
export const PAYS = "CI";
export const MIN_RECHARGE_EN_LIGNE_FCFA = 100;
export const MAX_PAIEMENT_EN_LIGNE_FCFA = 1_000_000;
/** Objets reconnus dans l'historique (lignes LOT 7 comprises). */
export const OBJETS_PAIEMENT = Object.freeze(["colis", "abonnement", "recharge"]);
/** Objets qu'une agence peut encore payer en ligne (LOT 8). */
export const OBJETS_PAIEMENT_CREATION = Object.freeze(["abonnement", "recharge"]);
export const MODES_FRAIS_SASPAY = Object.freeze(["ADD_ON", "DEDUCTED"]);
export const MESSAGE_COLIS_GUICHET =
  "Le paiement en ligne d'un colis n'est pas proposé : votre agence encaisse elle-même le colis au guichet (espèces ou mobile money). Shopin30 n'encaisse en ligne que l'abonnement et les recharges du portefeuille.";
export const STATUTS_PAIEMENT = Object.freeze(["en_attente", "paye", "echec", "expire", "annule"]);

const LIBELLES_OBJET = { colis: "Reste à payer d'un colis (historique)", abonnement: "Abonnement du mois", recharge: "Recharge du portefeuille" };
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

/**
 * Validation d'une demande de paiement (avant tout appel au prestataire).
 * L'objet `colis` est refusé avec `status: 403` (règle métier, pas une
 * saisie invalide) : l'agence encaisse elle-même au guichet.
 */
export function validerDemandePaiement(input = {}) {
  const objet = String(input.objet ?? "").trim();
  if (objet === "colis") return { error: MESSAGE_COLIS_GUICHET, status: 403 };
  if (!OBJETS_PAIEMENT_CREATION.includes(objet)) {
    return { error: "Choisissez ce qui est payé : l'abonnement du mois ou une recharge du portefeuille." };
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

/** Mode de frais SasPay normalisé (null si absent ou inconnu : réglage du compte). */
export function normaliserModeFrais(valeur) {
  const mode = String(valeur ?? "").trim().toUpperCase();
  return MODES_FRAIS_SASPAY.includes(mode) ? mode : null;
}

/**
 * Montant demandé (FCFA) d'une transaction vérifiée, quel que soit le mode de
 * frais : `requested_amount` d'abord ; à défaut, le champ qui vaut le montant
 * demandé dans le mode indiqué — `net_amount` en ADD_ON (le marchand reçoit le
 * montant plein), `debited_amount` en DEDUCTED (le client paie exactement le
 * montant) ; enfin `amount` (anciennes réponses).
 */
export function montantDemandeFCFA(verification = {}) {
  const direct = fcfaDepuisDecimal(verification.requested_amount);
  if (direct !== null) return direct;
  const mode = normaliserModeFrais(verification.fee_charge_mode);
  if (mode === "ADD_ON") return fcfaDepuisDecimal(verification.net_amount);
  if (mode === "DEDUCTED") return fcfaDepuisDecimal(verification.debited_amount);
  return fcfaDepuisDecimal(verification.amount);
}

/**
 * Transaction vérifiée conforme : statut SUCCESS, devise XOF et montant
 * demandé égal au montant attendu (aucun paiement partiel ou détourné). Les
 * frais SasPay (ADD_ON : ajoutés au débit du client ; DEDUCTED : retenus sur
 * le net reversé) ne modifient jamais le montant demandé, donc jamais ce
 * contrôle ni le montant crédité à l'agence.
 */
export function transactionConforme(verification = {}, montantAttenduFCFA) {
  if (String(verification.status ?? "").toUpperCase() !== "SUCCESS") return { ok: false, raison: "transaction non confirmée" };
  if (String(verification.currency ?? "").toUpperCase() !== DEVISE) return { ok: false, raison: "devise inattendue" };
  const demande = montantDemandeFCFA(verification);
  if (demande === null || demande !== Math.round(Number(montantAttenduFCFA))) return { ok: false, raison: "montant inattendu" };
  return { ok: true };
}
