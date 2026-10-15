/*
 * Paiements en ligne (LOT 7) — abstraction du prestataire SasPay (paiement
 * hébergé) et application des paiements confirmés.
 *
 * Une seule interface pour l'application :
 *   configurationPaiements(env)   → mode effectif : simulation | test | live | desactive
 *   fournisseurPaiement(mode, env) → { creerSession, statutSession, verifierTransaction }
 *   verifierSignatureWebhook(...)  → HMAC du webhook vérifié côté serveur
 *   creerPaiement / confirmerPaiement / traiterWebhook → orchestration
 *
 * Règles issues de la documentation SasPay (https://docs.saspay.me) :
 * - base https://api.saspay.me/api/v1, clé secrète en `Authorization: Bearer
 *   sk_test_…|sk_live_…`, UNIQUEMENT côté serveur (jamais renvoyée, jamais
 *   journalisée) ; montants en chaînes décimales (« 3500.00 »), devise XOF ;
 * - POST /checkout-sessions/ ne gère pas d'Idempotency-Key : un double appel
 *   crée deux sessions (sans conséquence financière) — on réutilise donc une
 *   session encore en attente pour le même objet ;
 * - un paiement n'est appliqué que si GET /checkout-sessions/{id}/status/
 *   indique PAID puis GET /payments/{id}/verify/ renvoie SUCCESS, au montant
 *   attendu et en XOF — jamais sur la foi du retour navigateur ou du contenu
 *   d'un webhook ;
 * - webhook : HMAC-SHA256 hex de « horodatage.corps_brut » avec le secret de
 *   signature, horodatage à ± 300 s, comparaison en temps constant ; le
 *   webhook ne fait que déclencher la vérification ci-dessus.
 *
 * Modes : sans clé, SIMULATION (aucun appel externe, aucune somme réelle) en
 * démo, développement et tests, ou si PAIEMENTS_SIMULATION=1 ; en production
 * sans clé ni ce drapeau, le paiement en ligne est DÉSACTIVÉ — une simulation
 * ne doit jamais créditer gratuitement une vraie caisse ou un vrai
 * portefeuille. Clé sk_test_ → bac à sable SasPay, sk_live_ → paiements réels.
 *
 * Aucune donnée personnelle de client n'est envoyée au prestataire : le
 * « client » de la session est l'agence (nom et e-mail professionnels) ; le
 * payeur saisit lui-même son numéro sur la page SasPay. Le numéro débité
 * (msisdn) reçu dans les webhooks n'est jamais conservé.
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import { etatApresEncaissement, resteAPayer } from "../js/metier-colis.js";
import { libellePeriode, libellePlan, normaliserPeriode } from "../js/metier-plans.js";
import {
  DEVISE,
  PAYS,
  libelleAvecMode,
  montantDecimal,
  statutDepuisSession,
  transactionConforme
} from "../js/metier-paiements.js";
import { ouvrirPeriode, reglerAbonnement } from "./facturation.js";

export const URL_API_SASPAY = "https://api.saspay.me/api/v1";
export const TOLERANCE_WEBHOOK_S = 300;
const DELAI_APPEL_MS = 10_000;
const REUTILISATION_SESSION_MS = 30 * 60 * 1000;
const FENETRE_RAPPROCHEMENT_JOURS = 7;

export class ErreurPaiement extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------ configuration ------------------------------ */

export function configurationPaiements(env = process.env) {
  const cle = String(env.SASPAY_SECRET_KEY ?? "").trim();
  const webhook = Boolean(String(env.SASPAY_WEBHOOK_SECRET ?? "").trim());
  if (cle) {
    if (/^sk_live_\S+$/.test(cle)) {
      return { mode: "live", actif: true, webhook, raison: "Paiements réels SasPay (clé de production configurée)." };
    }
    if (/^sk_test_\S+$/.test(cle)) {
      return { mode: "test", actif: true, webhook, raison: "Mode TEST SasPay : bac à sable, aucune somme réelle n'est prélevée." };
    }
    return {
      mode: "desactive", actif: false, webhook,
      raison: "SASPAY_SECRET_KEY est invalide (sk_test_… ou sk_live_… attendue) : paiement en ligne désactivé."
    };
  }
  if (!env.DATABASE_URL || env.PAIEMENTS_SIMULATION === "1") {
    return {
      mode: "simulation", actif: true, webhook: false,
      raison: "Mode SIMULATION : aucune clé SasPay n'est configurée — aucun appel externe, aucune somme réelle."
    };
  }
  return { mode: "desactive", actif: false, webhook, raison: "Paiement en ligne non configuré (SASPAY_SECRET_KEY absente)." };
}

