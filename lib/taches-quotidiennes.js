/*
 * Tâche quotidienne (LOT 11) : orchestration des opérations automatiques.
 * Le métier (échéances et règles de notification) reste dans js/metier-* ;
 * les écritures sont idempotentes et chaque exécution est journalisée.
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import { niveauRappelAbonnement } from "../js/metier-notifications.js";
import { clePeriode } from "../js/metier-plans.js";
import { balayerEcheances, notifier } from "./notifications.js";
import { ouvrirPeriode } from "./facturation.js";
import { archiverRelevesMensuels } from "./releves.js";

function json(value, repli) {
  if (value == null) return repli;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return repli; }
}

function colisMetier(row) {
  return {
    id: row.id,
    trackingCode: row.tracking_code,
    ownerId: row.owner_id,
    destinationAgencyId: row.destination_agency_id,
    originCity: row.origin_city,
    destinationCity: row.destination_city,
    status: row.status,
    history: json(row.history, []),
    createdAtISO: row.created_at_iso,
    updatedAtISO: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    retourStatus: row.retour_status ?? null
  };
}

function erreurCourte(error) {
  const code = String(error?.code ?? "");
  if (/^E[A-Z0-9_]{1,20}$/i.test(code)) return code;
  const nom = String(error?.name ?? "");
  return ["Error", "TypeError", "AbortError", "TimeoutError", "FetchError"].includes(nom) ? nom : "erreur";
}

/**
 * Exécute le même traitement depuis Vercel Cron ou la console (admin).
 * Aucun secret ni donnée de contact ne figure dans le résultat journalisé.
 */
export async function executerTacheQuotidienne({ declencheur = "cron", now = new Date() } = {}) {
  const horlogeDebut = Date.now();
  const dateDebut = new Date(now);
  const demarreeLeISO = dateDebut.toISOString();
  const id = crypto.randomUUID();
  const resultats = {
    agences: 0,
    moisOuverts: 0,
    colisBalayes: 0,
    notificationsEcheance: 0,
    rappelsAbonnement: 0,
    incidentsAArbitrer: 0,
    relevesArchives: 0,
    relevesDejaArchives: 0,
    relevesEnEchec: 0,
    erreurs: []
  };

  await query(
    `INSERT INTO taches_executions (id, declencheur, demarree_le_iso, statut, resultats)
     VALUES ($1, $2, $3, 'en_cours', $4)`,
    [id, declencheur, demarreeLeISO, JSON.stringify(resultats)]
  );

  let etapesReussies = 0;
  const tenter = async (etape, operation) => {
    try {
      const valeur = await operation();
      if (valeur !== null && valeur !== undefined) etapesReussies += 1;
      return valeur;
    } catch (error) {
      resultats.erreurs.push(etape);
      console.error(`[taches] ${etape} a échoué (${erreurCourte(error)})`);
      return null;
    }
  };

  let agences = [];
  const listeAgences = await tenter("liste_agences", async () => {
    const { rows } = await query("SELECT id FROM agencies ORDER BY id");
    return rows;
  });
  if (listeAgences) {
    agences = listeAgences;
    resultats.agences = agences.length;
  }

  for (const agence of agences) {
    const periode = await tenter("ouverture_mois", () => ouvrirPeriode(agence.id, dateDebut));
    if (periode) resultats.moisOuverts += 1;
  }

  const parcelles = await tenter("lecture_colis", async () => {
    const { rows } = await query("SELECT * FROM parcels ORDER BY created_at_iso, id");
    return rows;
  });
  if (parcelles) {
    resultats.colisBalayes = parcelles.length;
    const nombre = await tenter("balayage_echeances", () => balayerEcheances({
      toutesAgences: true,
      parcels: parcelles.map(colisMetier),
      now: dateDebut,
      propagerErreur: true
    }));
    resultats.notificationsEcheance = Number(nombre) || 0;
  }

  const cleCourante = clePeriode(dateDebut);
  const abonnementsDus = await tenter("lecture_abonnements", async () => {
    const { rows } = await query(
      `SELECT agency_id, periode, plan, abonnement_fcfa, echeance_iso
       FROM facturation_periodes
       WHERE periode = $1 AND abonnement_statut = 'du' AND abonnement_fcfa > 0 AND echeance_iso IS NOT NULL
       ORDER BY agency_id`,
      [cleCourante]
    );
    return rows;
  });
  if (abonnementsDus) {
    for (const abonnement of abonnementsDus) {
      const rappel = niveauRappelAbonnement({ echeanceISO: abonnement.echeance_iso, now: dateDebut });
      if (!rappel) continue;
      const envois = await tenter("rappel_abonnement", () => notifier({
        type: rappel.type,
        agencyId: abonnement.agency_id,
        agences: [abonnement.agency_id],
        periode: abonnement.periode,
        plan: abonnement.plan,
        montantFCFA: Number(abonnement.abonnement_fcfa),
        echeanceISO: abonnement.echeance_iso,
        joursRestants: rappel.joursRestants
      }));
      resultats.rappelsAbonnement += Array.isArray(envois) ? envois.length : 0;
    }
  }

  const debutFenetre = new Date(dateDebut.getTime() - 7 * 86_400_000).toISOString();
  const incidents = await tenter("escalade_plateforme", async () => {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM incidents
       WHERE state <> 'resolu' AND opened_at_iso <= $1`,
      [debutFenetre]
    );
    return Number(rows[0]?.n ?? 0);
  });
  if (incidents !== null) resultats.incidentsAArbitrer = incidents;

  // Le premier jour du mois, archive le mois clos précédent pour toutes les agences.
  if (dateDebut.getUTCDate() === 1) {
    const debutMois = new Date(Date.UTC(dateDebut.getUTCFullYear(), dateDebut.getUTCMonth(), 1));
    const periodeFermee = clePeriode(new Date(debutMois.getTime() - 86_400_000));
    const archive = await tenter("archivage_releves", () => archiverRelevesMensuels({ periode: periodeFermee, now: dateDebut }));
    if (archive) {
      resultats.relevesArchives = archive.archivesCreees;
      resultats.relevesDejaArchives = archive.dejaPresentes;
      resultats.relevesEnEchec = archive.echecs;
      if (archive.echecs > 0) resultats.erreurs.push("archivage_releves_agences");
    }
  }

  const statut = resultats.erreurs.length === 0
    ? "ok"
    : etapesReussies > 0 ? "partiel" : "erreur";
  const termineeLeISO = new Date().toISOString();
  const dureeMs = Math.max(0, Date.now() - horlogeDebut);
  await query(
    `UPDATE taches_executions
     SET terminee_le_iso = $2, duree_ms = $3, statut = $4, resultats = $5
     WHERE id = $1`,
    [id, termineeLeISO, dureeMs, statut, JSON.stringify(resultats)]
  );
  return { id, declencheur, demarreeLeISO, termineeLeISO, dureeMs, statut, resultats };
}

/** Les dix dernières exécutions, sans secret ni donnée personnelle. */
export async function listerExecutionsQuotidiennes() {
  const { rows } = await query(
    `SELECT id, declencheur, demarree_le_iso, terminee_le_iso, duree_ms, statut, resultats
     FROM taches_executions ORDER BY created_at DESC, id DESC LIMIT 10`
  );
  return rows.map((row) => ({
    id: row.id,
    declencheur: row.declencheur,
    demarreeLeISO: row.demarree_le_iso,
    termineeLeISO: row.terminee_le_iso ?? null,
    dureeMs: row.duree_ms === null ? null : Number(row.duree_ms),
    statut: row.statut,
    resultats: json(row.resultats, {})
  }));
}
