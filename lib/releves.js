/*
 * Relevés mensuels (LOT 13) : préparation des données, génération et archive.
 * Le PDF est fabriqué par lib/pdf.js sans dépendance native. Les relevés ne
 * contiennent aucun nom/téléphone/CNI de client ni référence de paiement libre.
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import { genererRelevePDF } from "./pdf.js";
import { estClePeriode, libellePeriode, libellePlan } from "../js/metier-plans.js";

function erreurReleve(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function bornesMois(periode) {
  if (!estClePeriode(periode)) throw erreurReleve("PERIODE_INVALIDE", 400, "Choisissez un mois valide au format AAAA-MM.");
  const [annee, mois] = periode.split("-").map(Number);
  const debutISO = new Date(Date.UTC(annee, mois - 1, 1)).toISOString();
  const finISO = new Date(Date.UTC(annee, mois, 1)).toISOString();
  const periodeSuivante = `${finISO.slice(0, 4)}-${finISO.slice(5, 7)}`;
  return { debutISO, finISO, debutCle: `${periode}-01`, finCle: `${periodeSuivante}-01` };
}

function montant(value) {
  return Number(value) || 0;
}

function statutAbonnement(row) {
  if (!row || row.abonnement_statut === "sans_frais" || montant(row.abonnement_fcfa) === 0) return "Sans abonnement";
  if (row.abonnement_statut === "paye") return "Réglé";
  return "À régler";
}

/** Construit le relevé complet d'une agence et d'un mois, sans données client. */
export async function construireReleveAgence({ agencyId, periode, now = new Date() } = {}) {
  if (!agencyId) throw erreurReleve("AGENCE_ABSENTE", 400, "L'agence du relevé est obligatoire.");
  const bornes = bornesMois(periode);
  const { rows: agences } = await query("SELECT id, name, city FROM agencies WHERE id = $1", [agencyId]);
  const agence = agences[0];
  if (!agence) throw erreurReleve("AGENCE_INTROUVABLE", 404, "Cette agence est introuvable.");

  const { rows: colisRows } = await query(
    `SELECT tracking_code, origin_city, destination_city, status, price_fcfa, created_at_iso
     FROM parcels
     WHERE owner_id = $1 AND created_at_iso >= $2 AND created_at_iso < $3
     ORDER BY created_at_iso, tracking_code`,
    [agencyId, bornes.debutISO, bornes.finISO]
  );
  const { rows: encaissementRows } = await query(
    `SELECT e.amount_fcfa, e.mode, e.label, e.date_key, e.created_at_iso, p.tracking_code
     FROM encaissements e JOIN parcels p ON p.id = e.parcel_id
     WHERE e.agency_id = $1 AND e.date_key >= $2 AND e.date_key < $3
     ORDER BY e.date_key, e.created_at_iso, e.id`,
    [agencyId, bornes.debutCle, bornes.finCle]
  );
  const { rows: mouvementsRows } = await query(
    `SELECT type, montant_fcfa, solde_apres_fcfa, libelle, created_at_iso
     FROM portefeuille_mouvements
     WHERE agency_id = $1 AND created_at_iso >= $2 AND created_at_iso < $3
     ORDER BY created_at_iso, id`,
    [agencyId, bornes.debutISO, bornes.finISO]
  );
  const { rows: periodeRows } = await query(
    `SELECT plan, abonnement_fcfa, abonnement_statut, colis_depassement
     FROM facturation_periodes WHERE agency_id = $1 AND periode = $2`,
    [agencyId, periode]
  );
  const facturation = periodeRows[0] || null;
  const mouvements = mouvementsRows.map((row) => ({
    type: row.type,
    libelle: row.libelle || row.type || "Mouvement",
    montantFCFA: montant(row.montant_fcfa),
    soldeApresFCFA: montant(row.solde_apres_fcfa),
    dateISO: row.created_at_iso
  }));
  const horsForfaitMouvements = mouvements.filter((item) => item.type === "depassement");
  const encaissements = encaissementRows.map((row) => ({
    code: row.tracking_code,
    dateISO: row.created_at_iso || `${row.date_key}T00:00:00.000Z`,
    libelle: row.label || "Encaissement de colis",
    mode: row.mode,
    montantFCFA: montant(row.amount_fcfa)
  }));
  const colis = colisRows.map((row) => ({
    code: row.tracking_code,
    origine: row.origin_city,
    destination: row.destination_city,
    statut: row.status,
    dateISO: row.created_at_iso,
    prixFCFA: montant(row.price_fcfa)
  }));
  const releve = {
    periode,
    periodeLibelle: libellePeriode(periode),
    genereLeISO: new Date(now).toISOString(),
    agence: { nom: agence.name, ville: agence.city },
    resume: {
      colis: colis.length,
      valeurColisFCFA: colis.reduce((total, row) => total + row.prixFCFA, 0),
      encaissementsFCFA: encaissements.reduce((total, row) => total + row.montantFCFA, 0),
      horsForfait: facturation ? montant(facturation.colis_depassement) : horsForfaitMouvements.length,
      horsForfaitFCFA: horsForfaitMouvements.reduce((total, row) => total + Math.abs(row.montantFCFA), 0),
      abonnementFCFA: montant(facturation?.abonnement_fcfa),
      abonnementLibelle: facturation
        ? `${libellePlan(facturation.plan)} — ${statutAbonnement(facturation)}`
        : "Aucune période de facturation",
      mouvements: mouvements.length
    },
    colis,
    encaissements,
    mouvements
  };
  return { releve, pdf: genererRelevePDF(releve) };
}