/* -------------------------------- prestataires ------------------------------- */

function messageErreurSaspay(status) {
  if (status === 401 || status === 403) return "Le prestataire de paiement a refusé la configuration (clé API). Contactez Shopin30.";
  if (status === 410) return "La session de paiement a expiré : relancez le paiement.";
  if (status === 422 || status === 400) return "Le prestataire de paiement a refusé la demande.";
  if (status === 429) return "Trop de demandes de paiement : réessayez dans une minute.";
  return "Le service de paiement est momentanément indisponible. Réessayez.";
}

function fournisseurSaspay(env, fetchImpl) {
  const base = (String(env.SASPAY_API_URL ?? "").trim() || URL_API_SASPAY).replace(/\/+$/, "");
  const cle = String(env.SASPAY_SECRET_KEY ?? "").trim();
  async function appeler(methode, chemin, corps) {
    let res;
    try {
      res = await fetchImpl(`${base}${chemin}`, {
        method: methode,
        headers: {
          Authorization: `Bearer ${cle}`,
          Accept: "application/json",
          ...(corps ? { "Content-Type": "application/json" } : {})
        },
        body: corps ? JSON.stringify(corps) : undefined,
        signal: AbortSignal.timeout(DELAI_APPEL_MS)
      });
    } catch {
      throw new ErreurPaiement("Le service de paiement est injoignable. Réessayez dans un instant.");
    }
    const brut = await res.json().catch(() => ({}));
    if (!res.ok || brut?.success === false) {
      // Jamais la réponse brute dans les journaux : uniquement le code HTTP.
      console.error(`[paiements] SasPay ${methode} ${chemin.split("/")[1]} → HTTP ${res.status}`);
      throw new ErreurPaiement(messageErreurSaspay(res.status));
    }
    // Enveloppe SasPay { success, data, code } ; l'objet nu est aussi accepté.
    return brut && typeof brut === "object" && brut.data && typeof brut.data === "object" ? brut.data : brut;
  }
  return {
    nom: "saspay",
    async creerSession({ montantFCFA, description, client, retourUrl, metadata }) {
      const session = await appeler("POST", "/checkout-sessions/", {
        amount: montantDecimal(montantFCFA),
        currency: DEVISE,
        country: PAYS,
        description,
        customer_name: client.nom,
        customer_email: client.email,
        metadata,
        ...(retourUrl ? { return_url: retourUrl } : {})
      });
      if (!session?.id || !session?.checkout_url) throw new ErreurPaiement("Réponse inattendue du service de paiement.");
      return { id: String(session.id), checkoutUrl: String(session.checkout_url) };
    },
    async statutSession(id) {
      const statut = await appeler("GET", `/checkout-sessions/${encodeURIComponent(id)}/status/`);
      return {
        status: statut.status ?? null,
        transactionId: statut.transaction_id ?? null,
        transactionStatus: statut.transaction_status ?? null,
        transactionReference: statut.transaction_reference ?? null
      };
    },
    async verifierTransaction(transactionId) {
      const transaction = await appeler("GET", `/payments/${encodeURIComponent(transactionId)}/verify/`);
      return {
        status: transaction.status ?? null,
        requested_amount: transaction.requested_amount ?? null,
        net_amount: transaction.net_amount ?? null,
        currency: transaction.currency ?? null,
        reference: transaction.reference ?? null
      };
    }
  };
}

/** Prestataire simulé : la « page hébergée » est paiement-simulation.html, l'état est en base. */
function fournisseurSimulation() {
  return {
    nom: "simulation",
    async creerSession({ paiementId }) {
      return { id: `sim_${paiementId}`, checkoutUrl: `/paiement-simulation.html?id=${encodeURIComponent(paiementId)}` };
    },
    async statutSession(id) {
      const { rows } = await query("SELECT id, simulation_statut FROM paiements_en_ligne WHERE session_id = $1", [id]);
      const ligne = rows[0];
      const etat = ligne?.simulation_statut || "PENDING";
      if (!ligne || etat === "PENDING") return { status: "PENDING", transactionId: null, transactionStatus: null, transactionReference: null };
      return {
        status: etat === "PAID" ? "PAID" : "PENDING",
        transactionId: `sim-txn-${ligne.id}`,
        transactionStatus: etat === "PAID" ? "SUCCESS" : "FAILED",
        transactionReference: `SIM-${ligne.id.slice(0, 8).toUpperCase()}`
      };
    },
    async verifierTransaction(transactionId) {
      const id = String(transactionId).replace(/^sim-txn-/, "");
      const { rows } = await query("SELECT montant_fcfa, simulation_statut FROM paiements_en_ligne WHERE id = $1", [id]);
      const ligne = rows[0];
      return {
        status: ligne?.simulation_statut === "PAID" ? "SUCCESS" : "FAILED",
        requested_amount: montantDecimal(ligne?.montant_fcfa ?? 0),
        net_amount: montantDecimal(ligne?.montant_fcfa ?? 0),
        currency: DEVISE,
        reference: `SIM-${id.slice(0, 8).toUpperCase()}`
      };
    }
  };
}

/** Prestataire d'un mode donné (null si le paiement en ligne est désactivé). */
export function fournisseurPaiement(mode, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (mode === "simulation") return fournisseurSimulation();
  if (mode === "test" || mode === "live") return fournisseurSaspay(env, fetchImpl);
  return null;
}

/* ------------------------------ webhook signé ------------------------------- */

export function signerWebhook({ corpsBrut, horodatage, secret }) {
  return crypto.createHmac("sha256", secret).update(`${horodatage}.${corpsBrut}`).digest("hex");
}

/**
 * Vérification d'un webhook SasPay : horodatage à ± 300 s (anti-rejeu) puis
 * HMAC-SHA256 du corps BRUT, comparé en temps constant.
 */
export function verifierSignatureWebhook({ corpsBrut, signature, horodatage, secret, maintenant = Date.now() }) {
  if (!secret) return { ok: false, raison: "secret de signature non configuré" };
  if (typeof corpsBrut !== "string" || !signature || !horodatage) return { ok: false, raison: "en-têtes de signature manquants" };
  if (!/^\d{1,12}$/.test(String(horodatage))) return { ok: false, raison: "horodatage invalide" };
  if (Math.abs(Math.floor(maintenant / 1000) - Number(horodatage)) > TOLERANCE_WEBHOOK_S) {
    return { ok: false, raison: "horodatage hors tolérance" };
  }
  const attendu = Buffer.from(signerWebhook({ corpsBrut, horodatage, secret }));
  const recu = Buffer.from(String(signature).trim().toLowerCase());
  if (recu.length !== attendu.length || !crypto.timingSafeEqual(recu, attendu)) return { ok: false, raison: "signature invalide" };
  return { ok: true };
}

/* -------------------------------- projections -------------------------------- */

export function projectionPaiement(row = {}) {
  return {
    id: row.id,
    objet: row.objet,
    libelle: row.libelle,
    montantFCFA: Number(row.montant_fcfa ?? 0),
    mode: row.mode,
    statut: row.statut,
    parcelId: row.parcel_id ?? null,
    periode: row.periode ?? null,
    checkoutUrl: row.statut === "en_attente" || row.statut === "echec" ? row.checkout_url ?? null : null,
    retour: row.retour_chemin ?? null,
    transactionReference: row.transaction_reference ?? null,
    acteurNom: row.acteur_nom ?? "",
    createdAtISO: row.created_at_iso,
    confirmeLeISO: row.confirme_le_iso ?? null
  };
}