/** Retourne l'archive si elle existe, sinon génère le PDF à la demande. */
export async function obtenirRelevePDF({ agencyId, periode, now = new Date() } = {}) {
  if (!agencyId) throw erreurReleve("AGENCE_ABSENTE", 400, "L'agence du relevé est obligatoire.");
  bornesMois(periode);
  const { rows } = await query(
    "SELECT pdf FROM releves_mensuels WHERE agency_id = $1 AND periode = $2",
    [agencyId, periode]
  );
  if (rows.length) return { pdf: Buffer.from(rows[0].pdf), archive: true };
  const resultat = await construireReleveAgence({ agencyId, periode, now });
  return { pdf: resultat.pdf, archive: false };
}

/** Archive idempotemment un PDF par agence pour le mois indiqué. */
export async function archiverRelevesMensuels({ periode, now = new Date() } = {}) {
  bornesMois(periode);
  const { rows: agences } = await query("SELECT id FROM agencies ORDER BY id");
  const resultat = { periode, agences: agences.length, archivesCreees: 0, dejaPresentes: 0, echecs: 0 };
  for (const agence of agences) {
    try {
      const { rows: existantes } = await query(
        "SELECT id FROM releves_mensuels WHERE agency_id = $1 AND periode = $2",
        [agence.id, periode]
      );
      if (existantes.length) {
        resultat.dejaPresentes += 1;
        continue;
      }
      const { pdf } = await construireReleveAgence({ agencyId: agence.id, periode, now });
      const { rows } = await query(
        `INSERT INTO releves_mensuels (id, agency_id, periode, pdf, taille_octets, created_at_iso)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (agency_id, periode) DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), agence.id, periode, pdf, pdf.length, new Date(now).toISOString()]
      );
      if (rows.length) resultat.archivesCreees += 1;
      else resultat.dejaPresentes += 1;
    } catch (error) {
      resultat.echecs += 1;
      const code = String(error?.code || error?.name || "erreur");
      const safe = /^(?:E[A-Z0-9_]{1,20}|[A-Za-z]+)$/.test(code) ? code : "erreur";
      console.error(`[releves] archivage partiel (${safe})`);
    }
  }
  return resultat;
}