function jourCle(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Abidjan", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/* --------------------------------- création ---------------------------------- */

/**
 * Crée un paiement hébergé pour l'agence. `contexte` : { agency, member,
 * parcel (objet colis), baseUrl }. Renvoie la ligne enregistrée (avec l'URL
 * de paiement) ; lève ErreurPaiement (status HTTP) en cas de refus.
 */
export async function creerPaiement({ demande, agency, member, parcel = null, baseUrl = "", fetchImpl } = {}) {
  const configuration = configurationPaiements();
  if (!configuration.actif) throw new ErreurPaiement(configuration.raison, 503);

  let montantFCFA;
  let libelle;
  let retourChemin;
  let periode = null;
  if (demande.objet === "colis") {
    const reste = resteAPayer({ priceFCFA: parcel.priceFCFA, paidAmountFCFA: parcel.paidAmountFCFA ?? 0 });
    if (reste <= 0) throw new ErreurPaiement("Ce colis est déjà entièrement réglé.", 400);
    montantFCFA = reste;
    libelle = `Reste à payer — ${parcel.trackingCode}`;
    retourChemin = `/colis.html?id=${encodeURIComponent(parcel.id)}`;
  } else if (demande.objet === "abonnement") {
    const ligne = await ouvrirPeriode(agency.id);
    const etat = normaliserPeriode(ligne);
    if (etat.abonnement.statut !== "du") throw new ErreurPaiement("Aucun abonnement n'est à régler pour ce mois-ci.", 400);
    montantFCFA = etat.abonnement.montantFCFA;
    periode = ligne.periode;
    libelle = `Abonnement ${libellePlan(etat.plan)} — ${libellePeriode(ligne.periode)}`;
    retourChemin = "/abonnement.html";
  } else {
    montantFCFA = demande.montantFCFA;
    libelle = "Recharge du portefeuille";
    retourChemin = "/abonnement.html";
  }

  // Pas d'Idempotency-Key côté SasPay sur la création de session : un
  // double-clic réutilise la session encore en attente pour le même objet.
  const { rows: existants } = await query(
    `SELECT * FROM paiements_en_ligne
     WHERE agency_id = $1 AND objet = $2 AND statut = 'en_attente' AND mode = $3 AND montant_fcfa = $4
       AND COALESCE(parcel_id, '') = $5 AND checkout_url IS NOT NULL AND created_at > now() - interval '30 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [agency.id, demande.objet, configuration.mode, montantFCFA, parcel?.id ?? ""]
  );
  if (existants[0] && Date.now() - new Date(existants[0].created_at).getTime() < REUTILISATION_SESSION_MS) return existants[0];

  const id = crypto.randomUUID();
  const nowISO = new Date().toISOString();
  const chemin = `${retourChemin}${retourChemin.includes("?") ? "&" : "?"}paiement=${encodeURIComponent(id)}`;
  await query(
    `INSERT INTO paiements_en_ligne (id, agency_id, objet, parcel_id, periode, montant_fcfa, libelle, mode, retour_chemin,
       acteur_id, acteur_nom, created_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, agency.id, demande.objet, parcel?.id ?? null, periode, montantFCFA, libelle, configuration.mode, chemin, member.id, member.name, nowISO]
  );
  const fournisseur = fournisseurPaiement(configuration.mode, { fetchImpl });
  let session;
  try {
    session = await fournisseur.creerSession({
      paiementId: id,
      montantFCFA,
      description: libelle,
      client: { nom: agency.name, email: agency.email },
      retourUrl: baseUrl ? `${baseUrl}${chemin}` : "",
      metadata: { paiement_id: id, objet: demande.objet }
    });
  } catch (error) {
    await query("UPDATE paiements_en_ligne SET statut = 'annule', updated_at = now() WHERE id = $1", [id]);
    throw error instanceof ErreurPaiement ? error : new ErreurPaiement("Le service de paiement est momentanément indisponible. Réessayez.");
  }
  const { rows } = await query(
    "UPDATE paiements_en_ligne SET session_id = $2, checkout_url = $3, updated_at = now() WHERE id = $1 RETURNING *",
    [id, session.id, session.checkoutUrl]
  );
  return rows[0];
}

/* ------------------------- application d'un paiement ------------------------- */

/**
 * Effet métier d'un paiement confirmé, appliqué UNE seule fois : le drapeau
 * `effet_applique` bascule dans la même instruction SQL que l'écriture en
 * caisse (et la mise à jour du colis) ou que le crédit du portefeuille.
 */
async function appliquerEffet(row) {
  const nowISO = new Date().toISOString();
  if (row.objet === "colis") {
    await query(
      `WITH marque AS (
         UPDATE paiements_en_ligne SET effet_applique = TRUE, updated_at = now()
         WHERE id = $1 AND statut = 'paye' AND effet_applique = FALSE RETURNING id
       ), encaissement AS (
         INSERT INTO encaissements (id, parcel_id, agency_id, agent_id, agent_name, amount_fcfa, mode, date_key, label, created_at_iso)
         SELECT $2, $3, $4, $5, $6, $7::int, 'mobile_money', $8, $9, $10 FROM marque
         RETURNING amount_fcfa
       )
       UPDATE parcels SET
         paid_amount_fcfa = COALESCE(paid_amount_fcfa, 0) + (SELECT amount_fcfa FROM encaissement),
         payment_status = CASE WHEN COALESCE(paid_amount_fcfa, 0) + (SELECT amount_fcfa FROM encaissement) >= price_fcfa
                               THEN 'regle' ELSE 'partiel' END,
         updated_at = now()
       WHERE id = $3 AND EXISTS (SELECT 1 FROM encaissement)`,
      [
        row.id, crypto.randomUUID(), row.parcel_id, row.agency_id, row.acteur_id, row.acteur_nom,
        row.montant_fcfa, jourCle(), libelleAvecMode("Paiement SasPay", row.mode), nowISO
      ]
    );
    return;
  }
  const { rows } = await query(
    `WITH marque AS (
       UPDATE paiements_en_ligne SET effet_applique = TRUE, updated_at = now()
       WHERE id = $1 AND statut = 'paye' AND effet_applique = FALSE RETURNING id
     ), credit AS (
       UPDATE agencies SET portefeuille_fcfa = portefeuille_fcfa + $3
       WHERE id = $2 AND EXISTS (SELECT 1 FROM marque) RETURNING portefeuille_fcfa
     )
     INSERT INTO portefeuille_mouvements (id, agency_id, type, montant_fcfa, solde_apres_fcfa, periode, libelle, reference, acteur_nom, created_at_iso)
     SELECT $4, $2, 'recharge', $3, credit.portefeuille_fcfa, $5, $6, $7, 'SasPay', $8 FROM credit
     RETURNING solde_apres_fcfa`,
    [
      row.id, row.agency_id, row.montant_fcfa, crypto.randomUUID(), row.periode,
      libelleAvecMode(`Paiement SasPay — ${row.objet === "abonnement" ? row.libelle : "recharge du portefeuille"}`, row.mode),
      row.transaction_reference, nowISO
    ]
  );
  // Abonnement dû du mois : réglé dès que le solde le permet (idempotent).
  if (rows[0]) {
    const ligne = await ouvrirPeriode(row.agency_id);
    await reglerAbonnement(row.agency_id, ligne.periode);
  }
}

/**
 * Vérifie un paiement auprès du prestataire et l'applique s'il est confirmé.
 * Idempotent : peut être appelé par le retour navigateur, le webhook ou un
 * rafraîchissement, autant de fois que nécessaire.
 */
export async function confirmerPaiement(row, { fetchImpl } = {}) {
  if (!row) return null;
  if (row.statut === "paye") {
    if (!row.effet_applique) await appliquerEffet(row);
    return (await query("SELECT * FROM paiements_en_ligne WHERE id = $1", [row.id])).rows[0];
  }
  if (!["en_attente", "echec"].includes(row.statut) || !row.session_id) return row;
  const configuration = configurationPaiements();
  // Une simulation ne se confirme qu'en mode simulation ; une session SasPay
  // ne se vérifie qu'avec une clé SasPay configurée.
  if (row.mode === "simulation" ? configuration.mode !== "simulation" : !["test", "live"].includes(configuration.mode)) return row;
  const fournisseur = fournisseurPaiement(row.mode, { fetchImpl });

  const session = await fournisseur.statutSession(row.session_id);
  if (session.transactionId && session.transactionId !== row.transaction_id) {
    await query("UPDATE paiements_en_ligne SET transaction_id = $2, updated_at = now() WHERE id = $1", [row.id, session.transactionId]);
  }
  const candidat = statutDepuisSession(session.status);
  if (candidat === "expire" || candidat === "annule") {
    const { rows } = await query(
      "UPDATE paiements_en_ligne SET statut = $2, updated_at = now() WHERE id = $1 AND statut IN ('en_attente', 'echec') RETURNING *",
      [row.id, candidat]
    );
    return rows[0] ?? row;
  }
  if (candidat !== "paye" || !session.transactionId) {
    if (String(session.transactionStatus ?? "").toUpperCase() === "FAILED" && row.statut !== "echec") {
      const { rows } = await query(
        "UPDATE paiements_en_ligne SET statut = 'echec', updated_at = now() WHERE id = $1 AND statut = 'en_attente' RETURNING *",
        [row.id]
      );
      return rows[0] ?? row;
    }
    return (await query("SELECT * FROM paiements_en_ligne WHERE id = $1", [row.id])).rows[0];
  }

  const verification = await fournisseur.verifierTransaction(session.transactionId);
  const conforme = transactionConforme(verification, row.montant_fcfa);
  if (!conforme.ok) {
    console.error(`[paiements] transaction non appliquée (${conforme.raison}) pour le paiement ${row.id}`);
    return (await query("SELECT * FROM paiements_en_ligne WHERE id = $1", [row.id])).rows[0];
  }
  const { rows } = await query(
    `UPDATE paiements_en_ligne SET statut = 'paye', transaction_id = $2, transaction_reference = $3,
       confirme_le_iso = $4, updated_at = now()
     WHERE id = $1 AND statut IN ('en_attente', 'echec') RETURNING *`,
    [row.id, session.transactionId, verification.reference ?? session.transactionReference ?? null, new Date().toISOString()]
  );
  const confirme = rows[0] ?? (await query("SELECT * FROM paiements_en_ligne WHERE id = $1", [row.id])).rows[0];
  if (confirme.statut === "paye" && !confirme.effet_applique) await appliquerEffet(confirme);
  return (await query("SELECT * FROM paiements_en_ligne WHERE id = $1", [row.id])).rows[0];
}

/**
 * Webhook vérifié : il ne fait que DÉCLENCHER la vérification des paiements
 * concernés (transaction connue, sinon paiements SasPay en attente récents).
 * Rien n'est appliqué sur la seule foi de son contenu.
 */
export async function traiterWebhook({ evenement, donnees = {} }, { fetchImpl } = {}) {
  await query(
    "INSERT INTO paiements_webhooks (id, evenement, transaction_id, recu_le_iso) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), String(evenement ?? "").slice(0, 60), donnees?.id ? String(donnees.id).slice(0, 120) : null, new Date().toISOString()]
  );
  if (!String(evenement ?? "").startsWith("transaction.")) return { verifies: 0 };
  let cibles = [];
  if (donnees?.id) {
    ({ rows: cibles } = await query("SELECT * FROM paiements_en_ligne WHERE transaction_id = $1", [String(donnees.id)]));
  }
  if (!cibles.length) {
    ({ rows: cibles } = await query(
      `SELECT * FROM paiements_en_ligne
       WHERE statut IN ('en_attente', 'echec') AND mode IN ('test', 'live') AND session_id IS NOT NULL
         AND created_at > now() - make_interval(days => $1)
       ORDER BY created_at DESC LIMIT 20`,
      [FENETRE_RAPPROCHEMENT_JOURS]
    ));
  }
  let verifies = 0;
  for (const cible of cibles) {
    try {
      await confirmerPaiement(cible, { fetchImpl });
      verifies += 1;
    } catch (error) {
      console.error(`[paiements] vérification différée du paiement ${cible.id} : ${error?.status ?? "erreur"}`);
    }
  }
  return { verifies };
}
